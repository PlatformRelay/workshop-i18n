/**
 * Per-unit checks on an aligned pair: is this translated string safe and plausible to
 * offer as a draft of that English unit?
 *
 * The translated tree is untrusted input. Alignment can only establish *where* a string
 * belongs; these checks decide whether the string itself is something a reviewer should
 * be handed. They are deliberately a first line, not the gate: `compose`/`verify` own
 * the hard markup and fence-identity gates on everything that ships. What this refuses
 * never reaches a catalog, so a reviewer skimming a Weblate queue cannot accept it by
 * accident.
 *
 * Two tiers, on purpose:
 *
 * - **Refusals** (`markup-divergence`, `length-divergence`, …) — the string would change
 *   what the page *does* (a tag, attribute or Vue directive the English does not carry, a
 *   `{{ }}` interpolation, a comment that could end a speaker note, a `javascript:` or
 *   `data:` link), or its length says it is almost certainly not this unit's text.
 * - **Warnings** (`code-span-divergence`, `link-divergence`) — translators legitimately
 *   rephrase around inline code and point links at localized docs. Refusing those would
 *   discard good work; the draft carries the warning into the report instead.
 */

import { findCodeSpans, findMustaches } from './inline-scan.js'
import type { SeedLimits, SeedMissReason, SeedWarningCode } from './types.js'

/** Outcome of {@link checkTranslation}. */
export interface TranslationCheck {
  /** Set when the pair must not be seeded. */
  readonly miss: SeedMissReason | undefined
  readonly warnings: readonly SeedWarningCode[]
}

/**
 * An HTML/Vue tag opener or closer (a letter must follow `<` or `</`, as in HTML, so a
 * comparison like `a < b` is not a tag), an autolink, or an HTML comment opener.
 */
const TAG = /<!--|<\/?[A-Za-z][^<>]*>?/g
/** An inline link or image target. */
const LINK_TARGET = /\]\(\s*([^)\s]+)/g
/** URL schemes that execute or embed rather than navigate. */
const ACTIVE_SCHEME = /^\s*(?:javascript|vbscript|data|file):/i

/** A character reference with its terminating semicolon — the only form markdown-it decodes. */
const CHAR_REF = /&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g
/**
 * The same pattern, sticky, for the decoder. A separate object on purpose: `matchAll`
 * starts from a global pattern's `lastIndex`, so sharing one would let the decoder's
 * position leak into the reference count and skip references.
 */
const CHAR_REF_AT = new RegExp(CHAR_REF.source, 'y')
/** ASCII punctuation, which CommonMark lets a backslash escape. */
const ESCAPABLE = /[!-/:-@[-`{-~]/
/** What an invalid numeric reference decodes to. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd)

/**
 * Named references this module can decode: every HTML5 spelling of the characters the
 * checks care about, plus common typographic ones translators use. A name missing here
 * is treated as unknown — refused unless the English uses it too — so the table only
 * has to be *correct*, never complete.
 */
const NAMED_REFS: Readonly<Record<string, string>> = Object.freeze({
  lcub: '{',
  lbrace: '{',
  rcub: '}',
  rbrace: '}',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  amp: '&',
  AMP: '&',
  quot: '"',
  apos: "'",
  nbsp: String.fromCodePoint(0xa0),
  hellip: String.fromCodePoint(0x2026),
  mdash: String.fromCodePoint(0x2014),
  ndash: String.fromCodePoint(0x2013),
  middot: String.fromCodePoint(0xb7),
  rarr: String.fromCodePoint(0x2192),
  larr: String.fromCodePoint(0x2190),
  times: String.fromCodePoint(0xd7),
  laquo: String.fromCodePoint(0xab),
  raquo: String.fromCodePoint(0xbb),
  ldquo: String.fromCodePoint(0x201c),
  rdquo: String.fromCodePoint(0x201d),
  lsquo: String.fromCodePoint(0x2018),
  rsquo: String.fromCodePoint(0x2019),
})

/** Characters a reference must not smuggle in: they build tags and interpolations. */
const SIGNIFICANT: ReadonlySet<string> = new Set(['{', '}', '<', '>'])

/**
 * A reference needs the English's permission when it decodes to a significant character,
 * or when it cannot be decoded here at all. `&amp;` for a bare `&` does not.
 */
function isGuardedReference(reference: string): boolean {
  const decoded = decodeReference(reference)
  return decoded === reference || SIGNIFICANT.has(decoded)
}

function decodeReference(reference: string): string {
  const body = reference.slice(1, -1)
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = hex ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    return valid ? String.fromCodePoint(code) : REPLACEMENT_CHARACTER
  }
  return NAMED_REFS[body] ?? reference
}

/**
 * The text markdown-it hands to Vue for prose outside code spans: backslash escapes and
 * character references resolved, in one left-to-right pass — so an escaped ampersand
 * followed by `#123;` stays literal text, as it does in markdown-it.
 */
function decodeInline(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    const next = text.charAt(index + 1)
    if (char === '\\' && next !== '' && ESCAPABLE.test(next)) {
      out += next
      index += 2
      continue
    }
    if (char === '&') {
      CHAR_REF_AT.lastIndex = index
      const match = CHAR_REF_AT.exec(text)
      if (match !== null) {
        out += decodeReference(match[0])
        index += match[0].length
        continue
      }
    }
    out += char
    index += 1
  }
  return out
}

/** True when the character at `index` is escaped by an odd run of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let back = index - 1; back >= 0 && text.charCodeAt(back) === 0x5c; back -= 1) slashes += 1
  return slashes % 2 === 1
}

/**
 * One unit's inline markup, split by the context that decides whether it is live:
 *
 * - **outside code spans**, a raw tag is live HTML and a `{{ }}` — however it is spelled,
 *   since markdown-it decodes references and escapes before Vue sees the text — is a
 *   live expression;
 * - **inside code spans**, Slidev escapes both, so they are inert text.
 *
 * A translation may only use what the English uses *in the same context*: moving an
 * interpolation out of a code span turns documentation into code.
 */
interface InlineMarkup {
  /** Raw tags outside code, not backslash-escaped, whitespace-collapsed and lowercased. */
  readonly tags: readonly string[]
  /**
   * The same over the whole text, code spans included. A second view because the scan
   * can pair backticks that the renderer gives to an HTML tag or autolink instead, and a
   * tag it wrongly thought was inside code must still be one the English carries.
   */
  readonly allTags: readonly string[]
  /** Character references outside code that need the English's permission, as written. */
  readonly references: readonly string[]
  /** Interpolations outside code, after decoding. */
  readonly liveMustaches: readonly string[]
  readonly liveOpeners: number
  /** Interpolations inside code spans. */
  readonly codeMustaches: readonly string[]
  readonly codeOpeners: number
}

const collapse = (token: string): string => token.replace(/\s+/g, ' ')

function inlineMarkup(text: string): InlineMarkup {
  const spans = findCodeSpans(text)
  let outside = ''
  let cursor = 0
  for (const span of spans) {
    // A space keeps the prose on either side of a span from joining into one token.
    outside += `${text.slice(cursor, span.start)} `
    cursor = span.end
  }
  outside += text.slice(cursor)

  const tagsOf = (value: string) =>
    [...value.matchAll(TAG)]
      .filter((match) => !isEscaped(value, match.index))
      .map((match) => collapse(match[0]).toLowerCase())
  const live = findMustaches(decodeInline(outside))
  const code = spans.map((span) => findMustaches(span.content))
  return {
    tags: tagsOf(outside),
    allTags: tagsOf(text),
    references: [...outside.matchAll(CHAR_REF)].map((match) => match[0]).filter(isGuardedReference),
    liveMustaches: live.complete.map(collapse),
    liveOpeners: live.openers,
    codeMustaches: code.flatMap((found) => found.complete.map(collapse)),
    codeOpeners: code.reduce((sum, found) => sum + found.openers, 0),
  }
}

/** True when every token of `theirs` occurs in `ours` at least as often. */
function isSubMultiset(theirs: readonly string[], ours: readonly string[]): boolean {
  const budget = new Map<string, number>()
  for (const token of ours) budget.set(token, (budget.get(token) ?? 0) + 1)
  for (const token of theirs) {
    const left = budget.get(token) ?? 0
    if (left === 0) return false
    budget.set(token, left - 1)
  }
  return true
}

function multiset(text: string, pattern: RegExp, group: number): string {
  return [...text.matchAll(pattern)]
    .map((match) => match[group] ?? '')
    .sort()
    .join('\u0000')
}

/**
 * True when `translation` introduces markup `source` does not carry in the same context.
 *
 * The invariant: a translation may not add a tag, attribute, directive, HTML comment
 * opener (`<!--` is the only comment marker checked — it is the one that can end a
 * speaker note), character reference, `{{ }}` interpolation or active link target that
 * the English unit does not already carry in that same context.
 */
export function hasMarkupDivergence(source: string, translation: string): boolean {
  const ours = inlineMarkup(source)
  const theirs = inlineMarkup(translation)
  // Tags are compared whole: an attribute or a Vue directive added to a tag the English
  // already has changes what the page does as much as a new tag would.
  if (!isSubMultiset(theirs.tags, ours.tags)) return true
  if (!isSubMultiset(theirs.allTags, ours.allTags)) return true
  // A reference that could spell markup, or that this module cannot decode, is refused
  // unless the English uses it too: `&lcub;` is only one of several spellings of `{`.
  if (!isSubMultiset(theirs.references, ours.references)) return true
  if (!isSubMultiset(theirs.liveMustaches, ours.liveMustaches)) return true
  if (theirs.liveOpeners > ours.liveOpeners) return true
  if (!isSubMultiset(theirs.codeMustaches, ours.codeMustaches)) return true
  if (theirs.codeOpeners > ours.codeOpeners) return true
  const ourTargets = new Set([...source.matchAll(LINK_TARGET)].map((match) => match[1]))
  return [...translation.matchAll(LINK_TARGET)].some(
    (match) => ACTIVE_SCHEME.test(match[1] ?? '') && !ourTargets.has(match[1]),
  )
}

/**
 * Decide whether `translation` may be offered as a draft of `source`.
 *
 * Pure and total: any pair of strings yields a result, and nothing in either string is
 * interpreted beyond pattern matching.
 */
export function checkTranslation(
  source: string,
  translation: string,
  limits: SeedLimits,
): TranslationCheck {
  const refuse = (miss: SeedMissReason): TranslationCheck => ({ miss, warnings: [] })
  if (translation === '') return refuse('empty-translation')
  if (translation === source) return refuse('identical-to-source')
  if (translation.length > limits.lengthRatio * source.length + limits.lengthSlack) {
    return refuse('length-divergence')
  }
  if (hasMarkupDivergence(source, translation)) return refuse('markup-divergence')

  const warnings: SeedWarningCode[] = []
  const spans = (text: string) =>
    findCodeSpans(text)
      .map((span) => span.content)
      .sort()
      .join('\u0000')
  if (spans(source) !== spans(translation)) {
    warnings.push('code-span-divergence')
  }
  if (multiset(source, LINK_TARGET, 1) !== multiset(translation, LINK_TARGET, 1)) {
    warnings.push('link-divergence')
  }
  return { miss: undefined, warnings }
}
