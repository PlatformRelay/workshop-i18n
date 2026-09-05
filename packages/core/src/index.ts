/**
 * Domain model for workshop localization. Pure types and functions — no I/O:
 * no `node:fs`, no network, no `process`. Everything here is a deterministic
 * function of its arguments, so the CLI stays the only layer that touches a
 * working tree (ADR 0003, constitution IV).
 *
 * Identity scheme (ADR 0005): every translatable unit carries an explicit, immutable
 * identity that survives source edits and file moves. Slides carry `slideId` in
 * frontmatter; units are addressed as `<surface>:<containerId>:<unitKey>`.
 */

export {
  assertSafeLocale,
  isLocaleTag,
  LocaleError,
  type LocaleRejection,
  localeRejection,
  MAX_LOCALE_TAG_LENGTH,
} from './locale.js'
export {
  DEFAULT_LENGTH_BUDGET,
  type LengthBudgets,
  type LocaleSet,
  lengthBudgetFor,
  MANIFEST_API_GROUP,
  type Manifest,
  ManifestError,
  type ManifestIssue,
  type ManifestIssueCode,
  type MarkdownSurfaceSpec,
  type ParseManifestOptions,
  parseManifest,
  QUIZ_SCHEMA_VARIANTS,
  type QuizSchemaVariant,
  type QuizSurfaceSpec,
  SUPPORTED_MANIFEST_MAJOR,
  type SurfaceSpec,
  surfaceSpec,
} from './manifest.js'
export {
  DuplicateUnitError,
  definePolicy,
  emptyStateCounts,
  evaluatePolicy,
  gatedUnits,
  isGated,
  isPolicyName,
  type LocaleStateCounts,
  OPTIONAL_EXEMPT_STATES,
  POLICIES,
  type Policy,
  type PolicyEvaluation,
  type PolicyName,
  type PolicyViolation,
  resolvePolicy,
  type SectionStateCounts,
  type SourceUnit,
  type StateCounts,
  type StatePolicyViolation,
  type StateReport,
  type StateThresholds,
  statusesForLocale,
  tallyUnitStates,
  type UnitStatus,
  UnknownUnitStateError,
  type ViolatingUnit,
} from './policy.js'
export {
  isSourceHash,
  SOURCE_HASH_DIGEST_LENGTH,
  SOURCE_HASH_PREFIX,
  sourceHash,
} from './source-hash.js'
export {
  createTranslationUnit,
  isUnitState,
  type TranslationUnit,
  UNIT_STATES,
  type UnitState,
} from './unit.js'
export {
  assertSafeUnitId,
  compareUnitIds,
  formatUnitId,
  isSafeContainerId,
  isSafeUnitKey,
  isSurface,
  MAX_CONTAINER_ID_LENGTH,
  MAX_UNIT_KEY_LENGTH,
  parseSafeUnitId,
  parseUnitId,
  SURFACES,
  type Surface,
  type UnitId,
  UnitIdError,
  type UnitIdIssue,
  type UnitIdRejection,
  validateUnitId,
} from './unit-id.js'
