/**
 * Locating prose inside a raw HTML block or Vue island (ADR 0015).
 *
 * CommonMark stops parsing markdown inside an HTML block, and the consumer deck writes most
 * of its prose there — inside `<KwCard>`, `<CodeNote>` and the `<div>` grids around them. So
 * this module reads the block with a small tag scanner and finds the **runs** of prose in
 * it. Like the markdown parser in `prose.ts` it is a locator and nothing else: it reports
 * offsets, and nothing is ever rebuilt from what it read (ADR 0012). A scanning mistake
 * can mis-scope a unit; it cannot move a byte outside one.
 *
 * ## Runs, boundaries and what rides along
 *
 * A run is a maximal sequence of sibling text, `{{ }}` interpolations and *inline-safe*
 * elements — standard HTML phrasing elements (`strong`, `code`, `span`, …) that are closed
 * inside the block, carry no Vue directive, binding, event or slot attribute, and hold only
 * inline-safe content. Those ride along literally, as inline markup does in a markdown
 * paragraph (ADR 0004), and composition refuses a translation that edits them. Everything
 * else — components, block elements, comments, anything with a directive — is a boundary:
 * its tags are never in a unit, and its contents are scanned for runs of their own.
 *
 * ## Keys
 *
 * An element is `<name>.<n>` (`kw-card.2`), counted per parent and per name; a run is
 * `t:<n>` among its parent's runs; a declared prop is `prop:<name>`. Element names are
 * reduced to `[a-z0-9-]`, so `.` and `:` appear only where this scheme puts them and the
 * three shapes can never collide with each other or with a markdown role such as `p-1`.
 */

import { componentNameKey } from '@workshop-i18n/core'
import { isSlotMarkerLine } from './deck.js'

/** One attribute of an opening tag. Offsets are into the scanned text. */
export interface HtmlAttribute {
  /** The name as written, e.g. `heading`, `:kind`, `v-click`. */
  readonly name: string
  /** Start of the value, quotes excluded; `-1` for a bare attribute. */
  readonly valueStart: number
  /** End of the value, quotes excluded; `-1` for a bare attribute. */
  readonly valueEnd: number
  readonly quote: '"' | "'" | ''
}

/** One token of an HTML block. Tokens are contiguous and cover every byte exactly once. */
export type HtmlToken =
  | { readonly kind: 'text'; readonly start: number; readonly end: number }
  | { readonly kind: 'interpolation'; readonly start: number; readonly end: number }
  | { readonly kind: 'comment'; readonly start: number; readonly end: number }
  /** CDATA, a doctype or processing instruction, raw-text contents, or an unterminated tail. */
  | { readonly kind: 'opaque'; readonly start: number; readonly end: number }
  | {
      readonly kind: 'open'
      readonly start: number
      readonly end: number
      readonly name: string
      readonly attributes: readonly HtmlAttribute[]
      readonly selfClosing: boolean
    }
  | { readonly kind: 'close'; readonly start: number; readonly end: number; readonly name: string }

/**
 * A tag name as Vue's tokenizer reads one: a letter, then anything up to whitespace, `/`
 * or `>`. So `<x_y>`, `<Foo.Bar>`, `<svg:a>` and `<a"b>` are all elements — reading them
 * with a narrower grammar once let a translation compile to a live `v-html`.
 */
const TAG_NAME = /[A-Za-z][^\s/>]*/y
const WHITESPACE = /\s/

/** Elements whose contents the HTML tokenizer reads as raw text, not markup. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

/** Elements that never have contents or a closing tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/**
 * Standard HTML phrasing elements that may ride along inside a run. `img` is phrasing too
 * but is left out on purpose: its `src` is an asset reference FR-005 keeps out of units.
 */
const PHRASING = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
])

/** Elements whose text is code, not prose: it rides along in a run but never makes one. */
const CODE_LIKE = new Set(['code', 'kbd', 'samp', 'var', 'pre', 'script', 'style', 'textarea'])

/** Elements whose contents are never scanned for runs; any prose in them is reported. */
const NOT_SCANNED = new Set(['svg', 'math'])

function readTagName(text: string, at: number): string | undefined {
  TAG_NAME.lastIndex = at
  const match = TAG_NAME.exec(text)
  if (match === null) return undefined
  const after = text.charAt(at + match[0].length)
  // At the very end of the text a `<name` opens nothing: there is no tag to terminate.
  return WHITESPACE.test(after) || after === '/' || after === '>' ? match[0] : undefined
}

/**
 * Parse the attributes of an opening tag whose name ends at `at`. Returns the offset just
 * past the closing `>`, or `undefined` when the tag is never terminated.
 */
function readAttributes(
  text: string,
  at: number,
  attributes: HtmlAttribute[],
): { end: number; selfClosing: boolean } | undefined {
  let cursor = at
  for (;;) {
    while (cursor < text.length && WHITESPACE.test(text.charAt(cursor))) cursor += 1
    if (cursor >= text.length) return undefined
    if (text.startsWith('/>', cursor)) return { end: cursor + 2, selfClosing: true }
    if (text.charAt(cursor) === '>') return { end: cursor + 1, selfClosing: false }
    if (text.charAt(cursor) === '/') {
      cursor += 1
      continue
    }
    const nameStart = cursor
    while (cursor < text.length && !/[\s/>=]/.test(text.charAt(cursor))) cursor += 1
    const name = text.slice(nameStart, cursor)
    let valueCursor = cursor
    while (valueCursor < text.length && WHITESPACE.test(text.charAt(valueCursor))) valueCursor += 1
    if (text.charAt(valueCursor) !== '=') {
      attributes.push({ name, valueStart: -1, valueEnd: -1, quote: '' })
      continue
    }
    valueCursor += 1
    while (valueCursor < text.length && WHITESPACE.test(text.charAt(valueCursor))) valueCursor += 1
    const quote = text.charAt(valueCursor)
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, valueCursor + 1)
      if (close === -1) return undefined
      attributes.push({ name, valueStart: valueCursor + 1, valueEnd: close, quote })
      cursor = close + 1
      continue
    }
    const valueStart = valueCursor
    while (valueCursor < text.length && !/[\s>]/.test(text.charAt(valueCursor))) valueCursor += 1
    attributes.push({ name, valueStart, valueEnd: valueCursor, quote: '' })
    cursor = valueCursor
  }
}

/**
 * Tokenize `text` the way an HTML (and Vue template) tokenizer reads it, tolerating
 * anything malformed by making it opaque rather than guessing.
 */
export function scanHtml(text: string): readonly HtmlToken[] {
  const tokens: HtmlToken[] = []
  let textStart = -1
  const flushText = (end: number): void => {
    if (textStart !== -1 && textStart < end) tokens.push({ kind: 'text', start: textStart, end })
    textStart = -1
  }
  const opaqueUntil = (start: number, terminator: string): number => {
    const found = text.indexOf(terminator, start)
    return found === -1 ? text.length : found + terminator.length
  }

  let cursor = 0
  while (cursor < text.length) {
    if (text.startsWith('<!--', cursor)) {
      flushText(cursor)
      const end = opaqueUntil(cursor + 4, '-->')
      tokens.push({ kind: 'comment', start: cursor, end })
      cursor = end
      continue
    }
    if (text.startsWith('{{', cursor)) {
      flushText(cursor)
      const close = text.indexOf('}}', cursor + 2)
      const end = close === -1 ? text.length : close + 2
      tokens.push({ kind: close === -1 ? 'opaque' : 'interpolation', start: cursor, end })
      cursor = end
      continue
    }
    if (text.startsWith('<![CDATA[', cursor)) {
      flushText(cursor)
      const end = opaqueUntil(cursor + 9, ']]>')
      tokens.push({ kind: 'opaque', start: cursor, end })
      cursor = end
      continue
    }
    if (text.startsWith('<!', cursor) || text.startsWith('<?', cursor)) {
      flushText(cursor)
      const end = opaqueUntil(cursor + 2, '>')
      tokens.push({ kind: 'opaque', start: cursor, end })
      cursor = end
      continue
    }
    if (text.startsWith('</', cursor)) {
      const name = readTagName(text, cursor + 2)
      if (name !== undefined) {
        flushText(cursor)
        const close = text.indexOf('>', cursor + 2 + name.length)
        const end = close === -1 ? text.length : close + 1
        tokens.push(
          close === -1
            ? { kind: 'opaque', start: cursor, end }
            : { kind: 'close', start: cursor, end, name },
        )
        cursor = end
        continue
      }
      // `</` not followed by a letter is a bogus comment to the HTML tokenizer Vue follows:
      // it runs to the next `>` and is never text.
      flushText(cursor)
      const end = opaqueUntil(cursor + 2, '>')
      tokens.push({ kind: 'opaque', start: cursor, end })
      cursor = end
      continue
    } else if (text.charAt(cursor) === '<') {
      const name = readTagName(text, cursor + 1)
      if (name !== undefined) {
        flushText(cursor)
        const attributes: HtmlAttribute[] = []
        const read = readAttributes(text, cursor + 1 + name.length, attributes)
        if (read === undefined) {
          tokens.push({ kind: 'opaque', start: cursor, end: text.length })
          cursor = text.length
          continue
        }
        tokens.push({
          kind: 'open',
          start: cursor,
          end: read.end,
          name,
          attributes,
          selfClosing: read.selfClosing,
        })
        cursor = read.end
        if (RAW_TEXT.has(name.toLowerCase()) && !read.selfClosing) {
          // Searched from the cursor, case-insensitively: lower-casing the whole text once
          // per element made a block of many small scripts quadratic.
          const closer = new RegExp(`</${name.toLowerCase()}`, 'gi')
          closer.lastIndex = cursor
          const closeAt = closer.exec(text)?.index ?? -1
          const contentEnd = closeAt === -1 ? text.length : closeAt
          if (contentEnd > cursor) tokens.push({ kind: 'opaque', start: cursor, end: contentEnd })
          cursor = contentEnd
        }
        continue
      }
    }
    if (textStart === -1) textStart = cursor
    cursor += 1
  }
  flushText(text.length)
  return tokens
}

/**
 * The markup a translation of `text` must keep: every tag, interpolation and opaque token,
 * as written, in document order. Comments are left to the delimiter guard, which already
 * requires every `<!--` and `-->` to survive.
 */
export function markupTokens(text: string): readonly string[] {
  return scanHtml(text)
    .filter((token) => token.kind !== 'text' && token.kind !== 'comment')
    .map((token) => text.slice(token.start, token.end))
}

/**
 * Every place in `text` where Vue, or a markdown renderer ahead of it, *could* start
 * reading markup — read coarsely, on purpose.
 *
 * The precise scanner above decides what the locator extracts; it must never be what
 * decides what composition lets through. A renderer-independent over-approximation does:
 * every `<` not followed by whitespace (with everything up to the next `>`, or to the end
 * when there is none), every `{{` (up to its `}}`), and every `}}`. A translation must
 * carry exactly these tokens of its English, so anything it adds that a renderer might
 * treat as a tag, a closer, a bogus comment or an interpolation is refused — whether or
 * not this package's own scanner would have recognised it. A false positive costs an
 * English fallback; a false negative costs code execution in the deck.
 */
export function coarseMarkup(text: string): readonly string[] {
  // Next `>` and next `}}` at or after each offset, computed once so this stays linear.
  const nextGreater = new Int32Array(text.length + 1).fill(-1)
  const nextClose = new Int32Array(text.length + 1).fill(-1)
  for (let index = text.length - 1; index >= 0; index -= 1) {
    nextGreater[index] = text.charAt(index) === '>' ? index : (nextGreater[index + 1] ?? -1)
    nextClose[index] = text.startsWith('}}', index) ? index : (nextClose[index + 1] ?? -1)
  }
  const tokens: string[] = []
  for (let index = 0; index < text.length; index += 1) {
    // A comment's words are nobody's markup and may be translated; its delimiters are
    // counted here and, in context, by composition's comment guard.
    if (text.startsWith('<!--', index)) {
      tokens.push('<!--')
      const close = text.indexOf('-->', index + 4)
      if (close === -1) break
      tokens.push('-->')
      index = close + 2
      continue
    }
    // A `<` at the very end counts too: what follows it is the skeleton it lands against.
    if (text.charAt(index) === '<' && !WHITESPACE.test(text.charAt(index + 1) || 'x')) {
      const close = nextGreater[index + 1] ?? -1
      tokens.push(text.slice(index, close === -1 ? text.length : close + 1))
    }
    if (text.startsWith('{{', index)) {
      const close = nextClose[index + 2] ?? -1
      tokens.push(text.slice(index, close === -1 ? text.length : close + 2))
    }
    if (text.startsWith('}}', index)) tokens.push('}}')
  }
  return tokens
}

/**
 * True when every opening tag in `text` is closed, in order, by a matching closing tag —
 * void and self-closing elements aside. A translation may move markup, but a closing tag
 * ahead of its opener is a template Vue refuses to compile, which fails the whole deck.
 */
export function isWellNested(text: string): boolean {
  const open: string[] = []
  for (const token of scanHtml(text)) {
    if (token.kind === 'open') {
      if (!token.selfClosing && !VOID.has(token.name.toLowerCase())) {
        open.push(componentNameKey(token.name))
      }
    } else if (token.kind === 'close') {
      if (open.pop() !== componentNameKey(token.name)) return false
    }
  }
  return open.length === 0
}

// ---------------------------------------------------------------------------------------
// The element tree and the run locator.

interface ElementNode {
  readonly kind: 'element'
  readonly open: Extract<HtmlToken, { kind: 'open' }>
  /** Vue-resolved name, e.g. `kw-card` for `<KwCard>`. */
  readonly name: string
  readonly children: HtmlNode[]
  closed: boolean
  /** Offset just past the closing tag, once one is found. */
  closeEnd: number | undefined
}

type HtmlNode = ElementNode | Exclude<HtmlToken, { kind: 'open' }>

function isDirective(attribute: HtmlAttribute): boolean {
  return /^(?:v-|:|@|#)/.test(attribute.name)
}

/**
 * Deepest element nesting the locator walks. A unit key under it would pass the identity
 * limit long before, and every walk below is recursive, so a block nested deeper is left
 * as skeleton and reported rather than allowed to overflow the stack.
 */
const MAX_HTML_DEPTH = 48

/**
 * Build the element tree; unclosed elements end with the block, stray closers stay tokens.
 * Returns `undefined` for a block nested deeper than {@link MAX_HTML_DEPTH}.
 */
function buildTree(tokens: readonly HtmlToken[]): HtmlNode[] | undefined {
  const root: HtmlNode[] = []
  const stack: ElementNode[] = []
  const append = (node: HtmlNode): void => {
    ;(stack.at(-1)?.children ?? root).push(node)
  }
  for (const token of tokens) {
    if (token.kind === 'open') {
      const element: ElementNode = {
        kind: 'element',
        open: token,
        name: componentNameKey(token.name),
        children: [],
        closed: token.selfClosing || VOID.has(token.name.toLowerCase()),
        closeEnd: undefined,
      }
      append(element)
      if (!element.closed) stack.push(element)
      if (stack.length > MAX_HTML_DEPTH) return undefined
      continue
    }
    if (token.kind === 'close') {
      const name = componentNameKey(token.name)
      const index = stack.findLastIndex((element) => element.name === name)
      if (index !== -1) {
        const element = stack[index] as ElementNode
        element.closed = true
        element.closeEnd = token.end
        stack.length = index
        continue
      }
    }
    append(token)
  }
  return root
}

function isInlineSafe(node: HtmlNode): boolean {
  if (node.kind === 'text' || node.kind === 'interpolation') return true
  if (node.kind !== 'element') return false
  const tag = node.open.name
  return (
    PHRASING.has(tag) &&
    node.closed &&
    !node.open.attributes.some(isDirective) &&
    node.children.every(isInlineSafe)
  )
}

function nodeStart(node: HtmlNode): number {
  return node.kind === 'element' ? node.open.start : node.start
}

/** Offset just past a node: its closing tag, or its last descendant when it never closes. */
function nodeEnd(node: HtmlNode): number {
  if (node.kind !== 'element') return node.end
  if (node.closeEnd !== undefined) return node.closeEnd
  const last = node.children.at(-1)
  return last === undefined ? node.open.end : nodeEnd(last)
}

const LETTER = /\p{L}/u

/** True when a run carries a letter outside code-like elements and interpolations. */
function hasProse(node: HtmlNode, text: string): boolean {
  if (node.kind === 'text') return LETTER.test(text.slice(node.start, node.end))
  if (node.kind !== 'element' || CODE_LIKE.has(node.open.name.toLowerCase())) return false
  return node.children.some((child) => hasProse(child, text))
}

/** Where a located run or prop sits and how to put it back. */
export interface HtmlSpan {
  readonly unitKey: string
  /** Offsets into the scanned text. */
  readonly start: number
  readonly end: number
  readonly kind: 'html-text' | 'html-attribute'
  /** For an attribute: the quote that delimits the value, `''` when unquoted. */
  readonly quote: '"' | "'" | ''
}

/** Mints keys for the nodes at the top of a block, which count in the enclosing scope. */
export interface BlockKeys {
  element(name: string): string
  run(): string
}

/** Declared text props: Vue-resolved component name to Vue-resolved prop names. */
export type TextPropTable = ReadonlyMap<string, ReadonlySet<string>>

/** Everything one HTML block yielded. */
export interface HtmlBlockLocation {
  readonly spans: readonly HtmlSpan[]
  /** Ranges blanked from the residual check because they were located or are markup. */
  readonly residual: string
  /** Units that were skipped because their key would be unsafe. */
  readonly skippedUnsafeKeys: number
  /** True when the block nests too deeply to walk; nothing in it was located. */
  readonly tooDeep: boolean
}

/** A key segment for a name: Vue's hyphenated form, reduced to `[a-z0-9-]`. */
function segmentName(name: string): string {
  return name.replace(/[^a-z0-9-]/g, '-')
}

class LocalKeys implements BlockKeys {
  private readonly counters = new Map<string, number>()
  private runs = 0

  constructor(private readonly path: string) {}

  element(name: string): string {
    const next = (this.counters.get(name) ?? 0) + 1
    this.counters.set(name, next)
    return `${this.path}/${name}.${next}`
  }

  run(): string {
    this.runs += 1
    return `${this.path}/t:${this.runs}`
  }
}

/**
 * Locate the prose runs and declared text props of one HTML block.
 *
 * `text` is the block's source (with any container prefix already blanked), and every
 * offset returned is into it. `isSafeKey` is the identity gate: a unit whose key it
 * refuses is skipped and counted, never emitted, so a pathologically deep island cannot
 * turn into a fatal unsafe identity.
 */
export function locateHtmlBlock(
  text: string,
  keys: BlockKeys,
  textProps: TextPropTable,
  isSafeKey: (key: string) => boolean,
): HtmlBlockLocation {
  const tree = buildTree(scanHtml(text))
  if (tree === undefined) {
    const residual = scanHtml(text)
      .filter((token) => token.kind === 'text')
      .map((token) => text.slice(token.start, token.end))
      .join(' ')
    return { spans: [], residual, skippedUnsafeKeys: 0, tooDeep: true }
  }
  const spans: HtmlSpan[] = []
  const blank = new Uint8Array(text.length)
  const blankRange = (start: number, end: number): void => {
    blank.fill(1, start, end)
  }
  let skippedUnsafeKeys = 0

  const emitRun = (group: readonly HtmlNode[], counter: BlockKeys): void => {
    if (!group.some((node) => hasProse(node, text))) return
    let start = nodeStart(group[0] as HtmlNode)
    let end = nodeEnd(group.at(-1) as HtmlNode)
    while (start < end && WHITESPACE.test(text.charAt(start))) start += 1
    while (end > start && WHITESPACE.test(text.charAt(end - 1))) end -= 1
    const raw = text.slice(start, end)
    // A blank line would already have ended the block; a marker-shaped line is layout.
    if (/\n[ \t]*\r?\n/.test(raw) || raw.split('\n').some(isSlotMarkerLine)) return
    const unitKey = counter.run()
    if (!isSafeKey(unitKey)) {
      skippedUnsafeKeys += 1
      return
    }
    spans.push({ unitKey, start, end, kind: 'html-text', quote: '' })
    blankRange(start, end)
  }

  const emitProps = (element: ElementNode, path: string): void => {
    const declared = textProps.get(element.name)
    if (declared === undefined) return
    const seen = new Set<string>()
    for (const attribute of element.open.attributes) {
      const prop = componentNameKey(attribute.name)
      if (isDirective(attribute) || !declared.has(prop) || seen.has(prop)) continue
      seen.add(prop)
      if (attribute.valueStart < 0) continue
      const value = text.slice(attribute.valueStart, attribute.valueEnd)
      if (!LETTER.test(value)) continue
      const unitKey = `${path}/prop:${segmentName(prop)}`
      if (!isSafeKey(unitKey)) {
        skippedUnsafeKeys += 1
        continue
      }
      spans.push({
        unitKey,
        start: attribute.valueStart,
        end: attribute.valueEnd,
        kind: 'html-attribute',
        quote: attribute.quote,
      })
    }
  }

  const walk = (nodes: readonly HtmlNode[], counter: BlockKeys): void => {
    let group: HtmlNode[] = []
    const flush = (): void => {
      if (group.length > 0) emitRun(group, counter)
      group = []
    }
    for (const node of nodes) {
      if (isInlineSafe(node)) {
        group.push(node)
        continue
      }
      flush()
      if (node.kind !== 'element') continue
      const path = counter.element(segmentName(node.name))
      emitProps(node, path)
      const tag = node.open.name.toLowerCase()
      if (CODE_LIKE.has(tag) || NOT_SCANNED.has(tag)) continue
      walk(node.children, new LocalKeys(path))
    }
    flush()
  }
  walk(tree, keys)

  // Code is not prose wherever it sits, inside a run or not.
  const blankCode = (nodes: readonly HtmlNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'element') continue
      if (CODE_LIKE.has(node.open.name.toLowerCase())) blankRange(node.open.end, nodeEnd(node))
      else blankCode(node.children)
    }
  }
  blankCode(tree)

  // What is left once located runs, markup and code are blanked is prose nobody extracted.
  for (const token of scanHtml(text)) {
    if (token.kind === 'open' || token.kind === 'close' || token.kind === 'interpolation') {
      blankRange(token.start, token.end)
    }
  }
  // `split('')` yields UTF-16 code units, which is what the offsets index.
  const residual = text
    .split('')
    .map((unit, index) => (blank[index] === 1 ? ' ' : unit))
    .join('')
  return {
    spans,
    residual: residual.replace(/&[#\w]+;/g, ' '),
    skippedUnsafeKeys,
    tooDeep: false,
  }
}
