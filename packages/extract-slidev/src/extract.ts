/**
 * Extraction: the whole file, located (spec 001 User Story 2).
 *
 * This wires the three locators together — the slide splitter, the frontmatter field
 * locator and the markdown prose locator — and turns their spans into holes carrying
 * identities. It never re-serializes anything, so the skeleton it returns is the source
 * file itself (ADR 0012).
 *
 * ## Identity is a precondition, not a fallback
 *
 * A slide without a `slideId` cannot be extracted: any identity invented for it would be
 * derived from position or content, which is exactly what ADR 0005 forbids, and the
 * derived id would silently re-point every translation the first time the deck is
 * reordered. So a missing, unsafe or duplicated `slideId` is a hard error naming the
 * line, and the fix is `init-ids` — the one operator-invoked codemod allowed to touch
 * English (constitution I).
 *
 * `locateSlidevFile` returns everything it found including the diagnostics;
 * `extractSlidevFile` is the same call that fails closed on an error, which is what the
 * `extract` command wants.
 */

import {
  formatUnitId,
  type TranslationUnit,
  type UnitId,
  validateUnitId,
} from '@workshop-i18n/core'
import { findSpeakerNote, parseSlidevDeck, type SlideRange } from './deck.js'
import { type Diagnostic, diagnostic, hasErrors } from './diagnostic.js'
import {
  DEFAULT_FRONTMATTER_TEXT_KEYS,
  type FrontmatterField,
  locateFrontmatter,
} from './frontmatter.js'
import { locateProse, type ProseSpan } from './prose.js'
import {
  createSkeleton,
  type Hole,
  type HoleContext,
  type Skeleton,
  skeletonUnits,
} from './skeleton.js'
import { positionAt } from './source.js'

/** Knobs for {@link extractSlidevFile}. */
export interface SlidevExtractOptions {
  /**
   * Frontmatter keys whose string values are translatable prose. Defaults to
   * {@link DEFAULT_FRONTMATTER_TEXT_KEYS}; a consumer with its own layouts declares its
   * own list rather than having the tool guess from key names.
   */
  readonly frontmatterTextKeys?: readonly string[]
}

/** One slide that produced units, with the identity it carries in the source. */
export interface ExtractedSlide {
  readonly slideId: string
  readonly range: SlideRange
}

/** Everything one Slidev file yielded. */
export interface SlidevExtraction {
  /** The source plus its holes — feed it to `composeSkeleton`. */
  readonly skeleton: Skeleton
  /** The units, in identity order. */
  readonly units: readonly TranslationUnit[]
  readonly slides: readonly ExtractedSlide[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Thrown by {@link extractSlidevFile} when the file cannot be extracted as written. */
export class SlidevExtractionError extends Error {
  readonly diagnostics: readonly Diagnostic[]
  /** Caller-supplied label for the file, if any. */
  readonly source: string | undefined

  constructor(diagnostics: readonly Diagnostic[], source?: string) {
    const errors = diagnostics.filter((item) => item.severity === 'error')
    const where = source === undefined ? 'slides file' : `slides file ${source}`
    super(
      `cannot extract ${where}: ${errors.map((item) => `line ${item.line}: ${item.message}`).join('; ')}`,
    )
    this.name = 'SlidevExtractionError'
    this.diagnostics = diagnostics
    this.source = source
  }
}

function holeFor(
  file: string,
  diagnostics: Diagnostic[],
  id: UnitId,
  start: number,
  end: number,
  text: string,
  encoding: Hole['encoding'],
): Hole | undefined {
  const issues = validateUnitId(id)
  if (issues.length > 0) {
    diagnostics.push(
      diagnostic(
        file,
        'unsafe-slide-id',
        'error',
        `unit identity ${formatUnitId(id)} is unsafe: ${issues.map((issue) => issue.message).join('; ')}`,
        start,
        end,
      ),
    )
    return undefined
  }
  return { id, start, end, source: text, encoding }
}

function proseHoles(
  file: string,
  diagnostics: Diagnostic[],
  slideId: string,
  spans: readonly ProseSpan[],
  context: HoleContext,
): readonly Hole[] {
  const holes: Hole[] = []
  for (const span of spans) {
    const hole = holeFor(
      file,
      diagnostics,
      { surface: 'slides', containerId: slideId, unitKey: span.unitKey },
      span.start,
      span.end,
      span.text,
      { kind: 'markdown', continuationPrefix: span.continuationPrefix, context },
    )
    if (hole !== undefined) holes.push(hole)
  }
  return holes
}

function fieldHoles(
  file: string,
  diagnostics: Diagnostic[],
  slideId: string,
  fields: readonly FrontmatterField[],
): readonly Hole[] {
  const holes: Hole[] = []
  for (const field of fields) {
    const hole = holeFor(
      file,
      diagnostics,
      { surface: 'slides', containerId: slideId, unitKey: `fm/${field.key}` },
      field.start,
      field.end,
      field.value,
      { kind: 'yaml-scalar' },
    )
    if (hole !== undefined) holes.push(hole)
  }
  return holes
}

/**
 * Locate every translatable unit in one Slidev file, reporting rather than throwing.
 *
 * Use this for `--check`-style reporting; `extractSlidevFile` is the same thing with the
 * gate closed.
 */
export function locateSlidevFile(
  source: string,
  options: SlidevExtractOptions = {},
): SlidevExtraction {
  const textKeys = new Set(options.frontmatterTextKeys ?? DEFAULT_FRONTMATTER_TEXT_KEYS)
  const deck = parseSlidevDeck(source)
  const diagnostics: Diagnostic[] = [...deck.diagnostics]
  const holes: Hole[] = []
  const slides: ExtractedSlide[] = []
  const seen = new Map<string, number>()

  for (const slide of deck.slides) {
    const block = slide.frontmatter
    const located = block === undefined ? undefined : locateFrontmatter(source, block, textKeys)
    if (located !== undefined) diagnostics.push(...located.diagnostics)

    const slideId = located?.slideId
    const anchor = block?.start ?? slide.start
    if (slideId === undefined) {
      // An unsafe id already reported itself; do not say the same thing twice.
      if (!located?.diagnostics.some((item) => item.code === 'unsafe-slide-id')) {
        diagnostics.push(
          diagnostic(
            source,
            'missing-slide-id',
            'error',
            'slide has no slideId; run init-ids to give it a stable identity (ADR 0005)',
            anchor,
            slide.end,
          ),
        )
      }
      continue
    }
    const previous = seen.get(slideId)
    if (previous !== undefined) {
      diagnostics.push(
        diagnostic(
          source,
          'duplicate-slide-id',
          'error',
          `slideId ${JSON.stringify(slideId)} is already used on line ${previous}; identities must be unique across the deck`,
          anchor,
          slide.end,
        ),
      )
      continue
    }
    seen.set(slideId, positionAt(source, anchor).line)
    slides.push({ slideId, range: slide })

    holes.push(...fieldHoles(source, diagnostics, slideId, located?.fields ?? []))

    const note = findSpeakerNote(source, slide.bodyStart, slide.bodyEnd)
    const bodyEnd = note?.start ?? slide.bodyEnd
    const body = locateProse(source, { start: slide.bodyStart, end: bodyEnd, root: 'body' })
    diagnostics.push(...body.diagnostics)
    holes.push(...proseHoles(source, diagnostics, slideId, body.spans, 'body'))

    if (note !== undefined) {
      const noteProse = locateProse(source, {
        start: note.innerStart,
        end: note.innerEnd,
        root: 'note',
      })
      diagnostics.push(...noteProse.diagnostics)
      holes.push(...proseHoles(source, diagnostics, slideId, noteProse.spans, 'note'))
    }
  }

  const skeleton = createSkeleton(source, holes)
  return { skeleton, units: skeletonUnits(skeleton), slides, diagnostics }
}

/**
 * Locate every translatable unit in one Slidev file, failing closed on anything that
 * cannot be extracted correctly as written.
 *
 * @throws {SlidevExtractionError} when any diagnostic is an error.
 */
export function extractSlidevFile(
  source: string,
  options: SlidevExtractOptions = {},
  label?: string,
): SlidevExtraction {
  const extraction = locateSlidevFile(source, options)
  if (hasErrors(extraction.diagnostics)) {
    throw new SlidevExtractionError(extraction.diagnostics, label)
  }
  return extraction
}
