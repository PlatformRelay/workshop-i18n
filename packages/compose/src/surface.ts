/**
 * One seam over the three extractors, so composition and verification are written once.
 *
 * Each extractor owns its own skeleton, its own splice validation and its own error
 * class (ADR 0012: the skeleton is the source file with holes). Composition needs the
 * same four things from each — locate a file, splice a set of replacements, say which
 * replacements were refused, and (for slides) say which layout a unit sits on — and this
 * module is the only place that knows which package provides them. Nothing here
 * re-implements a locator or a splice.
 */

import {
  formatUnitId,
  type QuizSchemaVariant,
  type Surface,
  type UnitId,
} from '@workshop-i18n/core'
import * as labs from '@workshop-i18n/extract-markdown'
import * as quiz from '@workshop-i18n/extract-quiz'
import * as slides from '@workshop-i18n/extract-slidev'

/** One translatable span, as every extractor describes it. */
export interface LocatedHole {
  readonly id: UnitId
  readonly start: number
  readonly end: number
  /** The decoded unit text. */
  readonly source: string
}

/** An extractor diagnostic, in the shape all three packages share. */
export interface SourceDiagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly line: number
  readonly column: number
}

/** A replacement one extractor refused to splice, and its reason code. */
export interface SpliceRefusal {
  readonly id: string
  readonly reason: string
  readonly message: string
}

/** Thrown by {@link LocatedFile.compose}; carries every refusal. */
export class SpliceRefusedError extends Error {
  readonly refusals: readonly SpliceRefusal[]

  constructor(refusals: readonly SpliceRefusal[]) {
    super(`unspliceable replacement: ${refusals.map((item) => item.message).join('; ')}`)
    this.name = 'SpliceRefusedError'
    this.refusals = refusals
  }
}

/** A file located by its surface's extractor. */
export interface LocatedFile {
  readonly surface: Surface
  readonly source: string
  /** Holes in ascending offset order. */
  readonly holes: readonly LocatedHole[]
  readonly diagnostics: readonly SourceDiagnostic[]
  /** The Slidev layout of the slide a unit belongs to; `undefined` off-slides or unset. */
  layoutOf(containerId: string): string | undefined
  /**
   * Splice replacements keyed by formatted unit id, through the extractor's own
   * validation.
   *
   * @throws {SpliceRefusedError} when the extractor refuses any of them.
   */
  compose(replacements: ReadonlyMap<string, string>): string
}

/** What locating needs beyond the text. */
export interface LocateContext {
  /** Required for `quiz`: the variant the manifest declares. */
  readonly quizSchema?: QuizSchemaVariant | undefined
  /** Slidev frontmatter keys treated as prose; the extractor's default when absent. */
  readonly frontmatterTextKeys?: readonly string[] | undefined
}

const LAYOUT_KEY = new Set(['layout'])

function slideLayouts(source: string, extraction: slides.SlidevExtraction): Map<string, string> {
  const layouts = new Map<string, string>()
  for (const slide of extraction.slides) {
    const block = slide.range.frontmatter
    if (block === undefined) continue
    const layout = slides
      .locateFrontmatter(source, block, LAYOUT_KEY)
      .fields.find((field) => field.key === 'layout')
    if (layout !== undefined) layouts.set(slide.slideId, layout.value)
  }
  return layouts
}

function refusalsOf(error: unknown): readonly SpliceRefusal[] | undefined {
  if (
    error instanceof slides.CompositionError ||
    error instanceof labs.CompositionError ||
    error instanceof quiz.CompositionError
  ) {
    return error.issues.map((issue) => ({
      id: issue.id,
      reason: issue.reason,
      message: issue.message,
    }))
  }
  return undefined
}

function guarded(splice: () => string): string {
  try {
    return splice()
  } catch (error) {
    const refusals = refusalsOf(error)
    if (refusals === undefined) throw error
    throw new SpliceRefusedError(refusals)
  }
}

function noLayout(): undefined {
  return undefined
}

/**
 * Locate `text` with the extractor for `surface`, reporting rather than throwing: a file
 * with error diagnostics still comes back, and still reproduces itself from an empty
 * replacement set, because refusing is not mangling.
 */
export function locateFile(
  surface: Surface,
  text: string,
  context: LocateContext = {},
): LocatedFile {
  if (surface === 'slides') {
    const extraction = slides.locateSlidevFile(
      text,
      context.frontmatterTextKeys === undefined
        ? {}
        : { frontmatterTextKeys: context.frontmatterTextKeys },
    )
    const layouts = slideLayouts(text, extraction)
    return {
      surface,
      source: text,
      holes: extraction.skeleton.holes,
      diagnostics: extraction.diagnostics,
      layoutOf: (containerId) => layouts.get(containerId),
      compose: (replacements) =>
        guarded(() => slides.composeSkeleton(extraction.skeleton, replacements)),
    }
  }
  if (surface === 'labs') {
    const extraction = labs.locateLabFile(text)
    return {
      surface,
      source: text,
      holes: extraction.skeleton.holes,
      diagnostics: extraction.diagnostics,
      layoutOf: noLayout,
      compose: (replacements) =>
        guarded(() => labs.composeSkeleton(extraction.skeleton, replacements)),
    }
  }
  if (context.quizSchema === undefined) {
    throw new Error('locating a quiz file needs the quiz schema variant the manifest declares')
  }
  const extraction = quiz.locateQuizFile(text, { schema: context.quizSchema })
  return {
    surface,
    source: text,
    holes: extraction.skeleton.holes,
    diagnostics: extraction.diagnostics,
    layoutOf: noLayout,
    compose: (replacements) =>
      guarded(() => quiz.composeSkeleton(extraction.skeleton, replacements)),
  }
}

/** Why a composed file's skeleton is not the English one. */
export interface SkeletonMismatch {
  /** 1-based line in the composed file where the first difference was found. */
  readonly line: number
  readonly message: string
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) line += 1
  }
  return line
}

/**
 * Compare the protected skeleton of a composed file with the English one — on the
 * *output*, by locating the composed file afresh with the same extractor.
 *
 * Two files have the same skeleton when they have the same holes (same identities, same
 * order) and every byte between, before and after those holes is identical. That is
 * the whole of ADR 0012's guarantee restated as a check: fences, frontmatter machinery,
 * Vue islands, includes, indentation — everything that is not a hole — must be the
 * English bytes. A composed file whose own extraction raises a new error diagnostic has
 * changed structure too, even if its hole set happens to line up.
 *
 * Construction already promises this; checking it on the output is what catches a
 * translation that turned a paragraph into a list, split a unit in two, or anything
 * else the splice validation did not anticipate — and it is the check `verify` runs on
 * a generated tree it did not produce itself.
 */
export function compareSkeletons(
  english: LocatedFile,
  composed: LocatedFile,
): SkeletonMismatch | undefined {
  const newErrors = composed.diagnostics.filter(
    (item) =>
      item.severity === 'error' &&
      !english.diagnostics.some((known) => known.severity === 'error' && known.code === item.code),
  )
  const firstError = newErrors[0]
  if (firstError !== undefined) {
    return {
      line: firstError.line,
      message: `the composed file raises ${firstError.code} where the English does not: ${firstError.message}`,
    }
  }

  const count = Math.max(english.holes.length, composed.holes.length)
  let englishEnd = 0
  let composedEnd = 0
  for (let index = 0; index <= count; index += 1) {
    const expected = english.holes[index]
    const actual = composed.holes[index]
    if (index < count) {
      const expectedId = expected === undefined ? undefined : formatUnitId(expected.id)
      const actualId = actual === undefined ? undefined : formatUnitId(actual.id)
      if (expectedId !== actualId) {
        return {
          line: lineAt(composed.source, actual?.start ?? composedEnd),
          message:
            actualId === undefined
              ? `unit ${expectedId} is missing from the composed file`
              : expectedId === undefined
                ? `the composed file has a unit ${actualId} the English does not`
                : `expected unit ${expectedId} but the composed file has ${actualId} here`,
        }
      }
    }
    const englishSegment = english.source.slice(
      englishEnd,
      expected?.start ?? english.source.length,
    )
    const composedSegment = composed.source.slice(
      composedEnd,
      actual?.start ?? composed.source.length,
    )
    if (englishSegment !== composedSegment) {
      let offset = 0
      while (
        offset < englishSegment.length &&
        englishSegment.charCodeAt(offset) === composedSegment.charCodeAt(offset)
      ) {
        offset += 1
      }
      const where =
        expected === undefined ? 'after the last unit' : `before unit ${formatUnitId(expected.id)}`
      return {
        line: lineAt(composed.source, composedEnd + offset),
        message: `protected skeleton differs from the English ${where}`,
      }
    }
    englishEnd = expected?.end ?? english.source.length
    composedEnd = actual?.end ?? composed.source.length
  }
  return undefined
}
