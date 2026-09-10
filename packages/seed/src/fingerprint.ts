/**
 * A slide's language-independent fingerprint: what stays the same when a slide is
 * translated, so that "slide *n* of the translation is slide *n* of the English" can be
 * checked rather than assumed (see ADR 0016).
 *
 * The parts are exactly the content a translator does not translate:
 *
 * - **structure** — the slide's unit keys (heading and block shape);
 * - **fences** — every fenced block's info string and body, with comments stripped,
 *   because translated code comments are expected and are not a reason to doubt a slide;
 * - **code** — inline code span contents;
 * - **links** — link and image targets, bare URLs, and `src`/`href` values;
 * - **components** — HTML and Vue elements in order, by tag and attribute names, with the
 *   values of bound and machinery attributes (`class`, `kind`, `src`, …).
 *
 * The speaker note is left out, and fences whose bodies are prose (`console`, `text`, …)
 * contribute only their info string and line count: translators translate those.
 *
 * Every scan here is linear in the slide's length: this runs on untrusted text.
 */

import { findCodeSpans } from './inline-scan.js'

/** The fingerprint, part by part, so a mismatch can say which part differed. */
export interface FingerprintParts {
  readonly structure: string
  readonly fences: string
  readonly code: string
  readonly links: string
  readonly components: string
}

/**
 * Attributes whose values are machinery rather than prose. Any other attribute keeps only
 * its name: component props like `heading="…"` or `reason="…"` hold text a translator is
 * expected to translate. Bound attributes (`:x`, `v-…`) are expressions and always kept.
 */
const MACHINERY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'at',
  'class',
  'color',
  'height',
  'href',
  'icon',
  'id',
  'kind',
  'lang',
  'name',
  'size',
  'src',
  'type',
  'variant',
  'width',
])

/**
 * Fence languages whose bodies are, or carry, prose — command output, plain text, and
 * Markdown — and that translators therefore translate beyond their comments. Only their
 * info string and line count are fingerprinted.
 */
const PROSE_FENCES: ReadonlySet<string> = new Set([
  '',
  'console',
  'markdown',
  'md',
  'output',
  'plain',
  'plaintext',
  'shell-session',
  'text',
  'txt',
])

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/
const LINK_TARGET = /\]\(\s*([^)\s]+)/g
const BARE_URL = /https?:\/\/[^\s<>"'`)\]]+/g
const ELEMENT = /<([A-Za-z][A-Za-z0-9:_.-]*)([^<>]*)>/g
const ATTRIBUTE = /([:@A-Za-z_][\w:.@-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
const LINE_COMMENT = /(^|\s)(#|\/\/)/

/** Remove every `<!-- … -->` from one line, with `indexOf` so no pattern can backtrack. */
function withoutHtmlComments(line: string): string {
  let out = ''
  let cursor = 0
  for (;;) {
    const open = line.indexOf('<!--', cursor)
    if (open < 0) return out + line.slice(cursor)
    const close = line.indexOf('-->', open + 4)
    out += line.slice(cursor, open)
    if (close < 0) return out
    cursor = close + 3
  }
}

/** One line of code with its trailing `#` or `//` comment removed, trimmed. */
function stripComment(line: string): string {
  const text = withoutHtmlComments(line)
  const comment = LINE_COMMENT.exec(text)
  return (comment === null ? text : text.slice(0, comment.index)).trim()
}

function fenceShape(info: string, lines: readonly string[]): string {
  const language = (info.split(/[\s{]/)[0] ?? '').toLowerCase()
  return PROSE_FENCES.has(language)
    ? `${info}\n${lines.length} lines`
    : `${info}\n${lines.join('\n')}`
}

/** Split a slide into its fenced blocks (as shapes) and the text outside them. */
function splitFences(body: string): { readonly fences: string[]; readonly outside: string } {
  const fences: string[] = []
  const outside: string[] = []
  let open: { char: string; length: number; info: string; lines: string[] } | undefined
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (open === undefined) {
      const match = FENCE_OPEN.exec(line)
      const run = match?.[1]
      const info = match?.[2] ?? ''
      if (run !== undefined && !(run.startsWith('`') && info.includes('`'))) {
        open = { char: run.charAt(0), length: run.length, info: info.trim(), lines: [] }
        outside.push('')
        continue
      }
      outside.push(line)
      continue
    }
    const close = FENCE_CLOSE.exec(line)?.[1]
    if (close !== undefined && close.charAt(0) === open.char && close.length >= open.length) {
      fences.push(fenceShape(open.info, open.lines))
      open = undefined
      continue
    }
    const code = stripComment(line)
    if (code !== '') open.lines.push(code)
  }
  if (open !== undefined) fences.push(fenceShape(open.info, open.lines))
  return { fences, outside: outside.join('\n') }
}

function elementShape(name: string, attributes: string): string {
  const kept: string[] = []
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    const attribute = match[1] ?? ''
    const value = match[2]
    const bound = /^[:@]|^v-/.test(attribute)
    const machinery = bound || MACHINERY_ATTRIBUTES.has(attribute.toLowerCase())
    kept.push(value !== undefined && machinery ? `${attribute}=${value}` : attribute)
  }
  return [name, ...kept].join(' ')
}

/**
 * The slide body without its speaker note — Slidev's rule: the last HTML comment, when it
 * ends the slide. Notes are prose through and through, placeholders included, and their
 * structure is left to `alignContainer`, which can miss a note without costing the body.
 */
function withoutSpeakerNote(body: string): string {
  const trimmed = body.trimEnd()
  if (!trimmed.endsWith('-->')) return body
  const open = trimmed.lastIndexOf('<!--')
  return open < 0 ? body : trimmed.slice(0, open)
}

/**
 * Fingerprint one slide from its body text and the unit keys the extractor gave it.
 * Two slides that are translations of each other should agree on every part.
 */
export function fingerprintParts(body: string, unitKeys: readonly string[]): FingerprintParts {
  const { fences, outside } = splitFences(withoutSpeakerNote(body))
  const spans = findCodeSpans(outside)
  let prose = ''
  let cursor = 0
  for (const span of spans) {
    prose += `${outside.slice(cursor, span.start)} `
    cursor = span.end
  }
  prose += outside.slice(cursor)

  const links = [
    ...[...prose.matchAll(LINK_TARGET)].map((match) => match[1] ?? ''),
    ...[...prose.matchAll(BARE_URL)].map((match) => match[0]),
  ]
  const components = [...prose.matchAll(ELEMENT)].map((match) =>
    elementShape(match[1] ?? '', match[2] ?? ''),
  )
  const join = (values: readonly string[]) => JSON.stringify(values)
  return {
    structure: join([...unitKeys].sort()),
    fences: join(fences),
    // Whitespace inside a span renders as one space (CommonMark), and translators re-wrap.
    code: join(spans.map((span) => span.content.replace(/\s+/g, ' ').trim()).sort()),
    links: join([...new Set(links)].sort()),
    components: join(components),
  }
}

/** Names of the parts on which two fingerprints differ, in declaration order. */
export function differingParts(a: FingerprintParts, b: FingerprintParts): string[] {
  return (Object.keys(a) as (keyof FingerprintParts)[]).filter((part) => a[part] !== b[part])
}

/** A single comparable key for a fingerprint. */
export function fingerprintKey(parts: FingerprintParts): string {
  return JSON.stringify(parts)
}
