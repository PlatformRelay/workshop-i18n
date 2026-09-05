/**
 * The offset-splice skeleton for quiz JSON (ADR 0012).
 *
 * The skeleton is **the original file text plus a list of holes** — it is not a
 * transformed representation and nothing is ever rebuilt from a parsed value. A hole
 * records the half-open range `[start, end)` that one translatable string body occupies
 * *inside its quotes*, the unit's identity, and the unit's decoded text.
 * {@link composeSkeleton} splices escaped bodies into those ranges in descending order
 * and copies every other byte through unchanged.
 *
 * Two properties follow *by construction* rather than by test discipline:
 *
 * 1. `composeSkeleton(skeleton, {})` reproduces the source byte-for-byte, because every
 *    untranslated hole is filled with `source.slice(start, end)` — the original bytes.
 * 2. Every byte outside a hole — key order, indentation, the quotes themselves, ids,
 *    `answer`, `section`, `references`, and the file's choice between `é` and `é` —
 *    is identical in every locale, because it is literally copied.
 *
 * That second point is the whole argument against the obvious implementation. The two
 * consumer banks have identical JSON Schemas and completely different formatting: one
 * writes an option as a single-line object with no escape anywhere, the other spreads it
 * over four lines and carries dozens of `\"`. `JSON.parse` → mutate → `JSON.stringify`
 * would rewrite each into the other's shape, producing a whole-file diff for a locale in
 * which nothing was translated.
 *
 * ## An identity translation must copy, not re-encode
 *
 * A source that spells an accent `é` decodes to the same string as one that spells
 * it `é`, so re-encoding an unchanged unit would silently rewrite the file's spelling.
 * {@link composeSkeleton} therefore skips a hole whose translation equals its source,
 * exactly as the Markdown extractor does.
 *
 * ## Replacements are validated, not trusted
 *
 * A translation is data from a TMS, so it is hostile input. JSON escaping means it
 * cannot break out of its hole the way Markdown can — {@link encodeJsonStringBody}
 * escapes everything that would end the string — so only two things are refused: a
 * control character other than tab/newline/carriage return, which would reach a rendered
 * quiz as an invisible byte and make the file undiffable, and a lone surrogate, which is
 * legal JSON but is not text and cannot be written as UTF-8.
 */

import {
  compareUnitIds,
  createTranslationUnit,
  formatUnitId,
  type TranslationUnit,
  type UnitId,
} from '@workshop-i18n/core'

/**
 * How a translation is turned back into source text for one hole.
 *
 * `json-string` re-emits the value as the *body* of a JSON string — the bytes between
 * the quotes, which stay where they are.
 */
export type HoleEncoding = { readonly kind: 'json-string' }

/** One translatable span of the source: its identity, its range, and its decoded text. */
export interface Hole {
  readonly id: UnitId
  /** Inclusive start offset in {@link Skeleton.source}, just inside the opening quote. */
  readonly start: number
  /** Exclusive end offset in {@link Skeleton.source}, just before the closing quote. */
  readonly end: number
  /** The translatable text, with JSON escapes already resolved. */
  readonly source: string
  readonly encoding: HoleEncoding
}

/** The original file text plus the holes located in it. */
export interface Skeleton {
  /** The source file, verbatim. Never normalized, never re-serialized. */
  readonly source: string
  /** Holes in ascending order, pairwise disjoint, each with a distinct identity. */
  readonly holes: readonly Hole[]
}

/** Thrown by {@link createSkeleton} when the located holes are not a valid hole set. */
export class SkeletonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkeletonError'
  }
}

/** Why one replacement was refused. */
export type ReplacementRejection = 'control-byte' | 'lone-surrogate'

/** One refused replacement. */
export interface CompositionIssue {
  /** The formatted unit id, so a report can name the catalog entry to fix. */
  readonly id: string
  readonly reason: ReplacementRejection
  readonly message: string
}

/** Thrown by {@link composeSkeleton}; carries every refused replacement, not just the first. */
export class CompositionError extends Error {
  readonly issues: readonly CompositionIssue[]

  constructor(issues: readonly CompositionIssue[]) {
    super(`unspliceable translation: ${issues.map((issue) => issue.message).join('; ')}`)
    this.name = 'CompositionError'
    this.issues = issues
  }
}

/**
 * Validate and normalize a located hole set into a {@link Skeleton}.
 *
 * Overlap, out-of-range offsets and duplicate identities are impossible to compose
 * meaningfully, so they are rejected here — at the boundary where the locator hands its
 * result over — rather than producing a plausible-looking wrong file later.
 */
export function createSkeleton(source: string, holes: readonly Hole[]): Skeleton {
  const sorted = [...holes].sort((a, b) => a.start - b.start || compareUnitIds(a.id, b.id))
  const seen = new Set<string>()
  let previousEnd = 0
  for (const hole of sorted) {
    if (!Number.isInteger(hole.start) || !Number.isInteger(hole.end)) {
      throw new SkeletonError(`hole ${formatUnitId(hole.id)} has a non-integer range`)
    }
    if (hole.start < 0 || hole.end > source.length || hole.start > hole.end) {
      throw new SkeletonError(
        `hole ${formatUnitId(hole.id)} range [${hole.start}, ${hole.end}) is outside the source (length ${source.length})`,
      )
    }
    if (hole.start < previousEnd) {
      throw new SkeletonError(
        `hole ${formatUnitId(hole.id)} at [${hole.start}, ${hole.end}) overlaps the previous hole`,
      )
    }
    const id = formatUnitId(hole.id)
    if (seen.has(id)) throw new SkeletonError(`duplicate unit identity ${id}`)
    seen.add(id)
    previousEnd = hole.end
  }
  return { source, holes: sorted }
}

/**
 * The translation units of a skeleton, in identity order, each minted through the core
 * factory so identity safety and hashing happen in exactly one place.
 */
export function skeletonUnits(skeleton: Skeleton): readonly TranslationUnit[] {
  return [...skeleton.holes]
    .sort((a, b) => compareUnitIds(a.id, b.id))
    .map((hole) => createTranslationUnit(hole.id, hole.source))
}

/** Translations to splice, keyed by formatted unit id (the PO `msgctxt`). */
export type TranslationLookup = ReadonlyMap<string, string> | Readonly<Record<string, string>>

function lookup(translations: TranslationLookup, id: string): string | undefined {
  if (translations instanceof Map) return translations.get(id)
  return Object.hasOwn(translations, id) ? (translations as Record<string, string>)[id] : undefined
}

/**
 * `text` as the body of a JSON string — everything a JSON string needs escaped, escaped,
 * and nothing else.
 *
 * `JSON.stringify` is the encoder rather than a hand-rolled table because it is the
 * definition: it escapes `"`, `\` and every C0 control character, emits `\uXXXX` for a
 * lone surrogate (well-formed stringify, ES2019), and leaves every other character as
 * itself. Slicing the quotes off is safe because `JSON.stringify` of a string always
 * produces exactly one pair of them.
 */
export function encodeJsonStringBody(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

/**
 * True when `text` carries a control character. Tab, line feed and carriage return are
 * the only ones prose needs; anything else would reach a rendered quiz as an invisible
 * byte that makes the bank undiffable.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * True when `text` contains a surrogate code unit with no partner. Legal JSON, but not
 * text: it has no UTF-8 encoding, so it would be lost the moment the file is written.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0xd800 || code > 0xdfff) continue
    if (code >= 0xdc00) return true
    const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
    if (next < 0xdc00 || next > 0xdfff) return true
    index += 1
  }
  return false
}

function rejectReplacement(hole: Hole, replacement: string): CompositionIssue | undefined {
  const id = formatUnitId(hole.id)
  const reject = (reason: ReplacementRejection, detail: string): CompositionIssue => ({
    id,
    reason,
    message: `${id}: ${detail}`,
  })
  if (hasControlCharacter(replacement)) {
    return reject('control-byte', 'translation contains a control character')
  }
  if (hasLoneSurrogate(replacement)) {
    return reject(
      'lone-surrogate',
      'translation contains an unpaired surrogate, which has no UTF-8 encoding',
    )
  }
  return undefined
}

/**
 * Splice `translations` into `skeleton` and return the composed file.
 *
 * Holes are replaced in descending order so that each splice leaves the offsets of the
 * holes before it untouched. A hole with no translation — or whose translation is
 * identical to its English source — is filled with the original bytes, so an empty
 * catalog reproduces the source exactly and an unchanged string keeps its original
 * escape spelling.
 *
 * @throws {CompositionError} when any translation cannot be written as JSON text.
 */
export function composeSkeleton(skeleton: Skeleton, translations: TranslationLookup): string {
  const { source, holes } = skeleton
  const issues: CompositionIssue[] = []
  const replacements = new Map<number, string>()
  for (const [index, hole] of holes.entries()) {
    const translation = lookup(translations, formatUnitId(hole.id))
    if (translation === undefined || translation === hole.source) continue
    const issue = rejectReplacement(hole, translation)
    if (issue) {
      issues.push(issue)
      continue
    }
    replacements.set(index, encodeJsonStringBody(translation))
  }
  if (issues.length > 0) throw new CompositionError(issues)

  let composed = source
  for (let index = holes.length - 1; index >= 0; index -= 1) {
    const replacement = replacements.get(index)
    if (replacement === undefined) continue
    const hole = holes[index] as Hole
    composed = composed.slice(0, hole.start) + replacement + composed.slice(hole.end)
  }
  return composed
}
