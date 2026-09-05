/**
 * Splitting a Slidev file into slides — a line scan, not a markdown parse.
 *
 * Slidev's own format rules are line-based and have nothing to do with CommonMark, so
 * this is the one place the package reads structure itself rather than asking a parser.
 * The rules it implements, mirroring Slidev's parser:
 *
 * - A **separator** is a line whose content, ignoring trailing whitespace, is exactly
 *   `---`, at column 0.
 * - The first separator of a slide doubles as the **opening delimiter of that slide's
 *   frontmatter** when the line after it is non-blank; the block then runs to the next
 *   separator, which is its closing delimiter and belongs to no slide body.
 * - A file that opens with a separator opens with the deck's headmatter, which is also
 *   the first slide's frontmatter.
 *
 * ## Fences are the reason this cannot be a regex
 *
 * The consumer corpus puts multi-document YAML inside fenced code — `kind: Role`, `---`,
 * `kind: RoleBinding` — and nests three-backtick fences inside four-backtick magic-move
 * fences. A naive `^---$` scan splits a slide in the middle of a code block and destroys
 * it. So the scan tracks fences with CommonMark's rule (a fence is closed only by a run
 * of the same character, at least as long, with no info string), which handles nesting
 * for free: the inner ``` is not long enough to close the outer ````.
 *
 * Indented code blocks are deliberately *not* tracked: Slidev does not track them
 * either, so recognizing them here would make this splitter disagree with the renderer,
 * which is worse than agreeing with it about an unlikely construct.
 *
 * A dash run longer than three (`----`) is where this scan and Slidev's may disagree, so
 * it is reported as a warning rather than guessed at.
 */

import { type Diagnostic, diagnostic } from './diagnostic.js'

/** The `---`-delimited YAML block at the top of a slide. */
export interface FrontmatterBlock {
  /** Offset of the opening delimiter line. */
  readonly start: number
  /** Offset just past the closing delimiter line. */
  readonly end: number
  /** Offset of the first YAML byte (just past the opening delimiter line). */
  readonly bodyStart: number
  /** Offset just past the last YAML byte (the closing delimiter line's start). */
  readonly bodyEnd: number
}

/**
 * One slide's ranges in the source file.
 *
 * `index` is document order, used for reporting only: identity comes from the `slideId`
 * in frontmatter (ADR 0005), never from a position.
 */
export interface SlideRange {
  readonly index: number
  /** Offset where the slide starts: just past its opening separator, or 0. */
  readonly start: number
  /** Offset just past the slide's last byte (the next separator's line start, or EOF). */
  readonly end: number
  readonly frontmatter: FrontmatterBlock | undefined
  /** Offset of the slide's markdown body (just past its frontmatter, if any). */
  readonly bodyStart: number
  /** Offset just past the slide's markdown body. Equal to {@link SlideRange.end}. */
  readonly bodyEnd: number
  /** True for the leading block of the file, which Slidev reads as deck headmatter. */
  readonly isHeadmatter: boolean
}

/** A Slidev file, located. */
export interface SlidevDeck {
  /** The source file, verbatim. */
  readonly source: string
  readonly slides: readonly SlideRange[]
  readonly diagnostics: readonly Diagnostic[]
}

interface Line {
  /** Offset of the line's first byte. */
  readonly start: number
  /** Offset just past the line's break (or EOF). */
  readonly end: number
  /** The line without its break. */
  readonly text: string
}

/** Split `source` into lines, keeping every offset anchored in the original text. */
function scanLines(source: string): readonly Line[] {
  const lines: Line[] = []
  let start = 0
  while (start < source.length) {
    const breakIndex = source.indexOf('\n', start)
    if (breakIndex === -1) {
      lines.push({ start, end: source.length, text: source.slice(start) })
      break
    }
    const text = source.slice(start, breakIndex)
    lines.push({
      start,
      end: breakIndex + 1,
      text: text.endsWith('\r') ? text.slice(0, -1) : text,
    })
    start = breakIndex + 1
  }
  return lines
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const SEPARATOR = /^---[ \t]*$/
const LONGER_DASH_RUN = /^-{4,}[ \t]*$/

/**
 * Strip a leading byte-order mark from the first line only. The mark stays in the
 * source — composition copies it back out — but it must not hide the opening delimiter.
 */
function lineContent(line: Line, index: number): string {
  return index === 0 && line.text.startsWith('﻿') ? line.text.slice(1) : line.text
}

interface OpenFence {
  readonly marker: string
  readonly length: number
}

/**
 * Mark every line that is a slide separator, skipping fenced code.
 *
 * Also collects `ambiguous-separator` warnings: `----` is a line Slidev's own scan may
 * read as a break while this one does not, and a disagreement with the renderer is
 * exactly the kind of thing that must be visible rather than inferred.
 */
function scanSeparators(
  source: string,
  lines: readonly Line[],
  diagnostics: Diagnostic[],
): readonly boolean[] {
  const separators: boolean[] = []
  let fence: OpenFence | undefined
  for (const [index, line] of lines.entries()) {
    const text = lineContent(line, index)
    if (fence !== undefined) {
      separators.push(false)
      const close = FENCE_CLOSE.exec(text)
      const run = close?.[1]
      if (run !== undefined && run[0] === fence.marker && run.length >= fence.length) {
        fence = undefined
      }
      continue
    }
    const open = FENCE_OPEN.exec(text)
    const run = open?.[1]
    if (run !== undefined) {
      // A backtick fence's info string may not contain a backtick (CommonMark 4.5).
      const info = open?.[2] ?? ''
      if (run[0] !== '`' || !info.includes('`')) {
        fence = { marker: run[0] as string, length: run.length }
        separators.push(false)
        continue
      }
    }
    if (SEPARATOR.test(text)) {
      separators.push(true)
      continue
    }
    separators.push(false)
    if (LONGER_DASH_RUN.test(text)) {
      diagnostics.push(
        diagnostic(
          source,
          'ambiguous-separator',
          'warning',
          `line ${index + 1}: a run of more than three dashes is not treated as a slide break here, but Slidev may split the slide at it — use exactly "---"`,
          line.start,
          line.end,
        ),
      )
    }
  }
  return separators
}

/** Locate every slide, its frontmatter block and its markdown body. */
export function parseSlidevDeck(source: string): SlidevDeck {
  const lines = scanLines(source)
  const diagnostics: Diagnostic[] = []
  const separators = scanSeparators(source, lines, diagnostics)
  const slides: SlideRange[] = []

  const nextSeparator = (from: number): number => {
    for (let index = from; index < lines.length; index += 1) {
      if (separators[index] === true) return index
    }
    return -1
  }

  let openSeparator = separators[0] === true ? 0 : -1
  let lineIndex = openSeparator === -1 ? 0 : 1

  for (;;) {
    const openLine = openSeparator === -1 ? undefined : lines[openSeparator]
    const start = openLine === undefined ? 0 : openLine.end
    let frontmatter: FrontmatterBlock | undefined
    let bodyLine = lineIndex

    const first = lines[lineIndex]
    if (openLine !== undefined && first !== undefined && first.text.trim() !== '') {
      const close = nextSeparator(lineIndex)
      if (close === -1) {
        diagnostics.push(
          diagnostic(
            source,
            'unclosed-frontmatter',
            'error',
            `line ${openSeparator + 1}: frontmatter block is never closed by a "---" line; Slidev would read the rest of the file as YAML`,
            openLine.start,
            openLine.end,
          ),
        )
      } else {
        const closeLine = lines[close] as Line
        frontmatter = {
          start: openLine.start,
          end: closeLine.end,
          bodyStart: openLine.end,
          bodyEnd: closeLine.start,
        }
        bodyLine = close + 1
      }
    }

    const next = nextSeparator(bodyLine)
    const bodyStart = lines[bodyLine]?.start ?? source.length
    const end = next === -1 ? source.length : (lines[next] as Line).start
    slides.push({
      index: slides.length,
      start,
      end,
      frontmatter,
      bodyStart,
      bodyEnd: end,
      isHeadmatter: slides.length === 0 && openSeparator === 0,
    })
    if (next === -1) break
    openSeparator = next
    lineIndex = next + 1
  }

  return { source, slides, diagnostics }
}
