/**
 * Lossless extraction and composition for lab Markdown files (spec 001, ADR 0012).
 *
 * Extraction **locates**; it never re-serializes. It returns the original file text plus
 * the half-open ranges of the prose inside it, and `composeSkeleton` splices
 * translations back into those ranges. Everything else — heredoc'd YAML manifests,
 * `kubectl` one-liners, API kinds, image references, `<details>` machinery, tables,
 * indentation — is copied byte-for-byte, so composing a skeleton with an empty catalog
 * reproduces the source exactly.
 *
 * Labs have no frontmatter, so they carry their identity in an HTML comment
 * (`<!-- labId: day-1-05-pod -->`); see `lab-id.ts` for why that spelling and how
 * `init-ids` writes it.
 *
 * Pure and offline: no `node:fs`, no network, and consumer content is never executed.
 * Reading files is the CLI's job (constitution IV).
 */

export {
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
  hasErrors,
} from './diagnostic.js'
export { extractLabFile, type LabExtraction, LabExtractionError, locateLabFile } from './extract.js'
export {
  checkLabIds,
  collectLabIds,
  LAB_ID_KEY,
  type LabIdFile,
  type LabIdInsertion,
  type LabIdIssue,
  type LabIdLocation,
  type LabIdPlan,
  type LabIdPlanOptions,
  type LabIdProposalOptions,
  type LabIdRecord,
  planLabId,
  proposeLabId,
  renderLabIdMarker,
} from './lab-id.js'
export { locateProse, type ProseLocation, type ProseOptions, type ProseSpan } from './prose.js'
export {
  CompositionError,
  type CompositionIssue,
  composeSkeleton,
  createSkeleton,
  type Hole,
  type HoleEncoding,
  type ReplacementRejection,
  type Skeleton,
  SkeletonError,
  skeletonUnits,
  stripContinuationPrefix,
  type TranslationLookup,
} from './skeleton.js'
export { decodeSource, type Position, positionAt, SourceDecodeError } from './source.js'
