/**
 * Splitting a Slidev file into slides — a line scan, not a markdown parse.
 *
 * Slidev's format rules are line-based and have nothing to do with CommonMark, so this
 * is the one place the package reads structure itself rather than asking a parser.
 *
 * ## This is a transcription, not an approximation
 *
 * The contract is **agreement with the renderer**: a splitter that disagrees with Slidev
 * keys prose under a slide the audience never sees, mints identities for slides that do
 * not exist, and lets `init-ids` write into content that is really a speaker note — all
 * while `--check` passes. Approximating those rules from observed behaviour was tried
 * and failed twice, because a divergence is only observable on input that exercises it.
 *
 * So the loop below is a line-for-line transcription of `@slidev/parser` 52.19.0's own
 * scanner (`dist/core.mjs`, the loop at the end of `parse`, plus its
 * `advanceHtmlCommentState`), with byte offsets recorded alongside. Its rules, in the
 * order the scanner applies them:
 *
 * 1. **Inside an HTML comment, nothing else is looked at.** Comment state carries across
 *    lines for the whole file, so a `---` inside a speaker note is not a slide break.
 * 2. **A separator** is a line whose trailing whitespace is trimmed and which then
 *    starts with `---`. Leading whitespace is *not* trimmed, so ` ---` is content.
 * 3. **A separator opens a frontmatter block** only when its fourth character is not a
 *    dash and the next line is non-blank. `----` splits without opening a block; `--- x`
 *    opens one. The block closes at the next line that is *exactly* `---`.
 * 4. **A fence** is a line that starts with ``` after leading whitespace is trimmed. The
 *    fence level is the leading whitespace *plus* the backtick run, and the fence closes
 *    at the next line starting with that same string — so ```` ```md ```` is closed by
 *    ```` ```ts ````, and indentation beyond three spaces still counts. If no closing
 *    line exists the scanner resumes on the next line rather than swallowing the file.
 *    Tilde runs are not fences to Slidev at all.
 * 5. **Lines are `markdown.split(/\r?\n/)`**, so a file ending in a line break has a
 *    final empty line — which is why a trailing `---\n` yields an empty last slide and a
 *    trailing `---` with no newline yields none.
 *
 * ## The two places this deliberately does not match, and why
 *
 * Both are refusals, never silent divergence, and both are because matching would mean
 * reproducing a bug rather than a behaviour:
 *
 * - **A `---` inside a tilde-fenced block.** Slidev splits there, cutting the code block
 *   in half; this scan splits identically so identities land where the renderer puts
 *   them, and raises an *error*, because the second rendered slide would otherwise have
 *   no identity at all while `--check` passed.
 * - **A column-0 dash run that is not exactly `---` inside a frontmatter block.** Slidev
 *   consumes three dashes and leaks the rest of the line into the slide; reproducing
 *   that means starting a body mid-line to preserve a typo's debris.
 *
 * One divergence is in the consumer's favour and is documented rather than refused: a
 * byte-order mark is ignored when matching the first line. Slidev does not strip it, so
 * a BOM'd file loses its headmatter; this scan reads the headmatter and copies the mark
 * through untouched.
 *
 * `slidev-parser-differential.test.ts` re-derives every one of these from the real
 * parser when it is available.
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
  /**
   * The separator line that opened this slide, or `undefined` for the first slide of a
   * file that does not begin with one. Callers that want to *write* a frontmatter block
   * need it: Slidev only opens a block after a separator whose fourth character is not a
   * dash, so a block cannot be inserted after `----`.
   */
  readonly separator: { readonly start: number; readonly end: number } | undefined
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
  /** The line without its break — Slidev's `rawLine`. */
  readonly text: string
}

/**
 * Split `source` the way Slidev does (`markdown.split(/\r?\n/)`), keeping every offset
 * anchored in the original text.
 *
 * The trailing empty line a final break produces is deliberately kept: Slidev's decision
 * to emit a last slide depends on it, so dropping it would invent or lose a slide.
 */
function scanLines(source: string): readonly Line[] {
  const lines: Line[] = []
  let start = 0
  for (;;) {
    const breakIndex = source.indexOf('\n', start)
    if (breakIndex === -1) {
      lines.push({ start, end: source.length, text: source.slice(start) })
      return lines
    }
    const text = source.slice(start, breakIndex)
    lines.push({
      start,
      end: breakIndex + 1,
      text: text.endsWith('\r') ? text.slice(0, -1) : text,
    })
    start = breakIndex + 1
  }
}

/** Slidev's `RE_LEADING_BACKTICKS`: the fence level includes its own indentation. */
const LEADING_BACKTICKS = /^\s*`+/
/** A tilde run, tracked for diagnostics only — Slidev does not treat these as fences. */
const LEADING_TILDES = /^\s*~{3,}/
/** What an author almost certainly meant when they wrote a separator. */
const EXACT_SEPARATOR = /^---[ \t]*$/
/** A column-0 dash run, which is what Slidev's `startsWith("---")` accepts. */
const DASH_RUN = /^-{3,}/

/**
 * Strip a leading byte-order mark from the first line only. The mark stays in the
 * source — composition copies it back out — but it must not hide the opening delimiter.
 */
function lineContent(line: Line, index: number): string {
  return index === 0 && line.text.startsWith('﻿') ? line.text.slice(1) : line.text
}

/**
 * Slidev's `advanceHtmlCommentState`: return whether the line ends inside a comment.
 *
 * Transcribed rather than approximated because it is what makes a `---` inside a speaker
 * note harmless, and because it handles several comments on one line.
 */
function advanceHtmlCommentState(line: string, inHtmlComment: boolean): boolean {
  let cursor = 0
  let inside = inHtmlComment
  while (cursor < line.length) {
    if (inside) {
      const end = line.indexOf('-->', cursor)
      if (end < 0) return true
      inside = false
      cursor = end + 3
    } else {
      const start = line.indexOf('<!--', cursor)
      if (start < 0) return false
      const end = line.indexOf('-->', start + 4)
      if (end < 0) return true
      cursor = end + 3
    }
  }
  return inside
}

/** Locate every slide, its frontmatter block and its markdown body. */
export function parseSlidevDeck(source: string): SlidevDeck {
  const lines = scanLines(source)
  const diagnostics: Diagnostic[] = []
  const slides: SlideRange[] = []

  const lineStart = (index: number): number => lines[index]?.start ?? source.length
  const at = (index: number): Line => lines[index] as Line

  // Slidev's `start` and `contentStart`, in line indices.
  let startLine = 0
  let contentLine = 0
  let openSeparator: number | undefined
  let frontmatterClose: number | undefined
  let inHtmlComment = false
  // Diagnostics only: never consulted when deciding where a slide breaks.
  let tildeFence: number | undefined

  /** Slidev's `slice(end)`: emit the pending slide, unless it is empty. */
  const emit = (endLine: number): void => {
    if (startLine === endLine) return
    const separator = openSeparator
    const close = frontmatterClose
    slides.push({
      index: slides.length,
      start: separator === undefined ? lineStart(startLine) : at(separator).end,
      separator:
        separator === undefined
          ? undefined
          : { start: at(separator).start, end: at(separator).end },
      end: lineStart(endLine),
      frontmatter:
        separator === undefined || close === undefined
          ? undefined
          : {
              start: at(separator).start,
              end: at(close).end,
              bodyStart: at(separator).end,
              bodyEnd: at(close).start,
            },
      bodyStart: lineStart(contentLine),
      bodyEnd: lineStart(endLine),
      isHeadmatter: slides.length === 0 && separator === 0,
    })
    startLine = endLine + 1
    contentLine = endLine + 1
    openSeparator = undefined
    frontmatterClose = undefined
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = at(index)
    const text = lineContent(raw, index)
    const trimmed = text.trimEnd()

    if (inHtmlComment) {
      inHtmlComment = advanceHtmlCommentState(text, true)
      continue
    }

    if (trimmed.startsWith('---')) {
      if (tildeFence !== undefined) {
        diagnostics.push(
          diagnostic(
            source,
            'separator-in-tilde-fence',
            'error',
            'Slidev splits the slide at this "---" because it does not track tilde fences, cutting the code block in half — use a backtick fence, or indent the "---"',
            raw.start,
            raw.end,
          ),
        )
      }
      if (!EXACT_SEPARATOR.test(trimmed)) {
        diagnostics.push(
          diagnostic(
            source,
            'ambiguous-separator',
            'warning',
            'Slidev splits the slide at this line because it starts with three or more dashes; if it was meant as a setext heading underline or a horizontal rule, it is not one — use exactly "---" to break a slide, or "***" for a rule',
            raw.start,
            raw.end,
          ),
        )
      }
      emit(index)
      openSeparator = index
      const next = lines[index + 1]
      // Slidev's `line[3] !== "-"`: a longer dash run splits but opens no block.
      if (trimmed[3] !== '-' && next !== undefined && next.text.trim() !== '') {
        let close = index + 1
        let malformed: Line | undefined
        for (; close < lines.length; close += 1) {
          const candidate = at(close)
          const candidateText = candidate.text.trimEnd()
          if (candidateText === '---') break
          if (malformed === undefined && DASH_RUN.test(candidateText)) malformed = candidate
        }
        if (malformed !== undefined) {
          diagnostics.push(
            diagnostic(
              source,
              'malformed-frontmatter',
              'error',
              'a column-0 run of dashes inside this frontmatter block does not close it; Slidev consumes three dashes here and leaks the rest of the line into the slide',
              malformed.start,
              malformed.end,
            ),
          )
        }
        if (close === lines.length) {
          diagnostics.push(
            diagnostic(
              source,
              'unclosed-frontmatter',
              'error',
              'frontmatter block is never closed by a "---" line; Slidev would read the rest of the file as YAML',
              raw.start,
              raw.end,
            ),
          )
        } else {
          frontmatterClose = close
        }
        startLine = index
        contentLine = close + 1
        index = close
      }
      continue
    }

    if (trimmed.trimStart().startsWith('```')) {
      const level = LEADING_BACKTICKS.exec(trimmed)?.[0] ?? '```'
      let close = index + 1
      for (; close < lines.length; close += 1) {
        if (at(close).text.startsWith(level)) break
      }
      if (close === lines.length) {
        // Slidev resumes on the next line rather than swallowing the file, so this is not
        // fatal — but the fence is still open, so whether a later `---` breaks a slide now
        // depends on whether some *later* content happens to close it. That makes slide
        // identity depend on the order of the deck, which is the one thing ADR 0005 buys.
        diagnostics.push(
          diagnostic(
            source,
            'unclosed-fence',
            'warning',
            'this fenced block is never closed, so where the slides after it break depends on content further down the file — close the fence to keep their identities stable',
            raw.start,
            raw.end,
          ),
        )
      } else {
        index = close
      }
      continue
    }

    tildeFence = advanceTildeState(lines, index, trimmed, tildeFence)
    inHtmlComment = advanceHtmlCommentState(text, false)
  }

  if (startLine <= lines.length - 1) emit(lines.length)
  return { source, slides, diagnostics }
}

/**
 * Track tilde runs for the `separator-in-tilde-fence` diagnostic only.
 *
 * A run opens a region only when a closing run of at least the same length exists ahead,
 * which keeps a stray `~~~` in prose from making every later separator look suspect. This
 * never influences where a slide breaks — Slidev does not know tildes exist.
 */
function advanceTildeState(
  lines: readonly Line[],
  index: number,
  trimmed: string,
  open: number | undefined,
): number | undefined {
  const run = LEADING_TILDES.exec(trimmed)?.[0].trimStart()
  if (run === undefined) return open
  if (open !== undefined) return run.length >= open ? undefined : open
  for (let close = index + 1; close < lines.length; close += 1) {
    const candidate = LEADING_TILDES.exec((lines[close] as Line).text.trimEnd())?.[0].trimStart()
    if (candidate !== undefined && candidate.length >= run.length) return run.length
  }
  return undefined
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
 * Find a slide's speaker note — transcribed from Slidev's `parseSlide`.
 *
 * Slidev's rule is deliberately simple and has no fence awareness at all: take the slide
 * content, trim it, find every `<!-- … -->` comment, and if the **last** one ends at the
 * end of the content, that comment is the note and everything before it is the body.
 *
 * An earlier version here required the opener to start its line and skipped comments
 * inside fenced code, on the theory that this was safely stricter. It was not: a fence
 * whose closing line is indented does not close by Slidev's rule, which swallowed a real
 * note and lost its prose, and a note opened mid-line was missed entirely. Both were
 * silent. Matching the renderer exactly is the only rule that cannot invent or lose a
 * note relative to what the audience is shown.
 *
 * Earlier comments in the slide stay author asides; the prose locator reports them as
 * untranslated HTML blocks, which is the right answer for an aside.
 */
export function findSpeakerNote(
  source: string,
  start: number,
  end: number,
): SpeakerNote | undefined {
  // Slidev compares against `content.trim()`, so the bounds are the trimmed slide.
  let from = start
  while (from < end && /\s/.test(source.charAt(from))) from += 1
  let to = end
  while (to > from && /\s/.test(source.charAt(to - 1))) to -= 1

  let last: SpeakerNote | undefined
  let cursor = from
  for (;;) {
    const open = source.indexOf('<!--', cursor)
    if (open === -1 || open >= to) break
    const close = source.indexOf('-->', open + 4)
    if (close === -1 || close + 3 > to) break
    last = { start: open, end: close + 3, innerStart: open + 4, innerEnd: close }
    cursor = close + 3
  }

  // Only a comment that ends the slide is the note; anything after it is content.
  return last !== undefined && last.end === to ? last : undefined
}
