/**
 * `@workshop-i18n/compose` — locale composition and its gates (spec 003, ADRs 0007,
 * 0009, 0012).
 *
 * - {@link composeLocale}: English sources + one locale's catalogs → the generated locale
 *   files, a per-unit report and findings, in `preview` or `strict` (release) mode.
 * - {@link verifyComposedFile}: every gate, run on a composed file it did not produce —
 *   what `workshop-i18n verify` runs over a generated tree.
 * - The gates themselves, usable on their own: markup/placeholder parity, protected
 *   terms, the length budget, and the output-side skeleton comparison.
 *
 * Governed slide overrides (ADR 0008, spec 003 User Story 2) are deferred — see
 * `compose.ts` and the README. Nothing here reads or accepts an override.
 *
 * Pure and offline: no `node:fs`, no network, and consumer content is never executed.
 * Reading sources and catalogs and writing the generated tree is the CLI's job
 * (constitution IV).
 */

export {
  type ComposedFile,
  type ComposeLocaleInput,
  type ComposeLocaleResult,
  composeLocale,
  GENERATED_NOTICE,
  type SourceFile,
  type UnitRendering,
  type UnitReport,
} from './compose.js'
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
