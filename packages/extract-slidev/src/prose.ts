/**
 * Locating translatable prose inside one markdown fragment.
 *
 * The parser here is a **locator and nothing else** (ADR 0012): its output is read for
 * `position.*.offset` and then discarded. Nothing is ever serialized back from the tree,
 * which is why a parser bug can only mis-scope a unit — a visible, testable defect — and
 * can never corrupt the protected skeleton around it.
 *
 * ## Unit keys are structural, and carry no prose
 *
 * A key is a path of roles inside the slide: `body/h1-1/l-2/li-3/p-1`. Three properties
 * drive that shape (ADR 0005, spec 001 AS-2/AS-3):
 *
 * - **No prose in the key.** Slugging a heading would make every unit under it change
 *   identity when the heading is reworded, orphaning its translations.
 * - **No container position in the key.** The key is relative to the slide, so moving a
 *   slide to another file or reordering the deck changes nothing.
 * - **Heading path, not a flat ordinal.** Role counters restart inside every heading
 *   scope, so editing one section cannot renumber another.
 *
 * Within a scope the trailing counter is still ordinal, and the residue is bigger than
 * one paragraph: inserting or removing a block re-keys its later siblings in the same
 * heading scope, and inserting a heading — or changing a heading's level — re-keys every
 * later sibling scope *and everything nested under it* (measured: adding one `##` moved
 * four of eight ids in a slide). That is the honest cost of keying content which carries
 * no identity of its own; the alternative, per-paragraph ids in the English source, is
 * exactly the authoring-surface pollution constitution I forbids. It is bounded rather
 * than silent: a re-keyed unit reaches the catalog as a removed id plus an added id, so
 * its translation is lost and re-matched by translation memory, never attached to the
 * wrong English. ADR 0005's amendment of 2026-09-05 records the trade.
 *
 * ## What is prose and what is skeleton
 *
 * Paragraphs, headings, list-item text and table cells become units. Fenced code (any
 * fence character or length, including magic-move), raw HTML, Vue islands, images,
 * thematic breaks and link definitions are skeleton and are never emitted. CommonMark
 * stops parsing markdown inside a raw HTML block, so prose there is handed to the tag
 * scanner in `html.ts` (ADR 0015): its text runs become units and its tags stay
 * skeleton, and whatever prose it cannot extract safely is reported as a coverage gap
 * rather than silently dropped.
 *
 * ## Slidev slot markers are skeleton, and open a key scope
 *
 * `::right::` on a line of its own is not prose: Slidev's slot sugar turns it into
 * `<template v-slot:right>`, and a translated marker moves a column's prose into the
 * wrong slot or off the slide. CommonMark knows nothing about it and reads the line as a
 * paragraph, so the markers are found first, blanked out of the copy the parser sees —
 * which splits a paragraph a marker interrupts exactly where Slidev splits it — and never
 * emitted. Offsets are unchanged by the blanking, so every span still points at the
 * original bytes.
 *
 * Each marker also opens a key scope named after its slot (`body/slot-right/p-1`). The
 * slot name is layout machinery, not prose, and scoping by it means adding a paragraph
 * to the left column does not re-key the right one.
 */

import { isSafeUnitKey } from '@workshop-i18n/core'
import type { Node, Nodes, Parent, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTable } from 'micromark-extension-gfm-table'
import { isSlotMarkerLine, SLOT_MARKER } from './deck.js'
import { type Diagnostic, diagnostic } from './diagnostic.js'
import { locateHtmlBlock, scanHtml, type TextPropTable } from './html.js'
import { stripContinuationPrefix } from './skeleton.js'

/** One located prose span: where it is, what it says, and how to put it back. */
export interface ProseSpan {
  /** Structural key relative to the slide, e.g. `body/h1-1/p-2`. */
  readonly unitKey: string
  /** Inclusive start offset in the whole file. */
  readonly start: number
  /** Exclusive end offset in the whole file. */
  readonly end: number
  /** The translatable text, with the container prefix removed. */
  readonly text: string
  /** Prefix every continuation line of the span carries (`> `, list indentation). */
  readonly continuationPrefix: string
  /** True for a GFM table cell, where a bare `|` in a translation adds a column. */
  readonly cell: boolean
  /**
   * What the span sits in: markdown prose, a text run inside an HTML block, or the value
   * of a declared component prop (ADR 0015). Decides how a translation is spliced back.
   */
  readonly kind: 'markdown' | 'html-text' | 'html-attribute'
  /** For `html-attribute`: the quote delimiting the value, `''` when unquoted. */
  readonly quote: '"' | "'" | ''
}

/** Located prose plus whatever the locator declined to handle. */
export interface ProseLocation {
  readonly spans: readonly ProseSpan[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Which fragment of a slide is being located, and therefore what keys are rooted at. */
export interface ProseOptions {
  /** Inclusive start offset of the fragment in the file. */
  readonly start: number
  /** Exclusive end offset of the fragment in the file. */
  readonly end: number
  /** Root key segment: `body` for the slide, `note` for its speaker note. */
  readonly root: string
  /** Declared component text props, already in Vue-resolved form. Defaults to none. */
  readonly textProps?: TextPropTable
}

/**
 * Scope-aware key generator for one container.
 *
 * Heading scopes nest inside the container; role counters live per scope, so a role
 * ordinal only ever counts its siblings under the same heading.
 */
class KeyCursor {
  private readonly headings: { level: number; segment: string }[] = []
  private readonly counters = new Map<string, number>()

  constructor(private readonly basePath: string) {}

  /** Current scope path: the base plus the open heading segments. */
  scopePath(): string {
    return [this.basePath, ...this.headings.map((heading) => heading.segment)].join('/')
  }

  private bump(scope: string, role: string): number {
    const key = `${scope}/${role}`
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    return next
  }

  /** Key for the next block with `role` in the current scope, e.g. `body/h1-1/p-2`. */
  next(role: string): string {
    const scope = this.scopePath()
    return `${scope}/${role}-${this.bump(scope, role)}`
  }

  /**
   * Key for the next top-level element of an HTML block, `body/h1-1/kw-card.2`. Counted
   * per name in the scope, so the blocks and paragraphs around it do not enter the key.
   */
  nextElement(name: string): string {
    const scope = this.scopePath()
    return `${scope}/${name}.${this.bump(scope, `<${name}`)}`
  }

  /** Key for the next text run at the top of an HTML block, `body/h1-1/t:1`. */
  nextRun(): string {
    const scope = this.scopePath()
    return `${scope}/t:${this.bump(scope, '<#run')}`
  }

  /** Open a heading scope of `level` and return the key of the heading's own text. */
  openHeading(level: number): string {
    while ((this.headings.at(-1)?.level ?? 0) >= level) this.headings.pop()
    const parent = this.scopePath()
    this.headings.push({ level, segment: `h${level}-${this.bump(parent, `h${level}`)}` })
    return `${this.scopePath()}/title`
  }
}

/** The prefix a continuation line inside a container carries before its content. */
const CONTAINER_PREFIX = /^[ \t>]*/

/** A slot name that can be used in a key segment as written. */
const PLAIN_SLOT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/** One slot marker Slidev reads, as fragment-relative offsets of its line content. */
interface SlotMarker {
  readonly start: number
  readonly end: number
  readonly name: string
}

/** Every line of `fragment` touching `[start, end)`, as `[lineStart, lineEnd)` pairs. */
function linesOf(fragment: string, start: number, end: number): readonly [number, number][] {
  const lines: [number, number][] = []
  let lineStart = fragment.lastIndexOf('\n', start - 1) + 1
  while (lineStart < end) {
    const breakIndex = fragment.indexOf('\n', lineStart)
    const lineEnd = breakIndex === -1 ? fragment.length : breakIndex
    lines.push([lineStart, lineEnd])
    lineStart = lineEnd + 1
  }
  return lines
}

/**
 * The slot markers Slidev would read in `tree`.
 *
 * CommonMark has no such construct, so a marker surfaces as a line of a paragraph (or of
 * a setext heading's text). Slidev reads it only at column 0 — where it also interrupts a
 * paragraph and ends a lazily continued list or blockquote — so a line qualifies only when
 * the raw line, not merely its content after a container prefix, matches.
 */
function findSlotMarkers(fragment: string, tree: Parent): readonly SlotMarker[] {
  const markers: SlotMarker[] = []
  const visit = (node: Node): void => {
    if (node.type === 'paragraph' || node.type === 'heading') {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (start === undefined || end === undefined) return
      for (const [lineStart, lineEnd] of linesOf(fragment, start, end)) {
        const line = fragment.slice(lineStart, lineEnd).replace(/\r$/, '')
        const match = SLOT_MARKER.exec(line)
        if (match !== null) {
          markers.push({ start: lineStart, end: lineStart + line.length, name: match[1] ?? '' })
        }
      }
      return
    }
    if (isParent(node)) for (const child of node.children) visit(child)
  }
  visit(tree)
  return markers.sort((a, b) => a.start - b.start)
}

/** `fragment` with every marker line blanked to spaces, so offsets stay put. */
function blankMarkers(fragment: string, markers: readonly SlotMarker[]): string {
  let masked = fragment
  for (const marker of markers) {
    masked =
      masked.slice(0, marker.start) +
      ' '.repeat(marker.end - marker.start) +
      masked.slice(marker.end)
  }
  return masked
}

/**
 * The key segment a slot opens: `slot-<name>` for a plain, first-seen name, otherwise
 * `slot:<ordinal>`. A repeated or awkward name (`::x..y::` would put `..` in a key) still
 * gets a unique, safe segment, and neither spelling can be an HTML element's segment:
 * those are `<name>.<n>`, so a `<slot>` element is `slot.1` and never `slot:1` — the dot
 * form this fallback used to share with it gave two units one identity.
 */
function slotSegment(name: string, ordinal: number, used: Set<string>): string {
  const named = `slot-${name}`
  const segment = PLAIN_SLOT_NAME.test(name) && !used.has(named) ? named : `slot:${ordinal}`
  used.add(segment)
  return segment
}

/** The longest string both `a` and `b` start with. */
function commonPrefix(a: string, b: string): string {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1
  return a.slice(0, length)
}

/**
 * The container prefix every continuation line of `raw` carries.
 *
 * Inside a blockquote or a list item the second and later lines of a paragraph usually
 * begin with `> ` or with the item's indentation — skeleton that must survive a
 * translation wrapping differently from the English. But CommonMark's laziness rule lets
 * any of those lines drop the marker entirely, and the consumer corpus does exactly that:
 * a note bullet wraps once with two spaces and then continues at column 0. So the prefix
 * taken is the *longest common* one, which is the only prefix every line demonstrably has.
 *
 * Re-applying the common prefix is always safe: where it is the full marker the output
 * looks exactly like the English, and where laziness shortened it the composed lines are
 * lazy continuations too — the same paragraph, in the same container.
 */
function containerPrefix(raw: string): string {
  const lines = raw.split('\n')
  let prefix: string | undefined
  for (const line of lines.slice(1)) {
    const found = CONTAINER_PREFIX.exec(line)?.[0] ?? ''
    prefix = prefix === undefined ? found : commonPrefix(prefix, found)
    if (prefix === '') break
  }
  return prefix ?? ''
}

function inlineRange(node: Parent): { start: number; end: number } | undefined {
  const first = node.children.at(0)
  const last = node.children.at(-1)
  const start = first?.position?.start?.offset
  const end = last?.position?.end?.offset
  if (start === undefined || end === undefined || start >= end) return undefined
  return { start, end }
}

function isParent(node: Node): node is Parent {
  return Array.isArray((node as Parent).children)
}

/**
 * True when a span carries text a translator can act on.
 *
 * A paragraph holding only `![](/covers/section-18.webp)`, or a heading that is nothing
 * but an inline-code `rate(http_requests_total[5m])`, has no words in it: emitting either
 * would hand a translator a byte spec 001 FR-005 requires identical in every locale — an
 * image reference, an API identifier — and nothing to translate. Inside a sentence both
 * are different: the sentence is the unit and they ride along literally, which is what
 * FR-004 asks for. So a span needs at least one plain-text node before it becomes one.
 */
function hasTranslatableText(node: Node): boolean {
  if (node.type === 'text') {
    return String((node as { value?: unknown }).value ?? '').trim() !== ''
  }
  if (node.type === 'inlineCode' || node.type === 'image' || node.type === 'imageReference') {
    return false
  }
  return isParent(node) && node.children.some(hasTranslatableText)
}

/**
 * True when a markdown span holds text outside tags, interpolations and comments.
 *
 * CommonMark reads a tag it cannot complete on one line — `<KwCard` with its attributes
 * on the lines below — as paragraph text, so a paragraph can be nothing but a component's
 * opening tag. Handing that to a translator is handing them machinery (ADR 0015).
 */
function hasTextOutsideMarkup(raw: string): boolean {
  return scanHtml(raw).some(
    (token) => token.kind === 'text' && raw.slice(token.start, token.end).trim() !== '',
  )
}

/** No declared text props: the default, because a prop is machinery until declared. */
const NO_TEXT_PROPS: TextPropTable = new Map()

/** A letter anywhere, which is what separates prose from symbols, numbers and markup. */
const LETTER = /\p{L}/u

/**
 * `raw` with the blockquote markers of its continuation lines blanked to spaces, so the
 * HTML scanner reads them as the indentation they are. Offsets are unchanged.
 */
function blankQuotePrefixes(raw: string, prefix: string): string {
  return raw
    .split('\n')
    .map((line, index) =>
      index > 0 && line.startsWith(prefix)
        ? ' '.repeat(prefix.length) + line.slice(prefix.length)
        : line,
    )
    .join('\n')
}

/**
 * The prefix every continuation line of an HTML text run carries. Inside an HTML block
 * indentation is insignificant to the renderer, so it is skeleton exactly like a list
 * item's; inside a blockquote the `>` markers are too.
 */
function runPrefix(raw: string, depth: number): string {
  const prefix = containerPrefix(raw)
  return depth === 0 ? (/^[ \t]*/.exec(prefix)?.[0] ?? '') : prefix
}

class ProseLocator {
  readonly spans: ProseSpan[] = []
  readonly diagnostics: Diagnostic[] = []

  constructor(
    private readonly file: string,
    private readonly base: number,
    private readonly fragment: string,
    private readonly textProps: TextPropTable,
  ) {}

  /** Record one leaf's inline content as a span, unless it holds nothing to translate. */
  private emit(node: Parent, unitKey: string, depth: number, cell = false): void {
    const range = inlineRange(node)
    if (range === undefined) return
    const raw = this.fragment.slice(range.start, range.end)
    if (raw.trim() === '' || !node.children.some(hasTranslatableText)) return
    if (!hasTextOutsideMarkup(raw)) return
    if (this.holdsNestedSlotMarker(raw, range.start, range.end)) return
    const prefix = depth === 0 ? '' : containerPrefix(raw)
    this.spans.push({
      unitKey,
      start: this.base + range.start,
      end: this.base + range.end,
      text: stripContinuationPrefix(raw, prefix),
      continuationPrefix: prefix,
      cell,
      kind: 'markdown',
      quote: '',
    })
  }

  /**
   * True — and reported — when a span carries a marker-shaped line Slidev did not read as
   * a marker at column 0: `> ::right::`, or a marker indented inside a list item. Slidev
   * may still apply its slot sugar there, inside the container, so the line is machinery
   * either way; the paragraph around it stays English rather than risk a translator
   * editing it.
   */
  private holdsNestedSlotMarker(raw: string, start: number, end: number): boolean {
    const lines = raw.split('\n')
    const nested = lines.some((line, index) =>
      isSlotMarkerLine(index === 0 ? line : line.replace(CONTAINER_PREFIX, '')),
    )
    if (!nested) return false
    this.diagnostics.push(
      diagnostic(
        this.file,
        'slot-marker-in-container',
        'warning',
        'a line shaped like a Slidev slot marker ("::name::") sits inside a blockquote, list or indented paragraph; the text around it stays English so the marker cannot be translated — move the marker to column 0 on a line of its own',
        this.base + start,
        this.base + end,
      ),
    )
    return true
  }

  /**
   * Locate the prose runs and declared props of one raw HTML block (ADR 0015), and report
   * whatever prose is left in it that could not be extracted safely.
   */
  private locateHtml(node: Nodes, cursor: KeyCursor, depth: number): void {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (start === undefined || end === undefined) return
    const raw = this.fragment.slice(start, end)
    const quote = depth === 0 ? '' : containerPrefix(raw)
    const scanned = quote.includes('>') ? blankQuotePrefixes(raw, quote) : raw
    const located = locateHtmlBlock(
      scanned,
      { element: (name) => cursor.nextElement(name), run: () => cursor.nextRun() },
      this.textProps,
      isSafeUnitKey,
    )
    for (const span of located.spans) {
      const text = raw.slice(span.start, span.end)
      const prefix = span.kind === 'html-text' ? runPrefix(text, depth) : ''
      this.spans.push({
        unitKey: span.unitKey,
        start: this.base + start + span.start,
        end: this.base + start + span.end,
        text: stripContinuationPrefix(text, prefix),
        continuationPrefix: prefix,
        cell: false,
        kind: span.kind,
        quote: span.quote,
      })
    }
    const leftover = LETTER.test(located.residual)
    const tooDeep = located.tooDeep || located.skippedUnsafeKeys > 0
    if (!leftover && !tooDeep) return
    this.diagnostics.push(
      diagnostic(
        this.file,
        'prose-in-html-block',
        'warning',
        !tooDeep
          ? 'prose inside this HTML block could not be extracted safely — it sits in a comment, behind an unterminated tag, or inside an element that is not scanned — so it stays English; move it into the element text to have it extracted'
          : 'this HTML block nests too deeply for a safe unit identity, so some of its prose stays English; flatten the nesting to have it extracted',
        this.base + start,
        this.base + end,
      ),
    )
  }

  /** Walk the blocks of one container, minting keys from `cursor`. */
  walk(nodes: readonly RootContent[], cursor: KeyCursor, depth: number): void {
    for (const node of nodes) {
      switch (node.type) {
        case 'heading':
          this.emit(node, cursor.openHeading(node.depth), depth)
          break
        case 'paragraph':
          this.emit(node, cursor.next('p'), depth)
          break
        case 'blockquote': {
          const path = cursor.next('bq')
          this.walk(node.children, new KeyCursor(path), depth + 1)
          break
        }
        case 'list': {
          const path = cursor.next('l')
          for (const [index, item] of node.children.entries()) {
            this.walk(item.children, new KeyCursor(`${path}/li-${index + 1}`), depth + 1)
          }
          break
        }
        case 'table': {
          const path = cursor.next('t')
          for (const [rowIndex, row] of node.children.entries()) {
            for (const [cellIndex, cell] of row.children.entries()) {
              this.emit(cell, `${path}/r-${rowIndex + 1}/c-${cellIndex + 1}`, depth + 1, true)
            }
          }
          break
        }
        case 'html':
          this.locateHtml(node, cursor, depth)
          break
        default:
          // Fenced and indented code, thematic breaks, link and footnote definitions,
          // and anything a future parser adds: protected skeleton, copied verbatim.
          if (isParent(node)) this.walk(node.children as RootContent[], cursor, depth)
          break
      }
    }
  }
}

/**
 * Locate the translatable prose in `file` between `options.start` and `options.end`.
 *
 * The fragment is parsed in isolation, which is what Slidev does when it renders a
 * slide, and every reported offset is translated back into the whole file so the caller
 * can splice against the original source.
 */
export function locateProse(file: string, options: ProseOptions): ProseLocation {
  const fragment = file.slice(options.start, options.end)
  const parse = (text: string) =>
    fromMarkdown(text, {
      extensions: [gfmTable()],
      mdastExtensions: [gfmTableFromMarkdown()],
    })
  let tree = parse(fragment)
  const markers = findSlotMarkers(fragment, tree)
  // Parse the blanked copy only to read offsets from; spans still slice the original.
  if (markers.length > 0) tree = parse(blankMarkers(fragment, markers))

  const locator = new ProseLocator(
    file,
    options.start,
    fragment,
    options.textProps ?? NO_TEXT_PROPS,
  )
  const used = new Set<string>()
  let cursor = new KeyCursor(options.root)
  let next = 0
  for (const node of tree.children) {
    const start = node.position?.start?.offset ?? 0
    for (; next < markers.length && (markers[next] as SlotMarker).start < start; next += 1) {
      const segment = slotSegment((markers[next] as SlotMarker).name, next + 1, used)
      cursor = new KeyCursor(`${options.root}/${segment}`)
    }
    locator.walk([node], cursor, 0)
  }
  return { spans: locator.spans, diagnostics: locator.diagnostics }
}
