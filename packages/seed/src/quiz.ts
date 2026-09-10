/**
 * Aligning a translated quiz bank to its English original (spec 004 User Story 1).
 *
 * Quiz questions already carry explicit ids in both trees, and option ids inside them,
 * so no identity is borrowed here: an English question is paired with the translated
 * question that declares the same id, wherever it sits in the bank. The translated ids
 * are validated by the same extractor that validates the English ones.
 *
 * What a translation must *not* change is the question's machinery: the sequence of
 * option ids and the `answer`. A translated question that reorders its options or moves
 * the answer is not a translation of the English question any more — seeding its option
 * texts would attach the right words to the wrong choice — so it is missed as a whole.
 */

import type { QuizSchemaVariant } from '@workshop-i18n/core'
import {
  extractQuizFile,
  hasErrors,
  type JsonNode,
  locateQuizFile,
  memberOf,
  QUIZ_SHAPES,
  type QuizExtraction,
  QuizExtractionError,
  scanJson,
} from '@workshop-i18n/extract-quiz'
import { alignContainer } from './align-container.js'
import {
  type AlignOptions,
  byContainer,
  containerMiss,
  type FilePair,
  fileMiss,
  noDivergence,
  pairFiles,
  refuseTranslatedFile,
  resolveLimits,
} from './pair.js'
import {
  type SectionAlignment,
  type SeedDraft,
  type SeedFile,
  SeedInputError,
  type SeedLimits,
  type SeedMiss,
  type SurfaceAlignment,
} from './types.js'

/** Options for {@link alignQuiz}. */
export interface QuizAlignOptions extends AlignOptions {
  /** The bank shape the manifest declares (`quizSchemaOf(manifest)`). */
  readonly schema: QuizSchemaVariant
}

/** Canonical text of a located JSON value, for comparing machinery across files. */
function canonicalJson(source: string, node: JsonNode | undefined): string {
  if (node === undefined) return 'undefined'
  // The slice was already accepted by the scanner, so this parse cannot execute anything
  // and cannot fail; it only normalises whitespace and escapes.
  return JSON.stringify(JSON.parse(source.slice(node.start, node.end)))
}

/** Question id → canonical `[option ids, answer]`, for every question in a scanned bank. */
function questionMachinery(source: string, schema: QuizSchemaVariant): Map<string, string> {
  const shape = QUIZ_SHAPES[schema]
  const machinery = new Map<string, string>()
  const questions = memberOf(scanJson(source), shape.questionsKey)
  if (questions?.kind !== 'array') return machinery
  for (const question of questions.items) {
    const id = memberOf(question, 'id')
    if (id?.kind !== 'string') continue
    const options = memberOf(question, shape.optionsKey)
    const optionIds =
      options?.kind === 'array'
        ? options.items.map((option) => {
            const optionId = memberOf(option, 'id')
            return optionId?.kind === 'string' ? optionId.value : null
          })
        : null
    machinery.set(
      id.value,
      JSON.stringify([optionIds, canonicalJson(source, memberOf(question, 'answer'))]),
    )
  }
  return machinery
}

function extractEnglish(pair: FilePair, schema: QuizSchemaVariant): QuizExtraction {
  try {
    return extractQuizFile(pair.english, { schema }, pair.path)
  } catch (error) {
    if (error instanceof QuizExtractionError) {
      throw new SeedInputError(
        `English quiz bank ${pair.path} cannot be extracted: ${error.message}`,
        {
          cause: error,
        },
      )
    }
    throw error
  }
}

function alignQuizFile(
  pair: FilePair,
  schema: QuizSchemaVariant,
  limits: SeedLimits,
): SectionAlignment {
  const english = extractEnglish(pair, schema)
  const units = english.units
  const section = (
    drafts: readonly SeedDraft[],
    misses: readonly SeedMiss[],
  ): SectionAlignment => ({
    surface: 'quiz',
    section: pair.path,
    englishUnits: units.length,
    drafts,
    misses,
    skeletonDivergence: noDivergence(),
  })

  const refused = refuseTranslatedFile(pair, units, limits)
  if (refused !== undefined) return section([], [refused])
  const translatedText = pair.translated as string

  const located = locateQuizFile(translatedText, { schema })
  if (hasErrors(located.diagnostics)) {
    return section(
      [],
      [
        fileMiss(
          'unreadable-translation',
          units,
          'the translated quiz bank cannot be extracted as written',
        ),
      ],
    )
  }

  const ourMachinery = questionMachinery(pair.english, schema)
  const theirMachinery = questionMachinery(translatedText, schema)
  const translatedUnits = byContainer(located.units)
  const drafts: SeedDraft[] = []
  const misses: SeedMiss[] = []

  for (const [questionId, ours] of byContainer(units)) {
    const theirs = translatedUnits.get(questionId)
    if (theirs === undefined || !theirMachinery.has(questionId)) {
      misses.push(
        containerMiss(
          'question-missing',
          questionId,
          ours,
          'the translated bank has no question with this id',
        ),
      )
      continue
    }
    if (ourMachinery.get(questionId) !== theirMachinery.get(questionId)) {
      misses.push(
        containerMiss(
          'structure-diverged',
          questionId,
          ours,
          'the translated question has different option ids or a different answer',
        ),
      )
      continue
    }
    const aligned = alignContainer(
      questionId,
      ours,
      theirs.map((unit) => ({ unitKey: unit.id.unitKey, source: unit.source })),
      limits,
    )
    drafts.push(...aligned.drafts)
    misses.push(...aligned.misses)
  }
  return section(drafts, misses)
}

/**
 * Align a translated quiz bank (or banks) against the English one.
 *
 * @throws {SeedInputError} when an English bank cannot be extracted, a path repeats, or a
 *   limit is exceeded. A translated file never throws; it misses.
 */
export function alignQuiz(
  english: readonly SeedFile[],
  translated: readonly SeedFile[],
  options: QuizAlignOptions,
): SurfaceAlignment {
  const limits = resolveLimits(options.limits)
  const { pairs, unpairedTranslated } = pairFiles(english, translated, limits)
  return {
    surface: 'quiz',
    sections: pairs.map((pair) => alignQuizFile(pair, options.schema, limits)),
    unpairedTranslated,
  }
}
