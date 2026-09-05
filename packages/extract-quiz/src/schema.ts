/**
 * Which quiz shapes this release understands, and how a file is matched against them.
 *
 * The manifest declares a variant (`surfaces.quiz.schema`, one of core's
 * {@link QUIZ_SCHEMA_VARIANTS}); extraction checks the file against the shape that
 * variant names, and **a file matching neither variant is a hard error naming the
 * manifest entry** — spec 001's edge case, spelled out because guessing at the shape of
 * a bank we do not recognise is how a tool localizes the wrong strings.
 *
 * ## The two variants declare the same shape today, and that is a fact, not a shortcut
 *
 * Both consumers ship `quiz/questions.schema.json`, and the two files are byte-identical
 * apart from `$id`: the same `schemaVersion: 1`, the same nine required question keys,
 * the same three required option keys, the same `^S[0-9]{2}-Q-[A-Z0-9-]+$` id pattern.
 * So {@link QUIZ_SHAPES} maps both variants onto the same description. Writing it as a
 * per-variant table anyway is what makes divergence a data change rather than a code
 * change: when one workshop adds a field, its row moves and the matcher does not.
 *
 * What the difference between the banks actually is — and it is a large one — is
 * *formatting*, and formatting is exactly what the offset-splice model preserves without
 * needing to know about it.
 *
 * ## What the shape is allowed to decide
 *
 * Only what extraction needs to be correct: the document is an object with a known
 * `schemaVersion` and a non-empty `questions` array, and every question and option is an
 * object carrying its required keys with the right types. It deliberately does **not**
 * re-implement JSON Schema — `answer` referencing a real option, `references` being
 * https, `difficulty` being one of three words are the consumer's own CI's business
 * (constitution VI). Nor does it decide identity safety: a question id that is unsafe or
 * off-pattern is a *named per-question diagnostic*, not "this file is an unknown shape",
 * because the two need very different fixes.
 */

import {
  type Manifest,
  QUIZ_SCHEMA_VARIANTS,
  type QuizSchemaVariant,
  surfaceSpec,
} from '@workshop-i18n/core'
import { type JsonNode, memberOf } from './json-scan.js'

/** The manifest path an unmatched file is reported against. */
export const QUIZ_MANIFEST_ENTRY = 'surfaces.quiz.schema'

/** The manifest path a missing quiz surface is reported against. */
export const QUIZ_SURFACE_ENTRY = 'surfaces.quiz'

/** One recognisable quiz-bank shape. */
export interface QuizShape {
  /** The `schemaVersion` a bank of this shape declares. */
  readonly schemaVersion: number
  /** Key of the array of questions at the document root. */
  readonly questionsKey: string
  /** Keys every question must carry. */
  readonly questionKeys: readonly string[]
  /** Key of the array of options inside a question. */
  readonly optionsKey: string
  /** Keys every option must carry. */
  readonly optionKeys: readonly string[]
  /** Shape a question id must have, per the consumer's own JSON Schema. */
  readonly questionIdPattern: RegExp
  /** Shape an option id must have, per the consumer's own JSON Schema. */
  readonly optionIdPattern: RegExp
  /** Question fields whose string value is translatable prose. */
  readonly translatableQuestionKeys: readonly string[]
  /** Option fields whose string value is translatable prose. */
  readonly translatableOptionKeys: readonly string[]
}

/**
 * The `questions.schema.json` both consumers ship, as a shape.
 *
 * `learningObjective` is *not* translatable here. It is prose, and a future release may
 * well want it, but spec 001 enumerates the translatable set as the question stem, the
 * option text, `explanation` and each option's `rationale`; widening that set silently
 * would change what a catalog contains without an ADR. It is recorded as a known gap
 * rather than quietly included.
 */
const CONSUMER_QUESTION_BANK: QuizShape = Object.freeze({
  schemaVersion: 1,
  questionsKey: 'questions',
  questionKeys: Object.freeze([
    'id',
    'section',
    'prompt',
    'options',
    'answer',
    'explanation',
    'difficulty',
    'learningObjective',
    'references',
  ]),
  optionsKey: 'options',
  optionKeys: Object.freeze(['id', 'text', 'rationale']),
  questionIdPattern: /^S[0-9]{2}-Q-[A-Z0-9-]+$/,
  optionIdPattern: /^[a-z][a-z0-9-]*$/,
  translatableQuestionKeys: Object.freeze(['prompt', 'explanation']),
  translatableOptionKeys: Object.freeze(['text', 'rationale']),
})

/** Every shape this release recognises, by the manifest variant that names it. */
export const QUIZ_SHAPES: Readonly<Record<QuizSchemaVariant, QuizShape>> = Object.freeze({
  'kubernetes-workshop': CONSUMER_QUESTION_BANK,
  'opentofu-workshop': CONSUMER_QUESTION_BANK,
})

/** Thrown when the manifest and the file cannot be reconciled. */
export class QuizSchemaError extends Error {
  /** The manifest path to fix, e.g. `surfaces.quiz.schema`. */
  readonly manifestEntry: string

  constructor(message: string, manifestEntry: string) {
    super(message)
    this.name = 'QuizSchemaError'
    this.manifestEntry = manifestEntry
  }
}

/**
 * The quiz schema variant a manifest declares.
 *
 * @throws {QuizSchemaError} naming `surfaces.quiz` when the manifest declares no quiz
 *   surface at all — extracting a quiz the manifest does not know about would put units
 *   in a catalog no gate reads.
 */
export function quizSchemaOf(manifest: Manifest): QuizSchemaVariant {
  const spec = surfaceSpec(manifest, 'quiz')
  if (spec === undefined || spec.surface !== 'quiz') {
    throw new QuizSchemaError(
      `${QUIZ_SURFACE_ENTRY}: the manifest declares no quiz surface, so there is no schema variant to extract against`,
      QUIZ_SURFACE_ENTRY,
    )
  }
  return spec.schema
}

function isStringMember(node: JsonNode | undefined, key: string): boolean {
  return memberOf(node, key)?.kind === 'string'
}

function matchesOption(option: JsonNode, shape: QuizShape): boolean {
  if (option.kind !== 'object') return false
  return shape.optionKeys.every((key) => isStringMember(option, key))
}

function matchesQuestion(question: JsonNode, shape: QuizShape): boolean {
  if (question.kind !== 'object') return false
  for (const key of shape.questionKeys) {
    if (memberOf(question, key) === undefined) return false
  }
  for (const key of [shape.translatableQuestionKeys, ['id', 'section']].flat()) {
    if (!isStringMember(question, key)) return false
  }
  const options = memberOf(question, shape.optionsKey)
  if (options?.kind !== 'array' || options.items.length === 0) return false
  return options.items.every((option) => matchesOption(option, shape))
}

/** True when `root` is a bank of `shape`. Structural only — see the module doc. */
export function matchesQuizShape(root: JsonNode, shape: QuizShape): boolean {
  if (root.kind !== 'object') return false
  const version = memberOf(root, 'schemaVersion')
  if (version?.kind !== 'number' || version.value !== shape.schemaVersion) return false
  const questions = memberOf(root, shape.questionsKey)
  if (questions?.kind !== 'array' || questions.items.length === 0) return false
  return questions.items.every((question) => matchesQuestion(question, shape))
}

/**
 * Every variant whose shape `root` satisfies, in canonical order. An empty result is the
 * "matches neither consumer schema variant" case spec 001 makes a hard error.
 */
export function detectQuizSchemas(root: JsonNode): readonly QuizSchemaVariant[] {
  return QUIZ_SCHEMA_VARIANTS.filter((variant) => matchesQuizShape(root, QUIZ_SHAPES[variant]))
}
