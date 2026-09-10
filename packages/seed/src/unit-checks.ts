/**
 * Per-unit checks on an aligned pair: is this translated string safe and plausible to
 * offer as a draft of that English unit?
 *
 * The translated tree is untrusted input. Alignment can only establish *where* a string
 * belongs; these checks decide whether the string itself is something a reviewer should
 * be handed. They are meant as a pre-filter in front of the hard markup and fence-identity
 * gates of `compose`/`verify` — but those gates are not on `main` yet, so **until compose
 * lands, this is the only filter** between a translated tree and a catalog a deck is built
 * from. What this refuses is never written to a catalog by `seed`; what it accepts is not
 * thereby proven safe, and the rules below are kept deliberately coarse for that reason.
 *
 * ## Coarse rules first, context only to refuse more
 *
 * Every rule that decides *acceptance* is coarse and renderer-independent: it compares
 * the translation against the English over the **whole unit**, as plain text, and asks
 * only whether the translation carries anything the English does not. No model of the
 * renderer is trusted to *clear* a translation, because every such model tried so far was
 * narrower than markdown-it plus Slidev plus Vue. Context — where code spans are — is
 * consulted only to add refusals (an interpolation moved out of a code span into prose),
 * never to remove one. `test/slidev-build.smoke.test.ts` checks the rules against a real
 * `slidev build` when `WORKSHOP_I18N_SLIDEV_SMOKE` names a directory with a Slidev
 * install: every hostile case that has ever been live must be refused, or build exactly
 * like its English.
 *
 * Two tiers:
 *
 * - **Refusals** (`markup-divergence`, `length-divergence`, …). A translation is refused
 *   when, compared with its English unit, it adds any of:
 *   - a `<` followed by a non-space character — a tag, closing tag, autolink, comment,
 *     processing instruction, declaration or CDATA section — compared as whole, case-
 *     and whitespace-sensitive tokens (so an added attribute, a Vue directive, or `<KBD>`
 *     for `<kbd>` are all new);
 *   - a character reference that decodes to `{`, `}`, `<` or `>`, or that this module
 *     cannot decode;
 *   - a `{{ … }}` interpolation or a bare `{{`, spelled literally, with backslash
 *     escapes, or with character references (all decoded before counting);
 *   - a line that is a Slidev slot marker (`::name::`), a slide separator (`---…`), a
 *     fence opener, a snippet import (`<<<` — reads a local file into the build) or a
 *     KaTeX block (`$$`), unless the English has the identical line;
 *   - a `{`, `}` or `$` beyond the English's count, after decoding: every Slidev option
 *     block (code-block `{lines}{options}`, KaTeX `{…}{options}`, MDC `{attrs}`) is a
 *     brace pair that becomes a live `v-bind`, and a single `$` switches KaTeX on;
 *   - a Unicode format character (general category Cf: zero-width characters, the soft
 *     hyphen, the byte-order mark, bidirectional controls), literal or as a character
 *     reference, which can hide text from a linkifier or a reviewer — and the invisibles
 *     outside Cf that do the same (combining grapheme joiner, variation selectors, Hangul
 *     fillers);
 *   - a `javascript:`, `vbscript:`, `file:` or `data:<type>/` URL, found anywhere in the
 *     decoded unit, whitespace removed.
 *
 *   It is also refused when its length says it is almost certainly not this unit's text.
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
 * Anything markdown-it could read as HTML, or that starts to look like it: `<` followed
 * by `!` or `?` (comment, declaration, CDATA, processing instruction — up to the next
 * `>`), by a letter or `/` (a tag or autolink — up to the next `<` or `>`), or by any
 * other non-space character (just the two characters, so prose such as `<5 min` compares
 * as `<5`). `a < b` is not a token.
 */
const MARKUP = /<[!?][^>]*>?|<\/?[A-Za-z][^<>]*>?|<[^\s<]/g
/** An inline link or image target, for the link warning. */
const LINK_TARGET = /\]\(\s*([^)\s]+)/g
/** URL schemes that execute or embed, searched for in the decoded, whitespace-free unit. */
const ACTIVE_SCHEME = /(?:javascript|vbscript|file):|data:[a-z-]+\//g
/** Unicode format characters. */
const FORMAT_CHARACTER = /\p{Cf}/gu
/**
 * Invisible characters outside Cf that can still hide text from a reviewer: the combining
 * grapheme joiner, variation selectors (both blocks) and the Hangul fillers.
 */
function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    code === 0x034f ||
    code === 0x115f ||
    code === 0x1160 ||
    code === 0x3164 ||
    code === 0xffa0 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  )
}
/** A Slidev slot marker line, as `@slidev/parser`'s slot sugar matches it (trimmed here). */
const SLOT_MARKER = /^::\s*[\w.\-:]+\s*::$/
/**
 * The starts of constructs that can take the opening backtick of what looks like a code
 * span, so that the "span" is live prose to the renderer: any `[` (links, images,
 * references, footnotes — their `](` may itself sit inside the would-be span), URLs
 * (`://`, `www.`), inline HTML and autolinks (`<` + non-space), inline math (`$`), and
 * MDC attribute braces (`{`), which Slidev enables with `mdc: true`.
 * A construct can only take a backtick that comes after its start, and its start lies
 * outside every span the scanner found, so looking for starts there is enough.
 */
const BACKTICK_EATER = /\[|<\S|:\/\/|www\.|\$|\{/
/** The characters that open Slidev option blocks and KaTeX. */
const BRACE_OR_DOLLAR = /[{}$]/g
/** Joins sorted tokens into one comparable string; a character no token contains. */
const SEPARATOR = String.fromCharCode(0)

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

const collapse = (token: string): string => token.replace(/\s+/g, ' ')

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

/** The text outside the code spans the scanner finds, spans replaced by a space. */
function outsideCode(text: string): string {
  let outside = ''
  let cursor = 0
  for (const span of findCodeSpans(text)) {
    outside += `${text.slice(cursor, span.start)} `
    cursor = span.end
  }
  return outside + text.slice(cursor)
}

function markupTokens(text: string, skipEscaped: boolean): string[] {
  return [...text.matchAll(MARKUP)]
    .filter((match) => !skipEscaped || !isEscaped(text, match.index))
    .map((match) => collapse(match[0]))
}

/** Lines that change a slide's block structure: slot markers, separators, fence openers. */
function structuralLines(text: string): string[] {
  return text.split('\n').flatMap((raw) => {
    const line = raw.trim()
    const structural =
      SLOT_MARKER.test(line) ||
      line.startsWith('---') ||
      line.startsWith('```') ||
      line.startsWith('~~~') ||
      // Slidev snippet import (`<<< @/file lang {lines}{options}`): reads a local file into
      // the build, and its options become a live `v-bind` on the code block wrapper.
      line.startsWith('<<<') ||
      // A KaTeX block, whose `$$ {…}{options}` opener also becomes a live `v-bind`.
      line.startsWith('$$')
    return structural ? [collapse(line)] : []
  })
}

function activeSchemes(decoded: string): string[] {
  return [...decoded.replace(/\s+/g, '').toLowerCase().matchAll(ACTIVE_SCHEME)].map(
    (match) => match[0],
  )
}

/**
 * True when `translation` carries markup its English unit does not — see the module doc
 * for the full list. Coarse whole-unit rules decide; the code-span-aware rule after them
 * can only refuse more.
 */
export function hasMarkupDivergence(source: string, translation: string): boolean {
  // Coarse, whole unit, both sides as plain text.
  if (!isSubMultiset(markupTokens(translation, false), markupTokens(source, false))) return true
  const references = (text: string) =>
    [...text.matchAll(CHAR_REF)].map((match) => match[0]).filter(isGuardedReference)
  if (!isSubMultiset(references(translation), references(source))) return true
  const ourDecoded = decodeInline(source)
  const theirDecoded = decodeInline(translation)
  const ours = findMustaches(ourDecoded)
  const theirs = findMustaches(theirDecoded)
  if (!isSubMultiset(theirs.complete.map(collapse), ours.complete.map(collapse))) return true
  if (theirs.openers > ours.openers) return true
  if (!isSubMultiset(structuralLines(translation), structuralLines(source))) return true
  // Decoded, so `&#8203;` counts as the zero-width space it renders as.
  const chars = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[0])
  if (!isSubMultiset(chars(theirDecoded, FORMAT_CHARACTER), chars(ourDecoded, FORMAT_CHARACTER))) {
    return true
  }
  const invisibles = (text: string) => [...text].filter(isInvisible)
  if (!isSubMultiset(invisibles(theirDecoded), invisibles(ourDecoded))) return true
  // Braces and dollars, counted after decoding. Every Slidev option block — code-block
  // `{lines}{options}`, KaTeX `$$ {…}{options}`, MDC `{attrs}` — is a brace pair that
  // becomes a live `v-bind`, and a single `$` is enough for Slidev to switch KaTeX on. A
  // translation needs neither beyond what its English already has.
  if (!isSubMultiset(chars(theirDecoded, BRACE_OR_DOLLAR), chars(ourDecoded, BRACE_OR_DOLLAR))) {
    return true
  }
  if (!isSubMultiset(activeSchemes(theirDecoded), activeSchemes(ourDecoded))) return true

  // Context, to refuse more. The English side counts only what is certainly live — outside
  // its code spans and not backslash-escaped — which can only make the check stricter. The
  // translation side trusts its own code spans only when nothing outside them could have
  // taken an opening backtick; otherwise every tag and interpolation in it counts as live.
  const ourProse = outsideCode(source)
  const theirProse = outsideCode(translation)
  const trusted = !BACKTICK_EATER.test(theirProse)
  const theirLive = trusted ? theirProse : translation
  if (!isSubMultiset(markupTokens(theirLive, trusted), markupTokens(ourProse, true))) return true
  const ourLive = findMustaches(decodeInline(ourProse))
  const theirLiveMustaches = findMustaches(decodeInline(theirLive))
  if (!isSubMultiset(theirLiveMustaches.complete.map(collapse), ourLive.complete.map(collapse))) {
    return true
  }
  return theirLiveMustaches.openers > ourLive.openers
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
      .join(SEPARATOR)
  if (spans(source) !== spans(translation)) {
    warnings.push('code-span-divergence')
  }
  const targets = (text: string) =>
    [...text.matchAll(LINK_TARGET)]
      .map((match) => match[1] ?? '')
      .sort()
      .join(SEPARATOR)
  if (targets(source) !== targets(translation)) {
    warnings.push('link-divergence')
  }
  return { miss: undefined, warnings }
}
