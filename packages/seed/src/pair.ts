/**
 * Pairing the two trees file by file, and the helpers every surface aligner shares.
 *
 * A parallel tree mirrors the English layout, so a file is paired with the translated
 * file at the same relative path. That is a *pairing* rule, not an identity: nothing
 * produced here carries the path forward, and every unit id still comes from the English
 * file's explicit container ids (ADR 0005). A path only decides which two files are
 * compared, and a wrong pairing can only produce misses — the container and unit checks
 * downstream refuse structure that does not line up.
 */

import { formatUnitId, type TranslationUnit } from '@workshop-i18n/core'
import {
  DEFAULT_SEED_LIMITS,
  type SeedFile,
  SeedInputError,
  type SeedLimits,
  type SeedMiss,
  type SeedMissReason,
  type SkeletonDivergence,
} from './types.js'

/** Options every surface aligner accepts. */
export interface AlignOptions {
  /** Override any of {@link DEFAULT_SEED_LIMITS}. */
  readonly limits?: Partial<SeedLimits>
}

/** One English file and its translated counterpart, if the translated tree has one. */
export interface FilePair {
  readonly path: string
  readonly english: string
  readonly translated: string | undefined
}

/** Resolve caller overrides onto the defaults, refusing nonsense bounds. */
export function resolveLimits(overrides: Partial<SeedLimits> | undefined): SeedLimits {
  const limits = { ...DEFAULT_SEED_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new SeedInputError(`seed limit ${name} must be a finite, non-negative number`)
    }
  }
  return limits
}

function indexByPath(files: readonly SeedFile[], tree: string): Map<string, string> {
  const byPath = new Map<string, string>()
  for (const file of files) {
    if (typeof file.path !== 'string' || typeof file.text !== 'string') {
      throw new SeedInputError(`every ${tree} file must have a string path and text`)
    }
    if (byPath.has(file.path)) {
      throw new SeedInputError(`${tree} tree lists ${JSON.stringify(file.path)} twice`)
    }
    byPath.set(file.path, file.text)
  }
  return byPath
}

/**
 * Pair English files with translated files by relative path, in path order.
 *
 * @throws {SeedInputError} on a duplicated path in either tree, or more translated files
 *   than {@link SeedLimits.maxFiles}.
 */
export function pairFiles(
  english: readonly SeedFile[],
  translated: readonly SeedFile[],
  limits: SeedLimits,
): { readonly pairs: readonly FilePair[]; readonly unpairedTranslated: readonly string[] } {
  if (translated.length > limits.maxFiles || english.length > limits.maxFiles) {
    throw new SeedInputError(
      `seed accepts at most ${limits.maxFiles} files per tree and surface; got ${english.length} English and ${translated.length} translated`,
    )
  }
  const englishByPath = indexByPath(english, 'English')
  const translatedByPath = indexByPath(translated, 'translated')
  const pairs = [...englishByPath.keys()].sort().map((path) => ({
    path,
    english: englishByPath.get(path) as string,
    translated: translatedByPath.get(path),
  }))
  const unpairedTranslated = [...translatedByPath.keys()]
    .filter((path) => !englishByPath.has(path))
    .sort()
  return { pairs, unpairedTranslated }
}

/** A miss covering every English unit of a file. */
export function fileMiss(
  reason: SeedMissReason,
  units: readonly TranslationUnit[],
  detail: string,
): SeedMiss {
  return {
    reason,
    containerId: undefined,
    unitIds: units.map((unit) => formatUnitId(unit.id)).sort(),
    detail,
  }
}

/** A miss covering every English unit of one container. */
export function containerMiss(
  reason: SeedMissReason,
  containerId: string,
  units: readonly TranslationUnit[],
  detail: string,
): SeedMiss {
  return {
    reason,
    containerId,
    unitIds: units.map((unit) => formatUnitId(unit.id)).sort(),
    detail,
  }
}

/** The file-level refusal for a translated file, if it must not be read at all. */
export function refuseTranslatedFile(
  pair: FilePair,
  units: readonly TranslationUnit[],
  limits: SeedLimits,
): SeedMiss | undefined {
  if (pair.translated === undefined) {
    return fileMiss('no-translated-file', units, 'the translated tree has no file at this path')
  }
  if (pair.translated.length > limits.maxFileLength) {
    return fileMiss(
      'translated-file-too-large',
      units,
      `the translated file is ${pair.translated.length} characters; the limit is ${limits.maxFileLength}`,
    )
  }
  return undefined
}

/** Group units by container id, preserving order. */
export function byContainer(units: readonly TranslationUnit[]): Map<string, TranslationUnit[]> {
  const groups = new Map<string, TranslationUnit[]>()
  for (const unit of units) {
    const group = groups.get(unit.id.containerId)
    if (group === undefined) groups.set(unit.id.containerId, [unit])
    else group.push(unit)
  }
  return groups
}

/** No divergence at all. */
export function noDivergence(): SkeletonDivergence {
  return { fence: 0, html: 0, other: 0 }
}

/** Add two divergence tallies. */
export function addDivergence(a: SkeletonDivergence, b: SkeletonDivergence): SkeletonDivergence {
  return { fence: a.fence + b.fence, html: a.html + b.html, other: a.other + b.other }
}

interface Span {
  readonly start: number
  readonly end: number
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/m
const HTML_LIKE = /<[A-Za-z!/]/

/** The bytes of `[start, end)` that are not inside any hole, as a sequence of segments. */
function skeletonSegments(source: string, range: Span, holes: readonly Span[]): readonly string[] {
  const segments: string[] = []
  let cursor = range.start
  for (const hole of holes) {
    if (hole.start < range.start || hole.end > range.end) continue
    segments.push(source.slice(cursor, hole.start))
    cursor = hole.end
  }
  segments.push(source.slice(cursor, range.end))
  return segments
}

/**
 * Tally the skeleton segments that differ between an English range and its aligned
 * translated range. Informational only: skeleton is never imported, whatever this says.
 */
export function skeletonDivergence(
  english: { readonly source: string; readonly range: Span; readonly holes: readonly Span[] },
  translated: { readonly source: string; readonly range: Span; readonly holes: readonly Span[] },
): SkeletonDivergence {
  const ours = skeletonSegments(english.source, english.range, english.holes)
  const theirs = skeletonSegments(translated.source, translated.range, translated.holes)
  if (ours.length !== theirs.length) return { fence: 0, html: 0, other: 1 }
  const tally = { fence: 0, html: 0, other: 0 }
  ours.forEach((segment, index) => {
    const other = theirs[index] as string
    if (segment === other) return
    if (FENCE_LINE.test(segment) || FENCE_LINE.test(other)) tally.fence += 1
    else if (HTML_LIKE.test(segment) || HTML_LIKE.test(other)) tally.html += 1
    else tally.other += 1
  })
  return tally
}
