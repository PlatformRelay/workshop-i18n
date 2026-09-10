/**
 * The per-section match/miss report (spec 004 FR-002), as data and as text.
 *
 * The data form is plain JSON — arrays and records with every key always present, no
 * `Map`s, no `undefined` outside optional container ids — so a CLI can write it with
 * `JSON.stringify` and a later run can diff it. The text form is for the person running
 * `seed`: totals first, then one line per section, then every container-level miss by id
 * and reason, which is what AS-2's "the slide is listed in the miss report" means.
 *
 * Neither form ever contains translated text. Miss details are written by this package,
 * and the only strings that come from the translated tree are the paths of files that
 * paired with nothing — which are rendered with control characters escaped, so a hostile
 * file name cannot drive the terminal the report is printed to.
 */

import type { Surface } from '@workshop-i18n/core'
import { SEED_OUTCOMES, type SeedOutcome, type SeedOutcomeKind } from './apply.js'
import { addDivergence, noDivergence } from './pair.js'
import {
  SEED_MISS_REASONS,
  type SectionAlignment,
  type SeedMiss,
  type SeedMissReason,
  type SeedWarningCode,
  type SkeletonDivergence,
  type SurfaceAlignment,
} from './types.js'

/** Format version of {@link SeedReport}; bumped on any incompatible change. */
export const SEED_REPORT_VERSION = 1

const WARNING_CODES: readonly SeedWarningCode[] = Object.freeze([
  'code-span-divergence',
  'link-divergence',
])

/** Counters shared by a section, a surface and the whole run. */
export interface SeedCounts {
  /** English units the section yields. */
  readonly englishUnits: number
  /** Units aligned to a translation (drafts), whatever then happened to them. */
  readonly aligned: number
  /** Units not aligned, for any reason. `aligned + missed === englishUnits`. */
  readonly missed: number
  /** What happened to the aligned units in the catalogs. */
  readonly outcomes: Readonly<Record<SeedOutcomeKind, number>>
  /** Missed units by reason. */
  readonly missReasons: Readonly<Record<SeedMissReason, number>>
  /** Aligned units carrying each warning. */
  readonly warnings: Readonly<Record<SeedWarningCode, number>>
  /** Non-prose differences seen and never imported. */
  readonly skeletonDivergence: SkeletonDivergence
}

/** One English file's line in the report. */
export interface SeedSectionReport extends SeedCounts {
  readonly surface: Surface
  readonly section: string
  /** Every miss, with the unit ids it covers. */
  readonly misses: readonly SeedMiss[]
  /** Every aligned unit that carries a warning, by id, so a reviewer can find it. */
  readonly warnedUnits: readonly {
    readonly id: string
    readonly warnings: readonly SeedWarningCode[]
  }[]
}

/** One surface's block in the report. */
export interface SeedSurfaceReport {
  readonly surface: Surface
  readonly totals: SeedCounts
  readonly sections: readonly SeedSectionReport[]
  /** Translated files that paired with no English file. */
  readonly unpairedTranslated: readonly string[]
}

/** The whole report. JSON-serialisable as it stands. */
export interface SeedReport {
  readonly version: typeof SEED_REPORT_VERSION
  readonly locale: string
  readonly provenance: string
  readonly surfaces: readonly SeedSurfaceReport[]
  readonly totals: SeedCounts
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>
}

function emptyCounts(): SeedCounts {
  return {
    englishUnits: 0,
    aligned: 0,
    missed: 0,
    outcomes: zeroes(SEED_OUTCOMES),
    missReasons: zeroes(SEED_MISS_REASONS),
    warnings: zeroes(WARNING_CODES),
    skeletonDivergence: noDivergence(),
  }
}

function addRecord<K extends string>(
  a: Readonly<Record<K, number>>,
  b: Readonly<Record<K, number>>,
): Record<K, number> {
  const sum = { ...a } as Record<K, number>
  for (const key of Object.keys(b) as K[]) sum[key] = (sum[key] ?? 0) + b[key]
  return sum
}

function addCounts(a: SeedCounts, b: SeedCounts): SeedCounts {
  return {
    englishUnits: a.englishUnits + b.englishUnits,
    aligned: a.aligned + b.aligned,
    missed: a.missed + b.missed,
    outcomes: addRecord(a.outcomes, b.outcomes),
    missReasons: addRecord(a.missReasons, b.missReasons),
    warnings: addRecord(a.warnings, b.warnings),
    skeletonDivergence: addDivergence(a.skeletonDivergence, b.skeletonDivergence),
  }
}

function sectionReport(
  section: SectionAlignment,
  outcomeById: ReadonlyMap<string, SeedOutcomeKind>,
): SeedSectionReport {
  const outcomes = zeroes(SEED_OUTCOMES)
  const warnings = zeroes(WARNING_CODES)
  const warnedUnits: { id: string; warnings: SeedWarningCode[] }[] = []
  for (const draft of section.drafts) {
    const id = `${draft.id.surface}:${draft.id.containerId}:${draft.id.unitKey}`
    const outcome = outcomeById.get(id)
    if (outcome !== undefined) outcomes[outcome] += 1
    for (const warning of draft.warnings) warnings[warning] += 1
    if (draft.warnings.length > 0) warnedUnits.push({ id, warnings: [...draft.warnings] })
  }
  warnedUnits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const missReasons = zeroes(SEED_MISS_REASONS)
  let missed = 0
  for (const miss of section.misses) {
    missReasons[miss.reason] += miss.unitIds.length
    missed += miss.unitIds.length
  }
  return {
    surface: section.surface,
    section: section.section,
    englishUnits: section.englishUnits,
    aligned: section.drafts.length,
    missed,
    outcomes,
    missReasons,
    warnings,
    skeletonDivergence: { ...section.skeletonDivergence },
    misses: section.misses.map((miss) => ({ ...miss, unitIds: [...miss.unitIds] })),
    warnedUnits,
  }
}

/** Build the report from what the aligners found and what the catalogs did with it. */
export function buildSeedReport(
  alignments: readonly SurfaceAlignment[],
  outcomes: readonly SeedOutcome[],
  meta: { readonly locale: string; readonly provenance: string },
): SeedReport {
  const outcomeById = new Map(outcomes.map((item) => [item.id, item.outcome]))
  let totals = emptyCounts()
  const surfaces = alignments.map((alignment) => {
    const sections = alignment.sections.map((section) => sectionReport(section, outcomeById))
    const surfaceTotals = sections.reduce<SeedCounts>(
      (sum, section) => addCounts(sum, section),
      emptyCounts(),
    )
    totals = addCounts(totals, surfaceTotals)
    return {
      surface: alignment.surface,
      totals: surfaceTotals,
      sections,
      unpairedTranslated: [...alignment.unpairedTranslated],
    }
  })
  return {
    version: SEED_REPORT_VERSION,
    locale: meta.locale,
    provenance: meta.provenance,
    surfaces,
    totals,
  }
}

/** Escape anything that could steer a terminal; the rest is printed as it is. */
function printable(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const control =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
    out += control ? `\\u${code.toString(16).padStart(4, '0')}` : char
  }
  return out
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`
}

function nonZero(record: Readonly<Record<string, number>>): string {
  const parts = Object.entries(record)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
  return parts.length === 0 ? 'none' : parts.join(', ')
}

function countsLine(counts: SeedCounts): string {
  return (
    `${counts.aligned}/${counts.englishUnits} units aligned (${percent(counts.aligned, counts.englishUnits)}); ` +
    `catalogs: ${nonZero(counts.outcomes)}; missed: ${nonZero(counts.missReasons)}`
  )
}

/** Render the report for a terminal. Deterministic: same report, same text. */
export function formatSeedReport(report: SeedReport): string {
  const lines: string[] = [
    `seed ${printable(report.locale)} from ${printable(report.provenance)}`,
    `total: ${countsLine(report.totals)}`,
    `warnings on aligned units: ${nonZero(report.totals.warnings)}`,
    `skeleton divergence, never imported: ${nonZero({ ...report.totals.skeletonDivergence })}`,
  ]
  for (const surface of report.surfaces) {
    lines.push('', `${surface.surface}: ${countsLine(surface.totals)}`)
    for (const section of surface.sections) {
      lines.push(
        `  ${printable(section.section)}: ${section.aligned}/${section.englishUnits} aligned` +
          (section.missed > 0 ? `, missed ${nonZero(section.missReasons)}` : ''),
      )
      for (const miss of section.misses) {
        const where = miss.containerId === undefined ? 'whole file' : printable(miss.containerId)
        if (miss.reason === 'identical-to-source') {
          // Per-unit, and usually numerous: list the ids, so each can be found and filled.
          lines.push(`    - ${where}: left in English, not seeded:`)
          for (const id of miss.unitIds) lines.push(`        ${printable(id)}`)
          continue
        }
        lines.push(
          `    - ${where}: ${miss.reason}, ${miss.unitIds.length} unit(s) — ${printable(miss.detail)}`,
        )
      }
      for (const unit of section.warnedUnits) {
        lines.push(`    ! ${printable(unit.id)}: seeded with ${unit.warnings.join(', ')}`)
      }
    }
    if (surface.unpairedTranslated.length > 0) {
      lines.push(`  translated files with no English counterpart (not read):`)
      for (const path of surface.unpairedTranslated) lines.push(`    - ${printable(path)}`)
    }
  }
  return `${lines.join('\n')}\n`
}
