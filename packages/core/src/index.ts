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
  DuplicateUnitError,
  definePolicy,
  emptyStateCounts,
  evaluatePolicy,
  isPolicyName,
  type LocaleStateCounts,
  POLICIES,
  type Policy,
  type PolicyEvaluation,
  type PolicyName,
  type PolicyViolation,
  resolvePolicy,
  type SectionStateCounts,
  type StateCounts,
  type StateReport,
  type StateThresholds,
  tallyUnitStates,
  type UnitStatus,
  type ViolatingUnit,
} from './policy.js'
export {
  isSourceHash,
  SOURCE_HASH_DIGEST_LENGTH,
  SOURCE_HASH_PREFIX,
  sourceHash,
} from './source-hash.js'
export { isUnitState, type TranslationUnit, UNIT_STATES, type UnitState } from './unit.js'
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
