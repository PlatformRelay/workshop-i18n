/**
 * `@workshop-i18n/compose` — locale composition and its gates (spec 003, ADRs 0007,
 * 0009, 0012).
 *
 * Pure and offline: no `node:fs`, no network, and consumer content is never executed.
 * Reading sources and catalogs and writing the generated tree is the CLI's job
 * (constitution IV).
 */

export {
  ComposeInputError,
  type ComposeMode,
  type Finding,
  type FindingCode,
  type FindingSeverity,
  hasErrorFindings,
} from './findings.js'
export { type ContentGateFailure, contentGateFailures } from './gates.js'
export { type LengthMeasurement, measureLength } from './length.js'
export { FALLBACK_MARKER, isMarkedFallback, markFallback } from './marker.js'
export {
  checkMarkupParity,
  type MarkupParity,
  type MarkupToken,
  type MarkupTokenKind,
  markupTokens,
} from './markup.js'
export {
  compareSkeletons,
  type LocateContext,
  type LocatedFile,
  type LocatedHole,
  locateFile,
  type SkeletonMismatch,
} from './surface.js'
export { containsTerm, missingProtectedTerms } from './terms.js'
export {
  type FileVerification,
  locateContextFor,
  type VerifiedRendering,
  type VerifiedUnit,
  type VerifyFileInput,
  verifyComposedFile,
} from './verify.js'
