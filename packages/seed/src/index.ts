/**
 * `@workshop-i18n/seed` — harvest an existing translated parallel tree into needs-review
 * catalog drafts (spec 004 User Story 1, FR-001/FR-002).
 *
 * A parallel tree is a translation delivered as a copy of the English sources, translated
 * in place (Kubernetes-Workshop PR #55 is the motivating one). Seeding honours that work
 * without trusting it:
 *
 * 1. **Align** (`alignSlides`, `alignLabs`, `alignQuiz`) — pair each translated string
 *    with an English unit id by container structure and unit position within matched
 *    containers. Ambiguity or divergence is a *miss*, never a guess, and every English
 *    unit is accounted for as either a draft or a miss with a reason.
 * 2. **Record** (`applySeedDrafts`) — write each draft into whichever catalog holds its
 *    unit, as `needs-review` with a `#. workshop-i18n-seed:` provenance comment, and only
 *    into entries that hold no translation yet. Human work is never overwritten, and
 *    nothing here can produce `reviewed` (constitution V).
 * 3. **Report** (`buildSeedReport`, `formatSeedReport`) — per-section match/miss counts
 *    with reasons, as JSON-serialisable data and as terminal text (FR-002).
 *
 * `seed` runs all three and is what `workshop-i18n seed` calls.
 *
 * Pure and offline like every other library here: no `node:fs`, no network, and the
 * translated tree is hostile input — it is bounded, parsed only by the extractors, and
 * never executed (SECURITY.md, constitution IV).
 */

export { type ContainerAlignment, scopeOf, type TranslatedUnit } from './align-container.js'
export {
  type ApplySeedOptions,
  type ApplySeedResult,
  applySeedDrafts,
  assertSafeProvenance,
  MAX_PROVENANCE_LENGTH,
  SEED_COMMENT_KEY,
  SEED_OUTCOMES,
  type SeedOutcome,
  type SeedOutcomeKind,
} from './apply.js'
export { alignLabs } from './labs.js'
export type { AlignOptions } from './pair.js'
export { alignQuiz, type QuizAlignOptions } from './quiz.js'
export {
  buildSeedReport,
  formatSeedReport,
  SEED_REPORT_VERSION,
  type SeedCounts,
  type SeedReport,
  type SeedSectionReport,
  type SeedSurfaceReport,
} from './report.js'
export { type SeedInput, type SeedResult, type SeedTrees, seed } from './seed.js'
export { alignSlides, type SlidesAlignOptions } from './slides.js'
export {
  DEFAULT_SEED_LIMITS,
  SEED_MISS_REASONS,
  type SectionAlignment,
  type SeedDraft,
  type SeedFile,
  SeedInputError,
  type SeedLimits,
  type SeedMiss,
  type SeedMissReason,
  type SeedWarningCode,
  type SkeletonDivergence,
  type SurfaceAlignment,
} from './types.js'
export { checkTranslation, hasMarkupDivergence, type TranslationCheck } from './unit-checks.js'
