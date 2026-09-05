/**
 * The offset-splice skeleton (ADR 0012).
 *
 * The skeleton is **the original file text plus a list of holes** — it is not a
 * transformed representation and nothing is ever rebuilt from an AST. A hole records
 * the half-open range `[start, end)` that one translatable unit occupies in the source,
 * the unit's identity, and the unit's decoded text. {@link composeSkeleton} splices
 * translations into those ranges in descending order and copies every other byte
 * through unchanged.
 *
 * Two properties follow *by construction* rather than by test discipline:
 *
 * 1. `composeSkeleton(skeleton, {})` reproduces the source byte-for-byte, because every
 *    untranslated hole is filled with `source.slice(start, end)` — the original bytes.
 * 2. Every byte outside a hole — fences, frontmatter machinery, Vue islands, includes,
 *    image references, indentation, blank lines — is identical in every locale, because
 *    it is literally copied.
 *
 * ## Offsets are indices into the decoded source string
 *
 * ADR 0012 says "byte range". This module records offsets into the *decoded* source
 * (UTF-16 code units, which is what a markdown parser reports). For valid UTF-8 the two
 * are in bijection, so a splice at code-unit boundaries is byte-exact outside the hole;
 * the corpus round-trip tests assert that at the byte level, on `Buffer`s, rather than
 * trusting the equivalence. {@link decodeSource} is the door that keeps the bijection
 * true: it refuses input that is not valid UTF-8 instead of silently substituting
 * U+FFFD, which is the one way a decode/encode cycle could lose a byte.
 *
 * ## Replacements are validated, not trusted
 *
 * A translation is data from a TMS, so it is hostile input. A markdown hole whose
 * replacement contains a line `---` would split the slide in two; one containing a
 * fence opener would swallow the rest of the file; one inside a speaker note containing
 * `-->` would close the comment early. Those are silent mangles of the protected
 * skeleton, so composition fails closed on them (constitution III/V) rather than
 * emitting them and hoping a later gate notices.
 */

import {
  compareUnitIds,
  createTranslationUnit,
  formatUnitId,
  type TranslationUnit,
  type UnitId,
} from '@workshop-i18n/core'

/** Where a markdown hole sits, which decides what a replacement may not contain. */
export type HoleContext = 'body' | 'note'

/**
 * How a translation is turned back into source text for one hole.
 *
 * `markdown` splices the text literally, re-applying the container prefix (`> `, list
 * indentation) that the locator stripped from the unit's continuation lines.
 * `yaml-scalar` re-emits the value as a double-quoted YAML scalar.
 */
export type HoleEncoding =
  | {
      readonly kind: 'markdown'
      /** Exact prefix carried by every continuation line of the original span. */
      readonly continuationPrefix: string
      readonly context: HoleContext
    }
  | { readonly kind: 'yaml-scalar' }

/** One translatable span of the source: its identity, its range, and its decoded text. */
export interface Hole {
  readonly id: UnitId
  /** Inclusive start offset in {@link Skeleton.source}. */
  readonly start: number
  /** Exclusive end offset in {@link Skeleton.source}. */
  readonly end: number
  /** The translatable text, with container prefixes and YAML quoting already removed. */
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
export type ReplacementRejection =
  | 'slide-separator'
  | 'fence-opener'
  | 'comment-terminator'
  | 'control-byte'

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

/** The line break the original span uses, so a translation is re-emitted the same way. */
function lineBreakOf(raw: string): string {
  return raw.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Split on either line break. Used for prefix handling only — the break itself is
 * re-derived from the original span, never carried through the unit text.
 */
function splitLines(text: string): readonly string[] {
  return text.split(/\r?\n/)
}

/**
 * The translatable text of a markdown span: the raw slice with `prefix` removed from
 * every continuation line, and line breaks normalized to `\n`.
 *
 * `prefix` is the *common* container prefix the locator measured, so every continuation
 * line is known to start with it; a line that somehow does not is left alone rather than
 * cut mid-character, because losing a byte is worse than an ugly unit.
 */
export function stripContinuationPrefix(raw: string, prefix: string): string {
  const lines = splitLines(raw)
  if (prefix === '') return lines.join('\n')
  return lines
    .map((line, index) => (index > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join('\n')
}

/**
 * A YAML double-quoted scalar for `text`. YAML 1.2's double-quoted style is a superset
 * of JSON string syntax, so `JSON.stringify` is already a correct — and deterministic —
 * encoder: it escapes quotes, backslashes and newlines, which is exactly what keeps a
 * translated value from restructuring the frontmatter around it.
 */
function encodeYamlScalar(text: string): string {
  return JSON.stringify(text)
}

function encodeReplacement(hole: Hole, raw: string, text: string): string {
  if (hole.encoding.kind === 'yaml-scalar') return encodeYamlScalar(text)
  const prefix = hole.encoding.continuationPrefix
  return splitLines(text).join(lineBreakOf(raw) + prefix)
}

const SLIDE_SEPARATOR = /^-{3,}[ \t]*$/
const FENCE_OPENER = /^ {0,3}(?:`{3,}|~{3,})/
/**
 * True when `text` carries a control character. Tab, line feed and carriage return are
 * the only ones prose needs; anything else in a translation would end up in a generated
 * deck as an invisible byte that makes the file undiffable.
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f) return true
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
  if (hole.encoding.kind === 'yaml-scalar') return undefined
  if (hole.encoding.context === 'note' && /-->|<!--/.test(replacement)) {
    return reject(
      'comment-terminator',
      'translation contains "<!--" or "-->", which would break out of the speaker-note comment',
    )
  }
  for (const line of splitLines(replacement)) {
    if (SLIDE_SEPARATOR.test(line)) {
      return reject('slide-separator', 'translation contains a line Slidev reads as a slide break')
    }
    if (FENCE_OPENER.test(line)) {
      return reject('fence-opener', 'translation contains a line that opens a fenced code block')
    }
  }
  return undefined
}

/**
 * Splice `translations` into `skeleton` and return the composed file.
 *
 * Holes are replaced in descending order so that each splice leaves the offsets of the
 * holes before it untouched. A hole with no translation — or whose translation is
 * identical to its English source — is filled with the original bytes, so an empty
 * catalog reproduces the source exactly.
 *
 * @throws {CompositionError} when any translation would break out of its hole.
 */
export function composeSkeleton(skeleton: Skeleton, translations: TranslationLookup): string {
  const { source, holes } = skeleton
  const issues: CompositionIssue[] = []
  const replacements = new Map<number, string>()
  for (const [index, hole] of holes.entries()) {
    const translation = lookup(translations, formatUnitId(hole.id))
    if (translation === undefined || translation === hole.source) continue
    const replacement = encodeReplacement(hole, source.slice(hole.start, hole.end), translation)
    const issue = rejectReplacement(hole, replacement)
    if (issue) {
      issues.push(issue)
      continue
    }
    replacements.set(index, replacement)
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
