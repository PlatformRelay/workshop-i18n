/**
 * Lossless extraction and composition for structured quiz JSON (spec 001, ADR 0012).
 *
 * Extraction **locates**; it never re-serializes. It returns the original file text plus
 * the half-open ranges of the translatable string bodies inside it, and `composeSkeleton`
 * splices escaped bodies back into those ranges. Everything else — key order,
 * indentation, the quotes themselves, question and option ids, `answer`, `section`,
 * `difficulty`, `references`, and the file's own choice between `é` and `é` — is
 * copied byte-for-byte, so composing a skeleton with an empty catalog reproduces the
 * source exactly.
 *
 * The manifest declares which bank shape to expect (`surfaces.quiz.schema`); a file
 * matching neither variant is a hard error naming that entry.
 *
 * Pure and offline: no `node:fs`, no network, no `eval`, and consumer content is never
 * executed. Reading files is the CLI's job (constitution IV).
 */

export {
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
  hasErrors,
} from './diagnostic.js'
export {
  extractQuizFile,
  locateQuizFile,
  type QuizExtraction,
  QuizExtractionError,
  type QuizExtractOptions,
} from './extract.js'
export {
  type JsonMember,
  type JsonNode,
  JsonScanError,
  type JsonString,
  memberOf,
  scanJson,
} from './json-scan.js'
export {
  detectQuizSchemas,
  matchesQuizShape,
  QUIZ_MANIFEST_ENTRY,
  QUIZ_SHAPES,
  QUIZ_SURFACE_ENTRY,
  QuizSchemaError,
  type QuizShape,
  quizSchemaOf,
} from './schema.js'
export {
  CompositionError,
  type CompositionIssue,
  composeSkeleton,
  createSkeleton,
  encodeJsonStringBody,
  type Hole,
  type HoleEncoding,
  type ReplacementRejection,
  type Skeleton,
  SkeletonError,
  skeletonUnits,
  type TranslationLookup,
} from './skeleton.js'
export { decodeSource, type Position, positionAt, SourceDecodeError } from './source.js'
