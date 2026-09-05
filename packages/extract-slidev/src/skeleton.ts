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
 * A translation is data from a TMS, so it is hostile input, and every hazard here is a
 * *render-time* one: the bytes survive, and the deck the audience sees is wrong. A line
 * Slidev reads as a separator splits the slide in two; a fence opener makes the renderer
 * skip to the next matching run, swallowing whole slides; `<!--` comments out the
 * skeleton after it, and inside a speaker note a `-->` closes the comment early; and a
 * `---` inside a frontmatter value truncates the block, putting `slideId:` on screen as
 * prose. Composition fails closed on all of them (constitution III/V) rather than
 * emitting them and hoping a later gate notices.
 *
 * The line predicates come from `deck.ts` — the transcription of Slidev's own scanner —
 * rather than being restated here. They were restated once, in CommonMark's spelling,
 * and the two definitions disagreed about indented fences and about `--- x`; every such
 * disagreement is a translated deck that splits differently from the English one.
 */

import {
  compareUnitIds,
  createTranslationUnit,
  formatUnitId,
  type TranslationUnit,
  type UnitId,
} from '@workshop-i18n/core'
import { isFenceOpenerLine, isSlideSeparatorLine, isTildeFenceOpenerLine } from './deck.js'

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
      /** True for a GFM table cell, where a bare `|` would add a column. */
      readonly cell: boolean
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
  | 'indented-code'
  | 'table-column'

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

/**
 * True when `text` carries a character that must not reach a composed file.
 *
 * Two kinds. Control characters — everything below 0x20 except tab, line feed and
 * carriage return, plus DEL — end up in a generated deck as invisible bytes that make it
 * undiffable. And **lone surrogates**: a high or low surrogate without its partner has no
 * UTF-8 encoding, so writing the file silently substitutes U+FFFD. `decodeSource` refuses
 * exactly that loss on the way in; this is the same rule at the other end of the trip.
 */
function hasUnsafeCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f) return true
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

/** The text before and after a hole on the lines it occupies. */
interface SpliceContext {
  /** Everything from the start of the hole's first line up to the hole. */
  readonly prefix: string
  /** Everything from the end of the hole to the end of its last line. */
  readonly suffix: string
  /** The bytes the hole currently holds, for comparing what a replacement introduces. */
  readonly original: string
}

/** Read the text sharing a line with the hole, which decides how its edges are judged. */
function spliceContextOf(source: string, hole: Hole): SpliceContext {
  const lineStart = source.lastIndexOf('\n', hole.start - 1) + 1
  const lineEnd = source.indexOf('\n', hole.end)
  return {
    prefix: source.slice(lineStart, hole.start),
    suffix: source.slice(hole.end, lineEnd === -1 ? source.length : lineEnd),
    original: source.slice(hole.start, hole.end),
  }
}

function countOccurrences(text: string, token: string): number {
  let count = 0
  let index = text.indexOf(token)
  while (index !== -1) {
    count += 1
    index = text.indexOf(token, index + token.length)
  }
  return count
}

/**
 * Reject a replacement that would change the deck's structure rather than its words.
 *
 * Judged **in context**, on the lines as they will actually appear. A hole does not
 * usually start at column 0 — a heading begins after its `# `, a list item after its
 * bullet, a paragraph inside a list item after its indentation — and what sits in front
 * of it on that line decides what the line becomes. Waving the first line through for
 * not starting at column 0 was true for separators, whose rule is column-anchored, and
 * false for fences, which Slidev opens at *any* indent: a bare fence spliced after two
 * spaces of list indentation is an indented fence opener, and a second one gives it a
 * close for the renderer to skip to.
 *
 * The same reasoning applies at the far edge: a replacement ending in `--` in front of a
 * `>` already on the line synthesises a comment terminator neither side contains. So
 * comment delimiters are counted across the whole reconstructed region and compared with
 * what it holds today — one that was already there is fine, one that appears is not.
 */
function rejectReplacement(
  hole: Hole,
  replacement: string,
  context: SpliceContext,
): CompositionIssue | undefined {
  const id = formatUnitId(hole.id)
  const reject = (reason: ReplacementRejection, detail: string): CompositionIssue => ({
    id,
    reason,
    message: `${id}: ${detail}`,
  })
  if (hasUnsafeCharacter(replacement)) {
    return reject(
      'control-byte',
      'translation contains a control character or an unpaired surrogate, which cannot survive being written as UTF-8 — remove it from the translation',
    )
  }
  if (hole.encoding.kind === 'yaml-scalar') {
    // Slidev's frontmatter regex is lazy and its close is not line-anchored, so the first
    // `---` anywhere after the opener ends the block — including one inside a quoted
    // value, where re-quoting cannot help. Everything after it, `slideId:` included, is
    // then rendered to the audience as slide prose.
    return replacement.includes('---')
      ? reject(
          'slide-separator',
          'translation contains "---", which truncates the frontmatter block and renders the rest of it as slide text — use an em dash "—" or an en dash pair instead',
        )
      : undefined
  }
  const composed = context.prefix + replacement + context.suffix
  const current = context.prefix + context.original + context.suffix
  for (const token of ['<!--', '-->']) {
    // Not `>`: **removing** a delimiter is exactly as fatal as adding one. A unit spans a
    // whole paragraph, inline comments included, so a translator can simply not carry a
    // `-->` across — and the comment then stays open and swallows every slide after it.
    const before = countOccurrences(current, token)
    const after = countOccurrences(composed, token)
    if (after !== before) {
      const verb = after > before ? 'introduces' : 'drops'
      return reject(
        'comment-terminator',
        hole.encoding.context === 'note'
          ? `translation ${verb} "${token}", which would break the speaker-note comment open — keep exactly the delimiters the English has`
          : `translation ${verb} "${token}", which would leave an HTML comment open or closed over the wrong text — keep exactly the delimiters the English has`,
      )
    }
  }
  // Unescaped pipes only: `\|` is how a cell carries a literal one, and translators need it.
  const barePipes = (text: string): number => countOccurrences(text.replace(/\\\|/g, ''), '|')
  if (hole.encoding.cell && barePipes(replacement) > barePipes(hole.source)) {
    return reject(
      'table-column',
      'translation adds a "|" inside a table cell, which adds a column to that row — escape it as "\\|"',
    )
  }
  // An indented code block can only begin where a new block can: at the top of the unit,
  // or after a blank line inside it. Elsewhere the same indentation is a lazy paragraph
  // continuation, which is why this is not a flat test on every line. Reading only the
  // first line missed the second case, where `\n    code` renders the paragraph away.
  const replacementLines = splitLines(replacement)
  for (const [index, line] of replacementLines.entries()) {
    const opensBlock =
      index === 0
        ? context.prefix === ''
        : // Inside a container the line carries the container's own indentation, and how
          // much of it counts as code depends on context composition does not have.
          hole.encoding.continuationPrefix === '' &&
          (replacementLines[index - 1] ?? '').trim() === ''
    if (opensBlock && /^(?: {4,}|\t)/.test(line)) {
      return reject(
        'indented-code',
        'translation begins a line with a tab or four spaces where a new block starts, which CommonMark renders as a code block — remove the leading indentation',
      )
    }
  }
  for (const line of splitLines(composed)) {
    if (isSlideSeparatorLine(line)) {
      return reject(
        'slide-separator',
        'translation starts a line with "---", which Slidev reads as a slide break — use an em dash "—" or an en dash pair instead',
      )
    }
    if (isFenceOpenerLine(line) || isTildeFenceOpenerLine(line)) {
      return reject(
        'fence-opener',
        'translation opens a fenced code block, which makes the renderer skip to the next matching fence — use single backticks for inline code instead',
      )
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
    const issue = rejectReplacement(hole, replacement, spliceContextOf(source, hole))
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
