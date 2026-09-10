/**
 * Markup and placeholder parity: the gate that keeps a translation from carrying
 * anything the renderer would *act on* that the English unit did not already carry.
 *
 * ## Why this is a security gate, not a style check
 *
 * A translation is hostile input (constitution, SECURITY.md). It reaches a composed deck
 * that Slidev renders through a markdown-it engine (markdown-exit, its port, in Slidev
 * 52) with raw HTML and linkify enabled and then compiles as a Vue template, so:
 *
 * - a `<script>`, an `<img onerror=…>` or an `onclick=` added to an existing tag is live
 *   HTML in every facilitator's browser;
 * - a `{{ … }}` is a Vue expression, evaluated at render time;
 * - a changed link or image destination silently re-points the audience (or a tracking
 *   pixel) somewhere else — and with linkify on, so does a bare `attacker.io`,
 *   `admin@evil.com` or `_evil.com_`. URL tokens therefore include every link the
 *   renderer itself creates (see {@link rendererLinks}, and the README for the exact
 *   renderer and configuration this is proven against);
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
 * ## Two layers, and which one is the barrier
 *
 * The barrier is the **coarse layer** (`coarse.ts`: `linklike`, `syntax`, `format`),
 * which asks nothing about any renderer and is judged one way — a translation may not
 * introduce what the English lacks. The exact kinds below it are two-way. URL tokens
 * additionally include every link a model of the consumer's renderer creates
 * (`renderer.ts`); that model may only ever add tokens. Three review rounds chased
 * renderer fidelity (emphasis splitting, footnotes, KaTeX, U+FEFF trimming) before this
 * split was made; the differential test now requires every link either engine creates to
 * trip the coarse layer on its own.
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

import { formatTokens, linkLikeTokens, structuralTokens, syntaxTokens } from './coarse.js'
import { rendererLinks } from './renderer.js'

/** What a token is. Kinds are compared separately so a report can say what changed. */
export type MarkupTokenKind =
  | 'code'
  | 'tag'
  | 'mustache'
  | 'brace'
  | 'url'
  | 'linklike'
  | 'syntax'
  | 'format'
  | 'structural'
  | 'entity'
  | 'oversize'

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

const KIND_ORDER: readonly MarkupTokenKind[] = [
  'code',
  'tag',
  'mustache',
  'brace',
  'url',
  'linklike',
  'syntax',
  'format',
  'structural',
  'entity',
  'oversize',
]

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
 * A lexical linkify pass over the *unescaped* text, with schemeless IPs and the extra
 * TLDs above — an over-report. It covers a renderer configured more generously than
 * Slidev's default, and one that joins escaped characters back into text before
 * linkifying (markdown-it 14 does not; `evil\.com` stays unlinked there, and is still
 * counted here).
 */
const LINKIFY = new LinkifyIt({ fuzzyLink: true, fuzzyEmail: true, fuzzyIP: true }).tlds(
  [...EXTRA_FUZZY_TLDS],
  true,
)

/** Everything the lexical linkify pass would link, as spelled in the text. */
function linkifiedUrls(text: string): readonly string[] {
  return (LINKIFY.match(text) ?? []).map((match) => match.raw)
}

function entityTokens(text: string): readonly string[] {
  return text.match(CHARACTER_REFERENCE) ?? []
}

/**
 * The longest text any scan runs on. markdown-it is superlinear on some crafted inputs
 * (`http://a` repeated 40 000 times took 16.7 s), so the renderer model only ever sees
 * text up to this length — and {@link checkMarkupParity} refuses any translation longer
 * than this before a parser runs. The cap is absolute on purpose: it once scaled to
 * `4 × English`, which left a window (8 192, 4 × English] where the renderer model was
 * skipped *silently* and an emoji host glued to a shared code span went through
 * (re-review 4). No layer may be skipped for a translation that is then accepted. Real
 * units are far shorter: the longest of 1 399 real pt-BR translations is 2 771
 * characters.
 */
export const MAX_SCANNED_LENGTH = 8_192

/**
 * Every piece of markup in `text` that a renderer acts on, grouped by kind in a fixed
 * kind order and in order of appearance within each kind. Deterministic.
 *
 * URL tokens are the union of the coarse and lexical passes and, for text within
 * {@link MAX_SCANNED_LENGTH}, the renderer model's own links (see `renderer.ts`). The
 * model only ever adds: the coarse layer (`linklike`, `syntax`, `format`) is the barrier.
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
    url: [
      ...linkDestinations(normalized),
      ...autolinks,
      ...linkifiedUrls(normalized),
      ...(text.length <= MAX_SCANNED_LENGTH ? rendererLinks(text) : []),
    ],
    linklike: linkLikeTokens(normalized),
    syntax: syntaxTokens(normalized),
    structural: structuralTokens(normalized),
    format: formatTokens(normalized),
    entity: entityTokens(text),
    oversize: [],
  }
  return KIND_ORDER.flatMap((kind) => byKind[kind].map((token) => ({ kind, text: token })))
}

/**
 * Kinds judged in one direction only: a translation may not *introduce* them, but may
 * drop them. The coarse layer's job is to stop new links and new parser features; a
 * translation that leaves out an English `e.g.`, `i.e.`, `#1` or a dotted identifier the
 * target language phrases differently creates nothing. Measured, not guessed: on the real
 * pt-BR corpus (1 399 aligned translations), comparing these kinds in both directions
 * rejected 18 more translations, every one of them for a *dropped* token and none for an
 * added one. The other kinds stay two-way — dropping a code span drops a command, and
 * dropping a tag unbalances the Vue template.
 */
const INTRODUCTION_ONLY_KINDS: ReadonlySet<MarkupTokenKind> = new Set([
  'linklike',
  'syntax',
  'format',
  'structural',
])

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
 * `ok` is true only when both carry exactly the same tokens (as multisets, per kind). A
 * translation longer than {@link MAX_SCANNED_LENGTH} is refused with a single `oversize`
 * token before anything scans it.
 */
export function checkMarkupParity(english: string, translation: string): MarkupParity {
  const limit = MAX_SCANNED_LENGTH
  if (translation.length > limit) {
    return {
      ok: false,
      added: [{ kind: 'oversize', text: `${translation.length} characters (limit ${limit})` }],
      removed: [],
    }
  }
  const source = markupTokens(english)
  const target = markupTokens(translation)
  const added = multisetDifference(target, source)
  const removed = multisetDifference(source, target).filter(
    (token) => !INTRODUCTION_ONLY_KINDS.has(token.kind),
  )
  return { ok: added.length === 0 && removed.length === 0, added, removed }
}
