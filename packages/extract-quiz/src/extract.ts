/**
 * Extraction: one quiz bank, located (spec 001 User Story 2, FR-004).
 *
 * This wires the positional JSON scanner and the shape table together and turns the
 * located string ranges into holes carrying identities. It never re-serializes anything,
 * so the skeleton it returns is the source file itself (ADR 0012).
 *
 * ## Identity comes from the file, and is checked before it is used
 *
 * Unlike labs, a quiz question already carries an explicit id (`S07-Q-RET-01`) — the
 * consumers' own schema requires it — so there is nothing to invent and no `init-ids`
 * step. What there *is* is a boundary: those ids come from consumer content, which is
 * hostile input, and they become override file names and PO `msgctxt` values. So each
 * one is checked against core's container-id gate *and* against the shape the manifest's
 * schema variant declares, and a failure names the question rather than being repaired.
 *
 * Options are keyed by their declared id (`option/multistage/text`), never by their
 * position in the array, so shuffling the options of a question — which a quiz author
 * does routinely — moves no translation (spec 001 AS-3).
 *
 * ## What is translatable
 *
 * The question stem, each option's text, the `explanation`, and each option's
 * `rationale`. Nothing else: ids, `answer`, `section`, `difficulty`, `references` and
 * `learningObjective` are skeleton and are copied. See `schema.ts` for why
 * `learningObjective` is a recorded gap rather than a quiet inclusion.
 *
 * `locateQuizFile` returns everything it found including the diagnostics;
 * `extractQuizFile` is the same call that fails closed on an error, which is what the
 * `extract` command wants. Both reproduce the file byte-for-byte from an empty catalog,
 * refused files included — refusing is not the same as mangling.
 */

import {
  formatUnitId,
  isSafeContainerId,
  type QuizSchemaVariant,
  type TranslationUnit,
  type UnitId,
  validateUnitId,
} from '@workshop-i18n/core'
import { type Diagnostic, diagnostic, hasErrors } from './diagnostic.js'
import { type JsonNode, JsonScanError, type JsonString, memberOf, scanJson } from './json-scan.js'
import { detectQuizSchemas, QUIZ_MANIFEST_ENTRY, QUIZ_SHAPES, type QuizShape } from './schema.js'
import { createSkeleton, type Hole, type Skeleton, skeletonUnits } from './skeleton.js'
import { positionAt } from './source.js'

/** Knobs for {@link extractQuizFile}. */
export interface QuizExtractOptions {
  /** The variant the manifest declares; read it with `quizSchemaOf(manifest)`. */
  readonly schema: QuizSchemaVariant
}

/** Everything one quiz bank yielded. */
export interface QuizExtraction {
  /** The source plus its holes — feed it to `composeSkeleton`. */
  readonly skeleton: Skeleton
  /** The units, in identity order. */
  readonly units: readonly TranslationUnit[]
  /** The question ids the file declares, in source order. */
  readonly questionIds: readonly string[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Thrown by {@link extractQuizFile} when the bank cannot be extracted as written. */
export class QuizExtractionError extends Error {
  readonly diagnostics: readonly Diagnostic[]
  /** Caller-supplied label for the file, if any. */
  readonly source: string | undefined

  constructor(diagnostics: readonly Diagnostic[], source?: string) {
    const errors = diagnostics.filter((item) => item.severity === 'error')
    const where = source === undefined ? 'quiz file' : `quiz file ${source}`
    super(
      `cannot extract ${where}: ${errors.map((item) => `line ${item.line}: ${item.message}`).join('; ')}`,
    )
    this.name = 'QuizExtractionError'
    this.diagnostics = diagnostics
    this.source = source
  }
}

/** An empty result that still reproduces the file: refusing is not mangling. */
function refused(source: string, diagnostics: readonly Diagnostic[]): QuizExtraction {
  return {
    skeleton: createSkeleton(source, []),
    units: [],
    questionIds: [],
    diagnostics,
  }
}

/** Read a member that must be a located string, or `undefined`. */
function stringMember(node: JsonNode, key: string): JsonString | undefined {
  const member = memberOf(node, key)
  return member?.kind === 'string' ? member : undefined
}

/** Collect the translatable holes of one option, or report why it has none. */
function optionHoles(
  source: string,
  diagnostics: Diagnostic[],
  shape: QuizShape,
  questionId: string,
  option: JsonNode,
  seenOptionIds: Set<string>,
): readonly Hole[] {
  const idNode = stringMember(option, 'id')
  if (idNode === undefined) return []
  const optionId = idNode.value
  if (!shape.optionIdPattern.test(optionId)) {
    diagnostics.push(
      diagnostic(
        source,
        'unsafe-option-id',
        'error',
        `option id ${JSON.stringify(optionId)} in question ${JSON.stringify(questionId)} does not match ${String(shape.optionIdPattern)}; it becomes a segment of a PO msgctxt`,
        idNode.start,
        idNode.end,
      ),
    )
    return []
  }
  if (seenOptionIds.has(optionId)) {
    diagnostics.push(
      diagnostic(
        source,
        'duplicate-option-id',
        'error',
        `question ${JSON.stringify(questionId)} declares option id ${JSON.stringify(optionId)} more than once; two options cannot share one unit key`,
        idNode.start,
        idNode.end,
      ),
    )
    return []
  }
  seenOptionIds.add(optionId)

  const holes: Hole[] = []
  for (const key of shape.translatableOptionKeys) {
    const node = stringMember(option, key)
    if (node === undefined) continue
    holes.push({
      id: { surface: 'quiz', containerId: questionId, unitKey: `option/${optionId}/${key}` },
      start: node.innerStart,
      end: node.innerEnd,
      source: node.value,
      encoding: { kind: 'json-string' },
    })
  }
  return holes
}

/** Collect the translatable holes of one question, or report why it has none. */
function questionHoles(
  source: string,
  diagnostics: Diagnostic[],
  shape: QuizShape,
  question: JsonNode,
  seenQuestionIds: Map<string, number>,
): { readonly questionId: string | undefined; readonly holes: readonly Hole[] } {
  const idNode = stringMember(question, 'id')
  if (idNode === undefined) return { questionId: undefined, holes: [] }
  const questionId = idNode.value

  if (!isSafeContainerId(questionId) || !shape.questionIdPattern.test(questionId)) {
    diagnostics.push(
      diagnostic(
        source,
        'unsafe-question-id',
        'error',
        `question id ${JSON.stringify(questionId)} is not a usable identity: it becomes an override file name and a PO msgctxt, and must match ${String(shape.questionIdPattern)}`,
        idNode.start,
        idNode.end,
      ),
    )
    return { questionId: undefined, holes: [] }
  }
  const previous = seenQuestionIds.get(questionId)
  if (previous !== undefined) {
    diagnostics.push(
      diagnostic(
        source,
        'duplicate-question-id',
        'error',
        `question id ${JSON.stringify(questionId)} is already used on line ${previous}; identities must be unique across the bank`,
        idNode.start,
        idNode.end,
      ),
    )
    return { questionId: undefined, holes: [] }
  }
  seenQuestionIds.set(questionId, positionAt(source, idNode.start).line)

  const holes: Hole[] = []
  for (const key of shape.translatableQuestionKeys) {
    const node = stringMember(question, key)
    if (node === undefined) continue
    holes.push({
      id: { surface: 'quiz', containerId: questionId, unitKey: key },
      start: node.innerStart,
      end: node.innerEnd,
      source: node.value,
      encoding: { kind: 'json-string' },
    })
  }

  const options = memberOf(question, shape.optionsKey)
  if (options?.kind === 'array') {
    const seenOptionIds = new Set<string>()
    for (const option of options.items) {
      holes.push(...optionHoles(source, diagnostics, shape, questionId, option, seenOptionIds))
    }
  }
  return { questionId, holes }
}

/**
 * Locate every translatable unit in one quiz bank, reporting rather than throwing.
 *
 * Use this for `--check`-style reporting; {@link extractQuizFile} is the same thing with
 * the gate closed.
 */
export function locateQuizFile(source: string, options: QuizExtractOptions): QuizExtraction {
  let root: JsonNode
  try {
    root = scanJson(source)
  } catch (error) {
    if (!(error instanceof JsonScanError)) throw error
    return refused(source, [
      diagnostic(source, 'malformed-json', 'error', error.message, error.offset, error.offset),
    ])
  }

  const matched = detectQuizSchemas(root)
  if (!matched.includes(options.schema)) {
    // Spec 001's edge case, spelled exactly: name the manifest entry, say what it
    // declares, and say what the file looked like instead.
    const found =
      matched.length === 0
        ? 'the file matches no known quiz schema'
        : `the file matches ${matched.join(', ')} instead`
    return refused(source, [
      diagnostic(
        source,
        'unknown-quiz-schema',
        'error',
        `${QUIZ_MANIFEST_ENTRY} declares ${JSON.stringify(options.schema)}, but ${found}; fix the manifest entry or the bank`,
        root.start,
        root.end,
      ),
    ])
  }

  const shape = QUIZ_SHAPES[options.schema]
  const questions = memberOf(root, shape.questionsKey)
  const diagnostics: Diagnostic[] = []
  const holes: Hole[] = []
  const questionIds: string[] = []
  const seenQuestionIds = new Map<string, number>()

  if (questions?.kind === 'array') {
    for (const question of questions.items) {
      const located = questionHoles(source, diagnostics, shape, question, seenQuestionIds)
      if (located.questionId !== undefined) questionIds.push(located.questionId)
      holes.push(...located.holes)
    }
  }

  const safe: Hole[] = []
  for (const hole of holes) {
    const issues = validateUnitId(hole.id as UnitId)
    if (issues.length > 0) {
      diagnostics.push(
        diagnostic(
          source,
          'unsafe-question-id',
          'error',
          `unit identity ${formatUnitId(hole.id)} is unsafe: ${issues.map((issue) => issue.message).join('; ')}`,
          hole.start,
          hole.end,
        ),
      )
      continue
    }
    safe.push(hole)
  }

  const skeleton = createSkeleton(source, safe)
  return { skeleton, units: skeletonUnits(skeleton), questionIds, diagnostics }
}

/**
 * Locate every translatable unit in one quiz bank, failing closed on anything that
 * cannot be extracted correctly as written.
 *
 * @throws {QuizExtractionError} when any diagnostic is an error — including the spec 001
 *   edge case, a file matching neither schema variant, whose message names the manifest
 *   entry to fix.
 */
export function extractQuizFile(
  source: string,
  options: QuizExtractOptions,
  label?: string,
): QuizExtraction {
  const extraction = locateQuizFile(source, options)
  if (hasErrors(extraction.diagnostics)) {
    throw new QuizExtractionError(extraction.diagnostics, label)
  }
  return extraction
}
