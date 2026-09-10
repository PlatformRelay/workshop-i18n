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
 * ## The backbone: a character budget
 *
 * After decoding escapes and character references, every character of the translation
 * outside a small free set — letters, marks, decimal digits, the ordinary space and the
 * no-break space, and prose punctuation `. , ; : ! ? ' " ( ) - – — … « » “ ” ‘ ’ ¿ ¡ %` —
 * may occur at most as often as in the English unit ({@link firstOverBudget}). Markup is
 * built from the other characters, so this refuses markup the English could not already
 * produce without enumerating any syntax. A line break is free only when the next line
 * starts with a letter (a re-wrap); any other added break is budgeted. The rules below
 * were found one at a time before the budget existed and stay as further refusals.
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
 *   - a `{`, `}` or `$` beyond the English's count, after decoding — counted over the
 *     whole unit, and again outside code spans (whole translation when its spans are not
 *     trusted), because a brace inside an English code span such as `jsonpath={…}` is
 *     inert and must not fund a live one: every Slidev option block (code-block
 *     `{lines}{options}`, KaTeX `{…}{options}`, MDC `{attrs}`) is a brace pair that
 *     becomes a live `v-bind`, and a single `$` switches KaTeX on;
 *   - a run of three or more backticks or tildes anywhere (a fence opens after a list or
 *     blockquote marker too, and need not close);
 *   - an image (`![`) beyond the English's count, or an image target the English does not
 *     have — the build turns every image into an import, `./.env?raw` included — and a
 *     link reference definition line;
 *   - a braceless MDC name (`:Toc`, `::Toc`, `:href`, `:1`, in the renderer's `[\w$-]`
 *     name class) after whitespace, emphasis or `[`, and any line starting with `:`;
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
 *   rephrase around inline code and point links at localized docs. A link warning covers
 *   `](…)` targets and bare `scheme://` URLs; a bare host without a scheme is plain text
 *   only while Slidev's fuzzy linkify stays off, and compose's host rule is the gate. Refusing those would
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
/**
 * A bare `scheme://` URL, which the linkifier turns into a link. Bare hosts without a
 * scheme (`evil.example`) stay plain text only while Slidev's fuzzy linkify stays off;
 * compose's host rule covers them.
 */
const BARE_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>)\]`"']+/g
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
/**
 * A run of three or more backticks or tildes, anywhere: a fence opens after a list or
 * blockquote marker too (`- ```plantuml`, `> ```mermaid`), not only at the start of a line,
 * and it need not be closed to turn into a component or a build-time transform.
 */
const FENCE_RUN = /`{3,}|~{3,}/g
/** A Markdown image opener. Vue's asset-URL transform turns every image into an import. */
const IMAGE = /!\[/g
/** An inline image's target: retargeting an English image is as good as adding one. */
const IMAGE_TARGET = /!\[[^\]]*\]\(\s*<?([^)\s>]*)/g
/**
 * A braceless MDC component or bound prop (`:Toc`, `::Toc`, `:href`, `:1`): a colon run
 * right after the start of a line, whitespace, emphasis, or a link bracket, then a name in
 * the renderer's own name class, `[\w$-]` — digits, `$`, `-` and `_` included.
 */
const MDC_NAME = /(?:^|[\s*_[])(:{1,2}[\w$-]+)/gm
/** A link reference definition line (`[r]: target`), which can retarget any `[x][r]`. */
const REFERENCE_DEFINITION = /^\[[^\]]*\]:/
/**
 * Prose punctuation a translation may add freely. Everything outside the free set —
 * letters, marks, decimal digits, the two ordinary spaces and these — is budgeted by the
 * English unit (see {@link firstOverBudget}).
 */
const FREE_PUNCTUATION: ReadonlySet<string> = new Set([
  ...'.,;:!?\'"()%',
  '-',
  String.fromCodePoint(0x2013), // en dash
  String.fromCodePoint(0x2014), // em dash
  String.fromCodePoint(0x2026), // ellipsis
  String.fromCodePoint(0xab), // left guillemet
  String.fromCodePoint(0xbb), // right guillemet
  String.fromCodePoint(0x201c), // left double quote
  String.fromCodePoint(0x201d), // right double quote
  String.fromCodePoint(0x2018), // left single quote
  String.fromCodePoint(0x2019), // right single quote
  String.fromCodePoint(0xbf), // inverted question mark
  String.fromCodePoint(0xa1), // inverted exclamation mark
])
const FREE_SPACES: ReadonlySet<string> = new Set([' ', String.fromCodePoint(0xa0)])
const LETTER_MARK_DIGIT = /^[\p{L}\p{M}\p{Nd}]$/u

function isFree(char: string): boolean {
  return FREE_SPACES.has(char) || FREE_PUNCTUATION.has(char) || LETTER_MARK_DIGIT.test(char)
}

/**
 * True when the line break at `index` only re-wraps prose: the next line, after ordinary
 * spaces, starts with a letter. Translators re-wrap nearly every paragraph (529 of the 539
 * units the budget alone refused in PR #55 differ only in where the lines break), and a
 * line that starts with a letter cannot open any block — every CommonMark, markdown-exit
 * or Slidev block start (list, heading, setext underline, thematic break, fence, table,
 * HTML, slot marker, separator, MDC block, snippet, math) begins with a digit, punctuation
 * or indentation that a paragraph line cannot carry past a letter. Any other break stays
 * budgeted.
 */
function isWrap(chars: readonly string[], index: number): boolean {
  let next = index + 1
  while (chars[next] === ' ') next += 1
  const char = chars[next]
  return char !== undefined && /^\p{L}$/u.test(char)
}

/**
 * The backbone rule: the first character, outside the free set, that the translation uses
 * more often than its English unit — or `undefined` when every such character is within
 * the English's budget. Both texts are decoded first, so a reference or an escape is
 * counted as the character it renders as.
 *
 * It does not enumerate syntax. Every markup construct is built from characters outside
 * the free set (`` ` ~ < > { } [ ] $ * _ # | @ / \ & ^ = + ``, line breaks, symbols), so a
 * translation can only produce markup its English could already produce from the same
 * characters. The specific rules after it remain as further refusals.
 */
export function firstOverBudget(source: string, translation: string): string | undefined {
  const budget = new Map<string, number>()
  for (const char of decodeInline(source)) {
    if (!isFree(char)) budget.set(char, (budget.get(char) ?? 0) + 1)
  }
  const theirs = [...decodeInline(translation)]
  for (const [index, char] of theirs.entries()) {
    if (isFree(char) || (char === '\n' && isWrap(theirs, index))) continue
    const left = budget.get(char) ?? 0
    if (left === 0) return char
    budget.set(char, left - 1)
  }
  return undefined
}

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
      // Any line that starts with a colon: the MDC block rule accepts two or more colons
      // and trims before reading a name (`:: toc`, `:::Toc`), and `:1 …` shorthand lines
      // break the build outright. The slot marker above is one case of this.
      line.startsWith(':') ||
      line.startsWith('---') ||
      line.startsWith('```') ||
      line.startsWith('~~~') ||
      // Slidev snippet import (`<<< @/file lang {lines}{options}`): reads a local file into
      // the build, and its options become a live `v-bind` on the code block wrapper.
      line.startsWith('<<<') ||
      // A KaTeX block, whose `$$ {…}{options}` opener also becomes a live `v-bind`.
      line.startsWith('$$') ||
      REFERENCE_DEFINITION.test(line)
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
  if (firstOverBudget(source, translation) !== undefined) return true
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
  if (!isSubMultiset(chars(theirDecoded, FENCE_RUN), chars(ourDecoded, FENCE_RUN))) return true
  // Images: any `![` the English does not have, including a link flipped into one.
  if (chars(theirDecoded, IMAGE).length > chars(ourDecoded, IMAGE).length) return true
  const imageTargets = (text: string) => [...text.matchAll(IMAGE_TARGET)].map((m) => m[1] ?? '')
  if (!isSubMultiset(imageTargets(theirDecoded), imageTargets(ourDecoded))) return true
  const mdcNames = (text: string) => [...text.matchAll(MDC_NAME)].map((m) => m[1] ?? '')
  if (!isSubMultiset(mdcNames(theirDecoded), mdcNames(ourDecoded))) return true
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
  const ourProseDecoded = decodeInline(ourProse)
  const theirLiveDecoded = decodeInline(theirLive)
  // Braces, dollars and images a code span holds are inert there, so they may not pay for
  // live ones: `jsonpath={…}` in an English span does not fund a prose `{onclick=…}`.
  const live = (text: string, pattern: RegExp) => chars(text, pattern)
  if (
    !isSubMultiset(live(theirLiveDecoded, BRACE_OR_DOLLAR), live(ourProseDecoded, BRACE_OR_DOLLAR))
  ) {
    return true
  }
  if (live(theirLiveDecoded, IMAGE).length > live(ourProseDecoded, IMAGE).length) return true
  const ourLive = findMustaches(ourProseDecoded)
  const theirLiveMustaches = findMustaches(theirLiveDecoded)
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
    [
      ...[...text.matchAll(LINK_TARGET)].map((match) => match[1] ?? ''),
      ...[...text.matchAll(BARE_URL)].map((match) => match[0]),
    ]
      .sort()
      .join(SEPARATOR)
  if (targets(source) !== targets(translation)) {
    warnings.push('link-divergence')
  }
  return { miss: undefined, warnings }
}
