/**
 * `compose --locale <l>` as a pure function (spec 003 User Story 1; ADRs 0007, 0009,
 * 0012).
 *
 * Input: the manifest, one target locale, the English source files (already carrying
 * their explicit identities — `init-ids` has run) and that locale's catalogs. Output:
 * the composed locale files at the same relative paths, destined for a generated tree
 * the consumer builds with Slidev unchanged, plus a per-unit report and machine-readable
 * findings. No I/O: reading the working tree and writing the output directory are the
 * CLI's job (constitution IV).
 *
 * ## What a unit renders as
 *
 * | effective state | preview                         | strict                       |
 * | --------------- | ------------------------------- | ---------------------------- |
 * | `reviewed`      | translation (if it passes gates) | translation (gates = errors) |
 * | `needs-review`  | translation, unmarked (gated)    | error                        |
 * | `fuzzy`/stale   | marked English fallback          | error                        |
 * | `missing`       | marked English fallback          | error                        |
 *
 * "Stale" is a catalog entry whose `msgid` is not the English the source holds now —
 * the catalog has not been updated since an English edit. Its translation is of other
 * words, so it is treated exactly like `fuzzy` rather than shipped.
 *
 * Which units block a release is decided by core's `evaluatePolicy` with the `release`
 * policy, over `statusesForLocale` — the same functions `status --policy release` uses —
 * so the two commands cannot disagree about the unit set or the gate (spec 003 SC-003).
 *
 * A translation that fails a content gate (markup parity, protected terms), that the
 * extractor refuses to splice, or that changes the file's structure is never emitted:
 * preview falls back to marked English and warns; strict records an error. Strict
 * composition with any error emits **no files**, so nothing half-composed can be
 * mistaken for a release (ADR 0009, fail closed).
 *
 * Every emitted file is then re-verified by the verifier `verifyComposedFile` uses, on the
 * output located afresh from the emitted text: the skeleton gate, and the content gates on
 * what the output actually says. The plan is never taken as evidence for the output.
 *
 * ## Deferred: governed slide overrides (ADR 0008, spec 003 User Story 2)
 *
 * DEFERRED 2026-09-10 by operator-loop decision. `i18n/<locale>/overrides/<slideId>.md`
 * replacement/split slides, their `sourceSlideHash` anchoring, wholesale invalidation,
 * minted fragment ids and override-staleness violations in `--strict` are NOT
 * implemented. Nothing here reads, accepts or silently ignores an override: the input
 * type has no field for one, so a consumer cannot believe an override was applied. When
 * this lands it slots in before splicing (an override replaces a whole slide's range,
 * which ADR 0012 keeps outside the hole mechanism) and must pass `compareSkeletons`'
 * fence gate against the English slide it replaces. See the package README.
 */

import type { Catalog, CatalogEntry } from '@workshop-i18n/catalog-po'
import {
  assertSafeLocale,
  evaluatePolicy,
  formatUnitId,
  type Manifest,
  type PolicyEvaluation,
  type SourceUnit,
  SURFACES,
  type Surface,
  statusesForLocale,
  type UnitState,
  type UnitStatus,
} from '@workshop-i18n/core'
import {
  ComposeInputError,
  type ComposeMode,
  type Finding,
  type FindingCode,
  hasErrorFindings,
  quote,
  sortFindings,
} from './findings.js'
import { contentGateFailures } from './gates.js'
import { type SplicePlan, spliceWithDemotion } from './splice.js'
import { type LocatedFile, locateFile } from './surface.js'
import { extractionFindings, locateContextFor, verifyLocated } from './verify.js'

/** One English source file, decoded, with the surface the manifest assigns it. */
export interface SourceFile {
  /** Repo-relative POSIX path; the composed file keeps it, relative to the output root. */
  readonly path: string
  readonly surface: Surface
  /** The file's text, decoded with the extractor's `decodeSource` (fatal UTF-8). */
  readonly text: string
  /**
   * The section `status` reports this file's units under. Defaults to `path`; pass the
   * same value `status` uses so both commands group identically.
   */
  readonly section?: string
}

/** What {@link composeLocale} needs. */
export interface ComposeLocaleInput {
  readonly manifest: Manifest
  /** A target locale the manifest declares. */
  readonly locale: string
  readonly files: readonly SourceFile[]
  /** Every catalog of {@link ComposeLocaleInput.locale}; entries are looked up by unit id. */
  readonly catalogs: readonly Catalog[]
  /** Defaults to `preview`. */
  readonly mode?: ComposeMode
  /** Slidev frontmatter keys treated as prose; must match what `extract` used. */
  readonly frontmatterTextKeys?: readonly string[]
}

/** One generated file. */
export interface ComposedFile {
  readonly path: string
  readonly surface: Surface
  readonly text: string
}

/** How a unit was rendered in the composed output. */
export type UnitRendering = 'translation' | 'fallback'

/** One unit of the per-unit report. */
export interface UnitReport {
  /** The formatted unit id (the PO `msgctxt`). */
  readonly id: string
  readonly path: string
  readonly section: string
  /** The state the policy judged: the catalog's, with a stale entry counted as `fuzzy`. */
  readonly state: UnitState
  /** True when the catalog entry translated different English than the source holds. */
  readonly stale: boolean
  readonly rendering: UnitRendering
  /** True when a fallback carries the visible marker. */
  readonly marked: boolean
  /** Why the unit is not rendering its translation, when it has one it could not use. */
  readonly reasons: readonly FindingCode[]
}

/** The result of composing one locale. */
export interface ComposeLocaleResult {
  readonly locale: string
  readonly mode: ComposeMode
  /**
   * The composed files, sorted by path. **Empty in strict mode whenever there is any
   * error**: a failed release composition claims no output at all.
   */
  readonly files: readonly ComposedFile[]
  /** Every unit, sorted by id. */
  readonly units: readonly UnitReport[]
  /** Sorted; errors and warnings. */
  readonly findings: readonly Finding[]
  /** Core's verdict: `release` in strict mode, `preview` otherwise. */
  readonly policy: PolicyEvaluation
  /** True only for a strict composition with no errors. */
  readonly releasable: boolean
}

/** A generated-file notice for the CLI to write beside the tree (FR-002); see README. */
export const GENERATED_NOTICE =
  'Generated by workshop-i18n compose — do not edit. Regenerate from the English sources and ' +
  'the locale catalogs; edits here are overwritten and fail `workshop-i18n verify`.\n'

function checkPath(path: string): void {
  const segments = path.split('/')
  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === '..' || segment === '.' || segment === '') ||
    [...path].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  ) {
    throw new ComposeInputError(
      `source path ${quote(path)} must be a relative POSIX path inside the repository — it becomes a path in the generated tree`,
    )
  }
}

function validate(input: ComposeLocaleInput): void {
  assertSafeLocale(input.locale)
  if (!input.manifest.locales.targets.includes(input.locale)) {
    throw new ComposeInputError(
      `locale ${quote(input.locale)} is not a target in the manifest (targets: ${input.manifest.locales.targets.join(', ')})`,
    )
  }
  if (input.mode !== undefined && input.mode !== 'preview' && input.mode !== 'strict') {
    throw new ComposeInputError(
      `mode must be "preview" or "strict", got ${quote(String(input.mode))}`,
    )
  }
  const paths = new Set<string>()
  for (const file of input.files) {
    checkPath(file.path)
    if (!(SURFACES as readonly string[]).includes(file.surface)) {
      throw new ComposeInputError(
        `file ${quote(file.path)} has unknown surface ${quote(String(file.surface))}`,
      )
    }
    if (paths.has(file.path))
      throw new ComposeInputError(`file ${quote(file.path)} is listed twice`)
    paths.add(file.path)
  }
  for (const catalog of input.catalogs) {
    if (catalog.identity.locale !== input.locale) {
      throw new ComposeInputError(
        `catalog ${quote(catalog.identity.name)} is for locale ${quote(catalog.identity.locale)}, not ${quote(input.locale)}`,
      )
    }
  }
}

function entriesById(
  catalogs: readonly Catalog[],
): Map<string, { entry: CatalogEntry; catalog: string }> {
  const entries = new Map<string, { entry: CatalogEntry; catalog: string }>()
  for (const catalog of catalogs) {
    for (const entry of catalog.entries) {
      const id = formatUnitId(entry.id)
      const previous = entries.get(id)
      if (previous !== undefined) {
        throw new ComposeInputError(
          `unit ${id} has entries in two catalogs, ${quote(previous.catalog)} and ${quote(catalog.identity.name)}; a unit lives in exactly one`,
        )
      }
      entries.set(id, { entry, catalog: catalog.identity.name })
    }
  }
  return entries
}

interface LocatedSource {
  readonly file: SourceFile
  readonly located: LocatedFile
  readonly section: string
  readonly refused: boolean
}

interface UnitDecision {
  readonly source: LocatedSource
  readonly plan: SplicePlan
  readonly state: UnitState
  readonly stale: boolean
  readonly reasons: FindingCode[]
}

/**
 * Compose one locale. Pure and deterministic: the same input yields a deep-equal result.
 *
 * @throws {ComposeInputError} for input that makes the composition ill-defined: a locale
 *   the manifest does not target, a surface it does not declare, a catalog of another
 *   locale, a unit id in two catalogs or two files, or an unsafe or duplicate path.
 */
export function composeLocale(input: ComposeLocaleInput): ComposeLocaleResult {
  validate(input)
  const mode = input.mode ?? 'preview'
  const strict = mode === 'strict'
  const gateSeverity = strict ? 'error' : 'warning'
  const entries = entriesById(input.catalogs)
  const findings: Finding[] = []

  const sources: LocatedSource[] = [...input.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      const context = locateContextFor(input.manifest, file.surface, input.frontmatterTextKeys)
      const located = locateFile(file.surface, file.text, context)
      const extraction = extractionFindings(file.path, located)
      findings.push(...extraction)
      return {
        file,
        located,
        section: file.section ?? file.path,
        refused: extraction.some((finding) => finding.severity === 'error'),
      }
    })

  // Decide every unit.
  const decisions: UnitDecision[] = []
  const owner = new Map<string, string>()
  for (const source of sources) {
    for (const hole of source.located.holes) {
      const id = formatUnitId(hole.id)
      const previous = owner.get(id)
      if (previous !== undefined) {
        throw new ComposeInputError(
          `unit ${id} is declared by both ${quote(previous)} and ${quote(source.file.path)}; identities must be unique across the workshop (ADR 0005)`,
        )
      }
      owner.set(id, source.file.path)

      const found = entries.get(id)?.entry
      const stale = found !== undefined && found.state !== 'missing' && found.source !== hole.source
      const state: UnitState = found === undefined ? 'missing' : stale ? 'fuzzy' : found.state
      const renderable = state === 'reviewed' || (state === 'needs-review' && !strict)
      const reasons: FindingCode[] = []
      if (stale) {
        reasons.push('stale-translation')
        findings.push({
          severity: 'warning',
          code: 'stale-translation',
          path: source.file.path,
          unitId: id,
          message:
            'the catalog translated different English than the source now holds; run extract to mark it fuzzy, then re-translate',
        })
      }

      let stage: SplicePlan['stage'] = renderable ? 'translation' : 'marker'
      const translation = renderable ? found?.translation : undefined
      if (source.refused) {
        stage = 'none'
        reasons.push('extraction')
      } else if (translation !== undefined && translation !== hole.source) {
        const failures = contentGateFailures(
          hole.source,
          translation,
          input.manifest.protectedTerms,
        )
        for (const failure of failures) {
          reasons.push(failure.code)
          findings.push({
            severity: gateSeverity,
            code: failure.code,
            path: source.file.path,
            unitId: id,
            message: strict ? failure.message : `${failure.message}; rendered as English fallback`,
          })
        }
        if (failures.length > 0) stage = 'marker'
      }
      decisions.push({
        source,
        plan: { hole, stage, translation },
        state,
        stale,
        reasons,
      })
    }
  }

  // Policy: core decides, over the English unit set.
  const sourceUnits: SourceUnit[] = decisions.map((decision) => ({
    id: decision.plan.hole.id,
    section: decision.source.section,
  }))
  const known: UnitStatus[] = decisions.map((decision) => ({
    id: decision.plan.hole.id,
    locale: input.locale,
    section: decision.source.section,
    state: decision.state,
  }))
  const policy = evaluatePolicy(
    statusesForLocale(sourceUnits, known, input.locale),
    strict ? 'release' : 'preview',
  )
  const pathOf = new Map(
    decisions.map((decision) => [formatUnitId(decision.plan.hole.id), decision.source.file.path]),
  )
  for (const violation of policy.violations) {
    for (const unit of violation.units) {
      findings.push({
        severity: 'error',
        code: 'policy',
        path: pathOf.get(unit.id) ?? unit.section,
        unitId: unit.id,
        detail: violation.state,
        message: `unit is ${violation.state}; the release policy allows at most ${violation.limit} ${violation.state} unit${violation.limit === 1 ? '' : 's'} (${violation.count} found)`,
      })
    }
  }

  // Splice, file by file, then prove each output.
  const files: ComposedFile[] = []
  for (const source of sources) {
    const plans = decisions.filter((decision) => decision.source === source)
    let text = source.file.text
    if (!source.refused) {
      const context = locateContextFor(
        input.manifest,
        source.file.surface,
        input.frontmatterTextKeys,
      )
      const outcome = spliceWithDemotion(
        source.located,
        plans.map((decision) => decision.plan),
        context,
      )
      text = outcome.text
      for (const demotion of outcome.demotions) {
        const decision = plans.find((item) => formatUnitId(item.plan.hole.id) === demotion.id)
        if (demotion.from === 'translation') {
          decision?.reasons.push(demotion.cause)
          findings.push({
            severity: gateSeverity,
            code: demotion.cause,
            path: source.file.path,
            unitId: demotion.id,
            ...(demotion.reason === undefined ? {} : { detail: demotion.reason }),
            message: strict
              ? demotion.message
              : `${demotion.message}; rendered as English fallback`,
          })
        } else {
          decision?.reasons.push('marker-omitted')
          findings.push({
            severity: 'warning',
            code: 'marker-omitted',
            path: source.file.path,
            unitId: demotion.id,
            message: `the fallback marker could not be placed here (${demotion.message}), so this English text is unmarked`,
          })
        }
      }
      if (outcome.unattributedMismatch !== undefined) {
        findings.push({
          severity: 'error',
          code: 'skeleton-mismatch',
          path: source.file.path,
          line: outcome.unattributedMismatch.line,
          message: `${outcome.unattributedMismatch.message}; no single unit explains it, so the whole file was left in English`,
        })
      }
      // The verifier judges the output as located afresh from the emitted text, never the
      // plan: whatever it says about the output is new evidence and is kept. Preview mode,
      // because fallback in strict output is already an error through the policy.
      const verification = verifyLocated(
        input.manifest,
        source.file.path,
        source.located,
        outcome.located,
        'preview',
      )
      findings.push(...verification.findings)
    }
    files.push({ path: source.file.path, surface: source.file.surface, text })
  }

  const units: UnitReport[] = decisions
    .map((decision) => ({
      id: formatUnitId(decision.plan.hole.id),
      path: decision.source.file.path,
      section: decision.source.section,
      state: decision.state,
      stale: decision.stale,
      rendering: (decision.plan.stage === 'translation'
        ? 'translation'
        : 'fallback') as UnitRendering,
      marked: decision.plan.stage === 'marker',
      reasons: decision.reasons,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const sorted = sortFindings(findings)
  const failed = hasErrorFindings(sorted)
  return {
    locale: input.locale,
    mode,
    files: strict && failed ? [] : files,
    units,
    findings: sorted,
    policy,
    releasable: strict && !failed,
  }
}
