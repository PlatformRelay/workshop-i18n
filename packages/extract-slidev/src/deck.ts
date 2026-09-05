/**
 * Splitting a Slidev file into slides — a line scan, not a markdown parse.
 *
 * Slidev's own format rules are line-based and have nothing to do with CommonMark, so
 * this is the one place the package reads structure itself rather than asking a parser.
 * The rules it implements, mirroring Slidev's parser:
 *
 * - A **separator** is a line at column 0 beginning with a run of three or more dashes.
 *   Slidev splits on `----`, on `--- anything`, and therefore on a setext level-two
 *   heading underline; only an exact `---` is reported without a warning.
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
 * ## Where this scan follows Slidev rather than CommonMark
 *
 * The contract is agreement with the renderer, not with the spec, because a splitter
 * that disagrees with Slidev keys prose under a slide the audience never sees. Verified
 * against `@slidev/parser` 52.19.0 (see `slidev-parser-differential.test.ts`):
 *
 * - **Tilde fences do not protect a separator.** Slidev tracks backtick fences only, so
 *   it splits at a bare `---` inside `~~~ … ~~~`, cutting the code block in half. This
 *   scan splits there too — and raises an *error*, because agreeing silently would give
 *   the second rendered slide no identity while `--check` still passed. The file has to
 *   be fixed, not guessed at.
 * - **Any run of three or more dashes splits**, whatever follows it on the line. That
 *   makes a setext level-two underline (`Heading` over `-------`) a slide break, which is
 *   a trap authors fall into, so every separator that is not exactly `---` also raises a
 *   warning saying so.
 * - **Indented code blocks are not tracked**, because Slidev does not track them either.
 * - **A byte-order mark is ignored when matching the first line.** Slidev does not strip
 *   it, so a BOM'd file loses its headmatter there; this scan reads the headmatter and
 *   copies the mark through untouched. A deliberate divergence in the consumer's favour:
 *   the alternative is refusing to see a frontmatter block that is plainly written.
 *
 * One divergence is closed by refusing instead of matching: Slidev accepts `----` or
 * `--- x` as a frontmatter *closing* delimiter, consumes three dashes and leaks the rest
 * of the line into the slide body. Reproducing that would mean starting a body mid-line
 * to preserve a typo's debris, so a closing delimiter that is not exactly `---` is an
 * error instead.
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
/** What Slidev splits on: three or more dashes at column 0, whatever follows them. */
const SEPARATOR = /^-{3,}/
/** What an author almost certainly meant when they wrote one. */
const EXACT_SEPARATOR = /^---[ \t]*$/

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
      const close = FENCE_CLOSE.exec(text)
      const run = close?.[1]
      if (run !== undefined && run[0] === fence.marker && run.length >= fence.length) {
        fence = undefined
        separators.push(false)
        continue
      }
      // Slidev tracks backtick fences only, so inside a tilde fence it splits here.
      if (fence.marker === '~' && SEPARATOR.test(text)) {
        separators.push(true)
        diagnostics.push(
          diagnostic(
            source,
            'separator-in-tilde-fence',
            'error',
            'Slidev splits the slide at this "---" because it does not track tilde fences, cutting the code block in half — use a backtick fence, or indent the "---"',
            line.start,
            line.end,
          ),
        )
        continue
      }
      separators.push(false)
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
      if (!EXACT_SEPARATOR.test(text)) {
        diagnostics.push(
          diagnostic(
            source,
            'ambiguous-separator',
            'warning',
            'Slidev splits the slide at this line because it starts with three or more dashes; if it was meant as a setext heading underline or a horizontal rule, it is not one — use exactly "---" to break a slide, or "***" for a rule',
            line.start,
            line.end,
          ),
        )
      }
      continue
    }
    separators.push(false)
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
            'frontmatter block is never closed by a "---" line; Slidev would read the rest of the file as YAML',
            openLine.start,
            openLine.end,
          ),
        )
      } else {
        const closeLine = lines[close] as Line
        if (!EXACT_SEPARATOR.test(lineContent(closeLine, close))) {
          diagnostics.push(
            diagnostic(
              source,
              'malformed-frontmatter',
              'error',
              'frontmatter block is closed by a line that is not exactly "---"; Slidev consumes three dashes here and leaks the rest of the line into the slide',
              closeLine.start,
              closeLine.end,
            ),
          )
        }
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

/** An HTML-comment speaker note, and the prose range inside it. */
export interface SpeakerNote {
  /** Offset of the opening `<!--`. */
  readonly start: number
  /** Offset just past the closing `-->`. */
  readonly end: number
  /** Offset of the first byte inside the comment. */
  readonly innerStart: number
  /** Offset just past the last byte inside the comment. */
  readonly innerEnd: number
}

/**
 * Find a slide's speaker note: the HTML comment that ends the slide.
 *
 * Slidev renders the trailing comment of a slide as the presenter note, so that is the
 * one comment whose prose is content rather than an author aside. The scan reuses the
 * fence tracking above, because a `<!--` inside a fenced block is code — the deck shows
 * HTML comments inside its own examples — and it requires the opener to be the first
 * thing on its line, so an inline `` `<!--` `` in prose cannot open one.
 *
 * Earlier comments in the slide are left alone; the prose locator reports them as
 * untranslated HTML blocks, which is the right answer for an aside.
 */
export function findSpeakerNote(
  source: string,
  start: number,
  end: number,
): SpeakerNote | undefined {
  const fragment = source.slice(start, end)
  const lines = scanLines(fragment)
  let fence: OpenFence | undefined
  let open: number | undefined
  let last: SpeakerNote | undefined

  for (const [index, line] of lines.entries()) {
    const text = lineContent(line, index)
    if (open === undefined) {
      if (fence !== undefined) {
        const close = FENCE_CLOSE.exec(text)
        const run = close?.[1]
        if (run !== undefined && run[0] === fence.marker && run.length >= fence.length) {
          fence = undefined
        }
        continue
      }
      const opened = FENCE_OPEN.exec(text)
      const run = opened?.[1]
      if (run !== undefined && (run[0] !== '`' || !(opened?.[2] ?? '').includes('`'))) {
        fence = { marker: run[0] as string, length: run.length }
        continue
      }
      if (text.trimStart().startsWith('<!--')) {
        open = line.start + text.indexOf('<!--')
      } else {
        continue
      }
    }
    const searchFrom = Math.max(open + 4, line.start)
    const closeIndex = fragment.indexOf('-->', searchFrom)
    if (closeIndex === -1 || closeIndex >= line.end) continue
    last = {
      start: start + open,
      end: start + closeIndex + 3,
      innerStart: start + open + 4,
      innerEnd: start + closeIndex,
    }
    open = undefined
  }

  if (last === undefined) return undefined
  // Only a comment that ends the slide is the note; anything after it is content.
  return source.slice(last.end, end).trim() === '' ? last : undefined
}
