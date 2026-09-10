/**
 * `workshop-i18n extract [--check]` — spec 001 US-2 and spec 002 US-1.
 *
 * Reads the manifest, extracts every surface, and updates the PO catalogs of every target
 * locale the manifest declares (layout and update rules: `catalogs.ts`). Nothing is
 * written until the whole corpus has extracted cleanly and every existing catalog has
 * parsed, so a bad input leaves the tree exactly as it was.
 *
 * `--check` computes the same plan and writes nothing, exiting 1 when any catalog would
 * change — the CI gate for "somebody edited English and did not run extract".
 */

import {
  assertDistinctCatalogs,
  isChanged,
  type LocalePlan,
  planLocale,
  rekeyedContainers,
  undeclaredLocales,
  writePlans,
} from './catalogs.js'
import { EXIT } from './exit-codes.js'
import { count } from './report.js'
import type { Command, CommandContext } from './run.js'
import { readSources } from './sources.js'
import { type Extraction, extractCorpus } from './units.js'
import { loadWorkspace, type Workspace } from './workspace.js'

/** Everything `extract` and `status` both need: the extraction and the catalog plans. */
export interface ExtractPlan {
  readonly workspace: Workspace
  readonly extraction: Extraction
  readonly plans: readonly LocalePlan[]
  /** Complete stderr lines, each carrying a `warning:` marker. */
  readonly warnings: readonly string[]
}

/** Extract and plan every declared locale, writing nothing. */
export function planExtract(context: CommandContext): ExtractPlan {
  const workspace = loadWorkspace(context.io, context.root)
  const sources = readSources(workspace)
  const extraction = extractCorpus(workspace, sources)
  assertDistinctCatalogs(extraction)
  const plans = workspace.manifest.locales.targets.map((locale) =>
    planLocale(workspace, extraction, locale),
  )
  // Extractor warnings arrive formatted (`path:line:col: warning: …`); the rest get the
  // same `warning:` marker here so every line on stderr can be grepped the same way.
  const warnings = [
    ...sources.warnings.map((warning) => `warning: ${warning}`),
    ...extraction.warnings,
    ...undeclaredLocales(workspace).map(
      (locale) =>
        `warning: i18n/${locale}/ is for a locale the manifest does not declare; it is ignored and excluded from policy`,
    ),
  ]
  return { workspace, extraction, plans, warnings }
}

function surfaceLines(plan: ExtractPlan): readonly string[] {
  return plan.workspace.manifest.surfaces.map((spec) => {
    const files = plan.extraction.files.filter((file) => file.file.surface === spec.surface)
    const containers = files.reduce((sum, file) => sum + file.containers.length, 0)
    const units = files.reduce((sum, file) => sum + file.units.length, 0)
    return `${spec.surface}: ${count(files.length, 'file')}, ${count(containers, 'container')}, ${count(units, 'unit')}`
  })
}

function localeLine(plan: LocalePlan): string {
  const total = (key: 'added' | 'fuzzied' | 'obsoleted' | 'resurrected' | 'unchanged') =>
    plan.catalogs.reduce((sum, planned) => sum + planned.summary[key].length, 0)
  const changed = plan.catalogs.filter(isChanged)
  const removed = changed.filter((planned) => planned.text === undefined).length
  const kept = plan.catalogs.filter((planned) => planned.text !== undefined).length
  return (
    `${plan.locale}: ${total('fuzzied')} fuzzy, ${total('added')} added, ` +
    `${total('obsoleted')} obsoleted, ${total('resurrected')} resurrected, ` +
    `${total('unchanged')} unchanged; ${count(kept, 'catalog')}, ` +
    `${changed.length - removed} written, ${removed} removed`
  )
}

function execute(context: CommandContext): number {
  const { io, values } = context
  const plan = planExtract(context)
  for (const warning of plan.warnings) io.stderr(`${warning}\n`)
  for (const line of surfaceLines(plan)) io.stdout(`extract ${line}\n`)

  if (values.check === true) {
    const stale = plan.plans.flatMap((locale) => locale.catalogs.filter(isChanged))
    for (const planned of stale) io.stderr(`stale: ${planned.path}\n`)
    if (stale.length > 0) {
      io.stdout(
        `extract --check: ${count(stale.length, 'catalog')} out of date with the English source; run workshop-i18n extract\n`,
      )
      return EXIT.FAILED
    }
    io.stdout('extract --check: every catalog is current\n')
    return EXIT.OK
  }

  writePlans(plan.workspace, plan.plans)
  for (const locale of plan.plans) {
    io.stdout(`extract ${localeLine(locale)}\n`)
    const rekeyed = rekeyedContainers(locale)
    if (rekeyed.length === 0) continue
    io.stdout(
      `extract ${locale.locale}: ${count(rekeyed.length, 'container')} had units re-keyed by a structural edit (ADR 0005); their obsoleted translations must be re-established via translation memory:\n`,
    )
    for (const item of rekeyed) {
      io.stdout(
        `extract ${locale.locale}: re-keyed ${item.container} (${item.added} added, ${item.obsoleted} obsoleted)\n`,
      )
    }
  }
  return EXIT.OK
}

/** The `extract` command. */
export const extractCommand: Command = {
  name: 'extract',
  summary: 'extract units from every surface and update i18n/<locale>/ PO catalogs',
  help: '  --check        write nothing; exit 1 when any catalog is out of date',
  options: { check: { type: 'boolean' } },
  execute,
}
