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
 *
 * Pure and offline like every other library here: no `node:fs`, no network, and the
 * translated tree is hostile input — it is bounded, parsed only by the extractors, and
 * never executed (SECURITY.md, constitution IV).
 */

export { type ContainerAlignment, scopeOf, type TranslatedUnit } from './align-container.js'
export { alignLabs } from './labs.js'
export type { AlignOptions } from './pair.js'
export { alignQuiz, type QuizAlignOptions } from './quiz.js'
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
