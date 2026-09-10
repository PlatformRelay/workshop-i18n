/**
 * Markup and placeholder parity: the gate that keeps a translation from carrying
 * anything the renderer would *act on* that the English unit did not already carry.
 *
 * ## Why this is a security gate, not a style check
 *
 * A translation is hostile input (constitution, SECURITY.md). It reaches a composed deck
 * that Slidev renders through markdown-it with raw HTML enabled and then compiles as a
 * Vue template, so:
 *
 * - a `<script>`, an `<img onerror=…>` or an `onclick=` added to an existing tag is live
 *   HTML in every facilitator's browser;
 * - a `{{ … }}` is a Vue expression, evaluated at render time;
 * - a changed link or image destination silently re-points the audience (or a tracking
 *   pixel) somewhere else;
 * - a changed inline code span is a changed command, which ADR 0007 requires to be
 *   byte-identical across locales.
 *
 * The extractors' `composeSkeleton` already refuses what would break a translation *out
 * of its hole* (separators, fences, comment delimiters). This gate covers what a
 * translation can do *inside* its hole.
 *
 * ## The rule
 *
 * Tokenize the English unit and the translation the same way, and require the two token
 * multisets to be equal — per kind, in any order (German word order is not English word
 * order). Adding a token is how an attack arrives; removing one is how a translation
 * drops a command or leaves a `<v-click>` unbalanced, which fails the Vue compile.
 *
 * ## Conservative on purpose
 *
 * The tokenizer is deliberately *not* a faithful CommonMark parser, and it errs in one
 * direction only: it finds more markup than a renderer would, never less. Every kind is
 * scanned over the whole text — a tag inside an inline code span still counts as a tag —
 * so an attacker cannot hide markup inside a construct this scanner and the renderer
 * disagree about (an escaped backtick, for instance, opens no code span). Two spellings
 * that a renderer turns back into live markup are normalized before scanning: backslash
 * escapes (`\{\{` renders as `{{`) and numeric or brace/angle character references
 * (`&#123;&#123;` does too). Character references are additionally compared as tokens of
 * their own, so a translation cannot introduce one at all. The price of erring this way
 * is a false positive — an honest translation falling back to English with a warning —
 * which is visible and cheap; the alternative is a missed injection, which is neither.
 */

import LinkifyIt from 'linkify-it'

/** What a token is. Kinds are compared separately so a report can say what changed. */
export type MarkupTokenKind = 'code' | 'tag' | 'mustache' | 'brace' | 'url' | 'entity'

/** One piece of markup found in a unit. */
export interface MarkupToken {
  readonly kind: MarkupTokenKind
  /** The token exactly as spelled, after escape normalization for the normalized kinds. */
  readonly text: string
}

/** The verdict of {@link checkMarkupParity}. */
export interface MarkupParity {
  readonly ok: boolean
  /** Tokens the translation has that the English does not, per multiset difference. */
  readonly added: readonly MarkupToken[]
  /** Tokens the English has that the translation does not. */
  readonly removed: readonly MarkupToken[]
}

const KIND_ORDER: readonly MarkupTokenKind[] = ['code', 'tag', 'mustache', 'brace', 'url', 'entity']

/** CommonMark's escapable characters: ASCII punctuation. */
const ESCAPABLE = /\\([!-/:-@[-`{-~])/g

/**
 * The named references that decode to a character that matters to this gate. Anything
 * else is left alone: a reference the English does not carry is already refused as an
 * `entity` token, so the table only has to be complete for what must be *scanned*.
 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = Object.freeze({
  lt: '<',
  gt: '>',
  lbrace: '{',
  lcub: '{',
  rbrace: '}',
  rcub: '}',
  lpar: '(',
  rpar: ')',
  lsqb: '[',
  lbrack: '[',
  rsqb: ']',
  rbrack: ']',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  grave: '`',
  bsol: '\\',
})

const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g

function decodeReference(match: string, decimal?: string, hex?: string, name?: string): string {
  const code =
    decimal !== undefined
      ? Number.parseInt(decimal, 10)
      : hex !== undefined
        ? Number.parseInt(hex, 16)
        : undefined
  if (code !== undefined) {
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  }
  return (
    (name !== undefined && Object.hasOwn(NAMED_REFERENCES, name) && NAMED_REFERENCES[name]) || match
  )
}

/** The text as a renderer would read it for the purpose of finding live markup. */
function normalize(text: string): string {
  return text.replace(CHARACTER_REFERENCE, decodeReference).replace(ESCAPABLE, '$1')
}

/**
 * Inline code spans: a backtick run closed by the next run of exactly the same length.
 *
 * Linear by construction: every run is found in one pass, and each run's closer is
 * precomputed by walking the runs backwards. Searching forward from each opener instead
 * costs a rescan per unmatched run, which a crafted msgstr of runs of many lengths turns
 * into a stall.
 */
function codeSpans(text: string): readonly string[] {
  const runs: { readonly start: number; readonly end: number }[] = []
  for (const match of text.matchAll(/`+/g)) {
    runs.push({ start: match.index, end: match.index + match[0].length })
  }
  const closer: (number | undefined)[] = new Array(runs.length)
  const nextOfLength = new Map<number, number>()
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index] as { start: number; end: number }
    const length = run.end - run.start
    closer[index] = nextOfLength.get(length)
    nextOfLength.set(length, index)
  }
  const spans: string[] = []
  let index = 0
  while (index < runs.length) {
    const close = closer[index]
    if (close === undefined) {
      index += 1
      continue
    }
    spans.push(
      text.slice((runs[index] as { start: number }).start, (runs[close] as { end: number }).end),
    )
    index = close + 1
  }
  return spans
}

const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/
const EMAIL_AUTOLINK =
  /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*>/

/**
 * Read one tag starting at `start` (which holds `<`), honouring quoted attribute values
 * so a `>` inside quotes does not end the tag early. Returns the end offset, or the end
 * of the text for a tag that never closes — an unterminated tag is still a tag.
 */
function tagEnd(text: string, start: number): number {
  let index = start + 1
  let quote: string | undefined
  while (index < text.length) {
    const character = text.charAt(index)
    if (quote !== undefined) {
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index + 1
    }
    index += 1
  }
  return text.length
}

/** Tags, comments, declarations, processing instructions — and autolinks, which are URLs. */
function angleTokens(text: string): { tags: string[]; autolinks: string[] } {
  const tags: string[] = []
  const autolinks: string[] = []
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open === -1) break
    const rest = text.slice(open)
    const autolink = AUTOLINK.exec(rest)?.[0] ?? EMAIL_AUTOLINK.exec(rest)?.[0]
    if (autolink !== undefined) {
      autolinks.push(autolink.slice(1, -1))
      index = open + autolink.length
      continue
    }
    if (rest.startsWith('<!--')) {
      const close = text.indexOf('-->', open + 4)
      const end = close === -1 ? text.length : close + 3
      tags.push(text.slice(open, end))
      index = end
      continue
    }
    if (/^<(?:\/?[A-Za-z]|!|\?)/.test(rest)) {
      const end = tagEnd(text, open)
      tags.push(text.slice(open, end))
      index = end
      continue
    }
    index = open + 1
  }
  return { tags, autolinks }
}

/** `{{ … }}` expressions, plus any `{{` or `}}` left unbalanced after pairing them. */
function mustacheTokens(text: string): { tokens: string[]; rest: string } {
  // A scan rather than `/\{\{[\s\S]*?\}\}/g`: the lazy regex retries from every `{{` to
  // the end of the text when none closes, which is quadratic on a crafted msgstr.
  const tokens: string[] = []
  let rest = ''
  let index = 0
  for (;;) {
    const open = text.indexOf('{{', index)
    const close = open === -1 ? -1 : text.indexOf('}}', open + 2)
    if (close === -1) break
    rest += `${text.slice(index, open)} `
    tokens.push(text.slice(open, close + 2))
    index = close + 2
  }
  const residual = (rest + text.slice(index)).replace(/\{\{|\}\}/g, (match) => {
    tokens.push(match)
    return ' '
  })
  return { tokens, rest: residual }
}

/** Single-brace groups: attribute lists (`{onclick=…}`) in markdown extensions such as MDC. */
function braceTokens(text: string): readonly string[] {
  return text.match(/\{[^{}]*\}/g) ?? []
}

/** Destinations of inline links and images: `[text](dest "title")`, `![alt](dest)`. */
function linkDestinations(text: string): readonly string[] {
  const found: string[] = []
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('](', index)
    if (open === -1) break
    let cursor = open + 2
    while (text.charAt(cursor) === ' ' || text.charAt(cursor) === '\t') cursor += 1
    let destination = ''
    let end: number
    if (text.charAt(cursor) === '<') {
      const close = text.indexOf('>', cursor)
      end = close === -1 ? text.length : close
      destination = text.slice(cursor + 1, end)
    } else {
      let depth = 0
      end = cursor
      while (end < text.length) {
        const character = text.charAt(end)
        if (/\s/.test(character)) break
        if (character === '(') depth += 1
        if (character === ')') {
          if (depth === 0) break
          depth -= 1
        }
        end += 1
      }
      destination = text.slice(cursor, end)
    }
    if (destination !== '') found.push(destination)
    // Resume after the destination, not inside it: a `](` within a destination is part
    // of that one link to a renderer too, and rescanning from each one is quadratic on a
    // crafted `](x](x…`.
    index = Math.max(open + 2, end)
  }
  return found
}

/**
 * Top-level domains linkify-it does *not* link schemelessly by default, added here so a
 * consumer who extends its markdown-it's TLD list (`linkify.tlds(…, true)`) is still
 * covered. Pure over-reporting: against the default renderer these can only cause a
 * fallback, never let a link through.
 */
const EXTRA_FUZZY_TLDS: readonly string[] = Object.freeze([
  'app',
  'blog',
  'cloud',
  'club',
  'dev',
  'online',
  'page',
  'site',
  'store',
  'tech',
  'top',
  'xyz',
])

/**
 * The linkifier Slidev's markdown-it runs (`linkify: true`), configured with its
 * defaults plus schemeless IPs and the extra TLDs above — again only ever *more*.
 *
 * Why the library and not a regex: linkify-it links `attacker.io`, `evil.com/login` and
 * `admin@evil.com` with no scheme at all, under TLD, IDN, punycode, bracket and trailing-
 * punctuation rules that a hand-written pattern would approximate and drift from. The
 * parity invariant is "no new live link can appear", and the only way to state what the
 * renderer links without guessing is to ask the code the renderer uses. It is pure
 * (no I/O), dependency-light (uc.micro) and pinned to the major markdown-it 14 uses.
 */
const LINKIFY = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: true }).tlds(
  [...EXTRA_FUZZY_TLDS],
  true,
)

/** Everything a linkifier would turn into a live link, as spelled in the text. */
function linkifiedUrls(text: string): readonly string[] {
  return (LINKIFY.match(text) ?? []).map((match) => match.raw)
}

function entityTokens(text: string): readonly string[] {
  return text.match(CHARACTER_REFERENCE) ?? []
}

/**
 * Every piece of markup in `text` that a renderer acts on, grouped by kind in a fixed
 * kind order and in order of appearance within each kind. Deterministic.
 */
export function markupTokens(text: string): readonly MarkupToken[] {
  const normalized = normalize(text)
  const { tags, autolinks } = angleTokens(normalized)
  const mustache = mustacheTokens(normalized)
  const byKind: Record<MarkupTokenKind, readonly string[]> = {
    code: codeSpans(text),
    tag: tags,
    mustache: mustache.tokens,
    brace: braceTokens(mustache.rest),
    url: [...linkDestinations(normalized), ...autolinks, ...linkifiedUrls(normalized)],
    entity: entityTokens(text),
  }
  return KIND_ORDER.flatMap((kind) => byKind[kind].map((token) => ({ kind, text: token })))
}

function keyOf(token: MarkupToken): string {
  return JSON.stringify([token.kind, token.text])
}

/** Tokens of `from` not matched one-for-one by a token of `against`. */
function multisetDifference(
  from: readonly MarkupToken[],
  against: readonly MarkupToken[],
): readonly MarkupToken[] {
  const remaining = new Map<string, number>()
  for (const token of against) remaining.set(keyOf(token), (remaining.get(keyOf(token)) ?? 0) + 1)
  const difference: MarkupToken[] = []
  for (const token of from) {
    const count = remaining.get(keyOf(token)) ?? 0
    if (count > 0) remaining.set(keyOf(token), count - 1)
    else difference.push(token)
  }
  return difference
}

/**
 * Compare the markup of an English unit with that of its translation.
 *
 * `ok` is true only when both carry exactly the same tokens (as multisets, per kind).
 */
export function checkMarkupParity(english: string, translation: string): MarkupParity {
  const source = markupTokens(english)
  const target = markupTokens(translation)
  const added = multisetDifference(target, source)
  const removed = multisetDifference(source, target)
  return { ok: added.length === 0 && removed.length === 0, added, removed }
}
