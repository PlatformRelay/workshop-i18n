/**
 * Locating translatable prose inside one lab Markdown file.
 *
 * The parser here is a **locator and nothing else** (ADR 0012): its output is read for
 * `position.*.offset` and then discarded. Nothing is ever serialized back from the tree,
 * which is why a parser bug can only mis-scope a unit — a visible, testable defect — and
 * can never corrupt the protected skeleton around it.
 *
 * ## Unit keys are structural, and carry no prose
 *
 * A key is a path of roles inside the lab: `body/h1-1/h2-2/l-1/li-3/p-1`. Three
 * properties drive that shape (ADR 0005, spec 001 AS-2/AS-3):
 *
 * - **No prose in the key.** Slugging a heading would make every unit under it change
 *   identity when the heading is reworded, orphaning its translations.
 * - **No file path in the key.** The key is relative to the lab, so moving the file
 *   changes nothing — the identity lives in the file's `labId` marker.
 * - **Heading path, not a flat ordinal.** Role counters restart inside every heading
 *   scope, so editing one step of a lab cannot renumber another.
 *
 * Within a scope the trailing counter is still ordinal: inserting or removing a block
 * re-keys its later siblings in the same heading scope, and inserting a heading re-keys
 * every later sibling scope and everything nested under it. That is the honest cost of
 * keying content which carries no identity of its own; the alternative, per-paragraph
 * ids in the English source, is exactly the authoring-surface pollution constitution I
 * forbids. It is bounded rather than silent: a re-keyed unit reaches the catalog as a
 * removed id plus an added id, so its translation is lost and re-matched by translation
 * memory, never attached to the wrong English.
 *
 * ## What is prose and what is skeleton
 *
 * Paragraphs, headings, list-item text and table cells become units. Fenced code (any
 * fence character or length — which is where every heredoc'd YAML manifest and every
 * `kubectl` one-liner lives), indented code, raw HTML, images, thematic breaks and link
 * definitions are skeleton and are never emitted.
 *
 * ## `<details>` spoilers are the one raw-HTML exception
 *
 * ADR 0012 (consumer) makes `<details><summary>…</summary>` the shape of every lab
 * spoiler, and the corpus carries 278 of them. The tags are skeleton, but the *label* is
 * prose a participant reads — a lab whose every spoiler says "Solution / expected
 * output" in English is not localized. So the inner text of a single-line `<summary>` is
 * located as its own unit and spliced back between the untouched tags. Everything else
 * inside a raw HTML block stays skeleton — CommonMark stops parsing Markdown there — and
 * is reported as a coverage gap rather than silently dropped.
 */

import type { Node, Nodes, Parent, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTable } from 'micromark-extension-gfm-table'
import { type Diagnostic, diagnostic } from './diagnostic.js'
import { type HoleEncoding, stripContinuationPrefix } from './skeleton.js'

/** One located prose span: where it is, what it says, and how to put it back. */
export interface ProseSpan {
  /** Structural key relative to the lab, e.g. `body/h1-1/h2-2/p-1`. */
  readonly unitKey: string
  /** Inclusive start offset in the whole file. */
  readonly start: number
  /** Exclusive end offset in the whole file. */
  readonly end: number
  /** The translatable text, with the container prefix removed. */
  readonly text: string
  /** Prefix every continuation line of the span carries (`> `, list indentation). */
  readonly continuationPrefix: string
  /** How composition puts a translation back into this span. */
  readonly encoding: HoleEncoding
}

/** Located prose plus whatever the locator declined to handle. */
export interface ProseLocation {
  readonly spans: readonly ProseSpan[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Which fragment of a file is being located, and therefore what keys are rooted at. */
export interface ProseOptions {
  /** Inclusive start offset of the fragment in the file. */
  readonly start: number
  /** Exclusive end offset of the fragment in the file. */
  readonly end: number
  /** Root key segment; `body` for a lab. */
  readonly root: string
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
 * any of those lines drop the marker entirely, and the consumer corpus does exactly that.
 * So the prefix taken is the *longest common* one, which is the only prefix every line
 * demonstrably has.
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
 * A paragraph holding only `![](./diagram.png)`, or a heading that is nothing but an
 * inline-code `kubectl get pods -o wide`, has no words in it: emitting either would hand
 * a translator a byte spec 001 FR-005 requires identical in every locale — an image
 * reference, a command — and nothing to translate. Inside a sentence both are different:
 * the sentence is the unit and they ride along literally, which is what FR-004 asks for.
 * So a span needs at least one plain-text node before it becomes one.
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
 * True when a line of a raw HTML block looks like prose a translator should have seen.
 *
 * Deliberately crude: it exists to make a coverage gap visible, not to decide anything.
 * What is left after tags and entities are stripped is text; three or more characters of
 * it means the block holds words.
 *
 * The line is *not* dismissed for starting with `<`. `<p>Trapped prose</p>` starts with a
 * tag and is entirely prose, and a coverage metric that under-reports is worse than no
 * metric at all — it reads as a clean bill of health on the blocks it missed.
 */
function looksLikeProse(line: string): boolean {
  return (
    line
      .replace(/<[^>]*>/g, '')
      .replace(/&[#\w]+;/g, '')
      .trim().length >= 3
  )
}

/**
 * A single-line `<summary>` and its inner text. Restricted to one line on purpose: a
 * spoiler label that wraps would need the surrounding HTML block re-flowed to stay one
 * block, and every one of the consumer corpus's 278 spoilers is written on one line.
 */
const SUMMARY = /<summary(?:\s[^>\n]*)?>([^\n]*?)<\/summary\s*>/dg

/** True when a summary's inner HTML carries words rather than only markup. */
function summaryHasText(inner: string): boolean {
  return (
    inner
      .replace(/<[^>]*>/g, '')
      .replace(/&[#\w]+;/g, ' ')
      .trim() !== ''
  )
}

class ProseLocator {
  readonly spans: ProseSpan[] = []
  readonly diagnostics: Diagnostic[] = []

  constructor(
    private readonly file: string,
    private readonly base: number,
    private readonly fragment: string,
  ) {}

  /** Record one leaf's inline content as a span, unless it holds nothing to translate. */
  private emit(node: Parent, unitKey: string, depth: number): void {
    const range = inlineRange(node)
    if (range === undefined) return
    const raw = this.fragment.slice(range.start, range.end)
    if (raw.trim() === '' || !node.children.some(hasTranslatableText)) return
    const prefix = depth === 0 ? '' : containerPrefix(raw)
    this.spans.push({
      unitKey,
      start: this.base + range.start,
      end: this.base + range.end,
      text: stripContinuationPrefix(raw, prefix),
      continuationPrefix: prefix,
      encoding: { kind: 'markdown', continuationPrefix: prefix },
    })
  }

  /**
   * Handle one raw HTML block: pull out `<summary>` labels, then report whatever prose is
   * left trapped in it.
   */
  private walkHtml(node: Nodes, cursor: KeyCursor): void {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (start === undefined || end === undefined) return
    const path = cursor.next('html')
    const raw = this.fragment.slice(start, end)

    // Blank out each located label before the coverage check, so an extracted summary is
    // not also reported as a gap.
    const residue = raw.split('')
    let index = 0
    for (const match of raw.matchAll(SUMMARY)) {
      const range = match.indices?.[1]
      if (range === undefined) continue
      const [innerStart, innerEnd] = range
      index += 1
      for (let at = innerStart; at < innerEnd; at += 1) residue[at] = ' '
      const inner = raw.slice(innerStart, innerEnd)
      if (!summaryHasText(inner)) continue
      this.spans.push({
        unitKey: `${path}/summary-${index}`,
        start: this.base + start + innerStart,
        end: this.base + start + innerEnd,
        text: inner,
        continuationPrefix: '',
        encoding: { kind: 'html-inline' },
      })
    }

    if (!residue.join('').split('\n').some(looksLikeProse)) return
    this.diagnostics.push(
      diagnostic(
        this.file,
        'prose-in-html-block',
        'warning',
        'prose inside a raw HTML block stays protected skeleton and is not translated; move it out of the block, or into a <summary>, to have it extracted',
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
              this.emit(cell, `${path}/r-${rowIndex + 1}/c-${cellIndex + 1}`, depth + 1)
            }
          }
          break
        }
        case 'html':
          this.walkHtml(node, cursor)
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
 * The fragment is parsed in isolation and every reported offset is translated back into
 * the whole file, so the caller can splice against the original source.
 *
 * ## The byte-order mark is removed before parsing, and paid back afterwards
 *
 * micromark's preprocessor drops a leading U+FEFF, so every offset it reports for a file
 * that starts with a byte-order mark is one code unit short of where the text actually
 * is. `decodeSource` deliberately keeps the mark — it is a byte of the file — so the
 * skew has to be paid here: the mark is sliced off before parsing and added back to the
 * base offset. Left unhandled it shifts every unit in the file by one character, which
 * still round-trips (untranslated holes copy the original bytes) and is therefore
 * invisible to a losslessness assertion — the corpus fixture is what catches it.
 */
export function locateProse(file: string, options: ProseOptions): ProseLocation {
  const raw = file.slice(options.start, options.end)
  const bom = raw.startsWith('﻿') ? 1 : 0
  const fragment = raw.slice(bom)
  const tree = fromMarkdown(fragment, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  })
  const locator = new ProseLocator(file, options.start + bom, fragment)
  locator.walk(tree.children, new KeyCursor(options.root), 0)
  return { spans: locator.spans, diagnostics: locator.diagnostics }
}
