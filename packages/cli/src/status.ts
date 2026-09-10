/**
 * `workshop-i18n status [--json] [--policy <name>] [--locale <tag>]` — spec 002 US-2.
 *
 * Reports per locale × section × state, where a section is an English source file (the
 * unit of one catalog — see `catalogs.ts`). The unit set comes from the English source,
 * never from the catalogs, so a locale with an absent or empty catalog reports its units
 * as `missing` instead of reporting nothing and passing (core's `statusesForLocale`).
 *
 * **It reports the catalogs `extract` would write, not the ones on disk.** Status runs the
 * same plan and reads the states out of it, so an English edit nobody has extracted yet
 * already shows as `fuzzy` rather than as the stale `reviewed` a naive read would report
 * — a release gate must not pass on catalogs that are merely out of date. When the files
 * on disk differ from that plan, a warning says so and `catalogsCurrent` is false.
 *
 * **A gating policy also requires the committed catalogs to be current** (ADR 0014). The
 * plan can be more lenient than the files a release is built from — an entry that moved
 * or was resurrected, a removed unit still live on disk — so `release` fails with a
 * `stale-catalogs` violation until `extract` has run and been committed. `preview`, which
 * gates nothing, is not affected.
 *
 * Exit codes: 0 when no policy is named or the named policy holds; 1 when it fails, with
 * every gating unit listed with its section; 64 for an unknown policy or an undeclared
 * locale. `--locale` narrows which catalogs are read at all.
 */

import { catalogStatuses } from '@workshop-i18n/catalog-po'
import {
  evaluatePolicy,
  isPolicyName,
  localeRejection,
  POLICIES,
  type PolicyEvaluation,
  type PolicyName,
  type SourceUnit,
  type StateCounts,
  type StateReport,
  statusesForLocale,
  tallyUnitStates,
  UNIT_STATES,
  type UnitStatus,
} from '@workshop-i18n/core'
import { isChanged, type LocalePlan } from './catalogs.js'
import { CliError, EXIT } from './exit-codes.js'
import { type ExtractPlan, planExtract } from './extract.js'
import { compareStrings, count } from './report.js'
import type { Command, CommandContext } from './run.js'
import type { Workspace } from './workspace.js'

/** Version of the `--json` document. Bump on any incompatible change to its shape. */
export const STATUS_SCHEMA_VERSION = 1

function unitStatuses(plan: ExtractPlan, locale: LocalePlan): readonly UnitStatus[] {
  const source: SourceUnit[] = plan.extraction.files.flatMap((file) =>
    file.units.map((unit) => ({ id: unit.id, section: file.file.path })),
  )
  const known = locale.catalogs
    .filter((planned) => planned.text !== undefined)
    .flatMap((planned) => catalogStatuses(planned.catalog))
  return statusesForLocale(source, known, locale.locale)
}

/** Counts in a fixed key order, so the JSON is byte-stable (SC-003). */
function orderedCounts(counts: StateCounts): Record<string, number> {
  return Object.fromEntries(UNIT_STATES.map((state) => [state, counts[state]]))
}

/** A policy's outcome: core's state evaluation plus the CLI's committed-catalogs gate. */
interface Verdict {
  readonly name: string
  readonly satisfied: boolean
  readonly violations: PolicyEvaluation['violations']
  /** Catalogs on disk that differ from what extract would write, when the policy gates. */
  readonly staleCatalogs: readonly string[]
}

function jsonDocument(
  plan: ExtractPlan,
  report: StateReport,
  evaluation: Verdict | undefined,
  catalogsCurrent: boolean,
): unknown {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    sourceLocale: plan.workspace.manifest.locales.source,
    catalogsCurrent,
    total: report.total,
    totals: orderedCounts(report.totals),
    locales: report.locales.map((locale) => ({
      locale: locale.locale,
      total: locale.total,
      counts: orderedCounts(locale.counts),
      sections: locale.sections.map((section) => ({
        section: section.section,
        total: section.total,
        counts: orderedCounts(section.counts),
      })),
    })),
    policy:
      evaluation === undefined
        ? null
        : {
            name: evaluation.name,
            satisfied: evaluation.satisfied,
            violations: [
              ...evaluation.violations.map((violation) => ({
                kind: violation.kind,
                locale: violation.locale,
                state: violation.state,
                limit: violation.limit,
                count: violation.count,
                units: violation.units.map((unit) => ({ id: unit.id, section: unit.section })),
              })),
              ...(evaluation.staleCatalogs.length === 0
                ? []
                : [{ kind: 'stale-catalogs', catalogs: evaluation.staleCatalogs }]),
            ],
          },
  }
}

function countsText(counts: StateCounts): string {
  return UNIT_STATES.map((state) => `${state} ${counts[state]}`).join(', ')
}

function humanReport(report: StateReport, evaluation: Verdict | undefined): string {
  const lines: string[] = []
  const headers = ['section', 'total', ...UNIT_STATES]
  for (const locale of report.locales) {
    lines.push(`${locale.locale}  ${count(locale.total, 'unit')}: ${countsText(locale.counts)}`)
    const rows = locale.sections.map((section) => [
      section.section,
      String(section.total),
      ...UNIT_STATES.map((state) => String(section.counts[state])),
    ])
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
    )
    const format = (row: readonly string[]) =>
      `  ${row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
        )
        .join('  ')}`.trimEnd()
    lines.push(format(headers), ...rows.map(format), '')
  }
  lines.push(
    `total  ${count(report.total, 'unit')} in ${count(report.locales.length, 'locale')}: ${countsText(report.totals)}`,
  )
  if (evaluation !== undefined) {
    if (evaluation.satisfied) {
      lines.push(`policy ${evaluation.name}: passed`)
    } else {
      lines.push(`policy ${evaluation.name}: FAILED`)
      for (const violation of evaluation.violations) {
        lines.push(
          `  ${violation.locale} ${violation.state}: ${violation.count} (limit ${violation.limit})`,
        )
        for (const unit of violation.units) lines.push(`    ${unit.id}  ${unit.section}`)
      }
      if (evaluation.staleCatalogs.length > 0) {
        lines.push('  catalogs out of date — run workshop-i18n extract and commit:')
        for (const path of evaluation.staleCatalogs) lines.push(`    ${path}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** The locales to report on: all declared targets, or the one `--locale` names. */
function selectLocales(requested: unknown): (workspace: Workspace) => readonly string[] {
  return (workspace) => {
    const targets = workspace.manifest.locales.targets
    if (requested === undefined) return targets
    const rejection = localeRejection(requested)
    if (rejection !== undefined) {
      throw new CliError(
        EXIT.USAGE,
        `--locale ${JSON.stringify(requested)} is not a locale tag (${rejection})`,
      )
    }
    if (!targets.includes(requested as string)) {
      throw new CliError(
        EXIT.USAGE,
        `--locale ${JSON.stringify(requested)} is not a target locale in the manifest; declared: ${targets.join(', ')}`,
      )
    }
    return [requested as string]
  }
}

/**
 * Does this policy gate anything? A policy with no ceilings (`preview`) passes whatever
 * the states are, so stale catalogs cannot make it less true.
 */
function gatesStates(policy: PolicyName): boolean {
  return Object.keys(POLICIES[policy].maxRequired).length > 0
}

function execute(context: CommandContext): number {
  const { io, values } = context
  const policyName = values.policy
  if (policyName !== undefined && !isPolicyName(policyName)) {
    throw new CliError(
      EXIT.USAGE,
      `unknown policy ${JSON.stringify(policyName)}: known policies are ${Object.keys(POLICIES).sort(compareStrings).join(', ')}`,
    )
  }
  const plan = planExtract(context, selectLocales(values.locale))

  for (const warning of plan.warnings) io.stderr(`${warning}\n`)
  const stale = plan.plans
    .flatMap((locale) => locale.catalogs.filter(isChanged))
    .map((planned) => planned.path)
    .sort(compareStrings)
  if (stale.length > 0) {
    io.stderr(
      `warning: ${count(stale.length, 'catalog')} out of date with the English source; figures show the state after the next extract — run workshop-i18n extract\n`,
    )
  }

  const statuses = plan.plans.flatMap((locale) => unitStatuses(plan, locale))
  const evaluation = policyName === undefined ? undefined : evaluatePolicy(statuses, policyName)
  const report = evaluation?.report ?? tallyUnitStates(statuses)
  // A release is built from the committed catalogs, and the plan can be more lenient than
  // them (a moved or resurrected entry, a removed unit still live on disk). So a gating
  // policy also requires the catalogs on disk to be exactly what extract would write —
  // which is also what keeps this verdict equal to `compose --strict`'s (spec 003 SC-003).
  const staleGate =
    policyName !== undefined && gatesStates(policyName) && stale.length > 0 ? stale : []
  const verdict =
    evaluation === undefined
      ? undefined
      : {
          name: evaluation.policy,
          satisfied: evaluation.satisfied && staleGate.length === 0,
          violations: evaluation.violations,
          staleCatalogs: staleGate,
        }

  if (values.json === true) {
    io.stdout(
      `${JSON.stringify(jsonDocument(plan, report, verdict, stale.length === 0), null, 2)}\n`,
    )
  } else {
    io.stdout(humanReport(report, verdict))
  }
  return verdict === undefined || verdict.satisfied ? EXIT.OK : EXIT.FAILED
}

/** The `status` command. */
export const statusCommand: Command = {
  name: 'status',
  summary: 'report translation state per locale and section; --policy gates CI',
  help: [
    '  --json             print the report as stable JSON (schemaVersion 1)',
    '  --policy <name>    exit 1 unless the policy holds: release | preview',
    '  --locale <tag>     report on one declared target locale only',
  ].join('\n'),
  options: {
    json: { type: 'boolean' },
    policy: { type: 'string' },
    locale: { type: 'string' },
  },
  execute,
}
