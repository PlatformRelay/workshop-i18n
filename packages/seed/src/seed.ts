/**
 * The whole `seed` run as one call — what `workshop-i18n seed` wires to (spec 004 US1).
 *
 * The CLI reads the English files, the translated tree and the locale's catalogs, calls
 * {@link seed}, writes back the catalogs it returns and prints (or saves) the report.
 * Nothing here touches a file system.
 */

import type { Catalog } from '@workshop-i18n/catalog-po'
import { assertSafeLocale, LocaleError, type QuizSchemaVariant } from '@workshop-i18n/core'
import { applySeedDrafts, assertSafeProvenance } from './apply.js'
import { alignLabs } from './labs.js'
import { alignQuiz } from './quiz.js'
import { buildSeedReport, type SeedReport } from './report.js'
import { alignSlides } from './slides.js'
import { type SeedFile, SeedInputError, type SeedLimits, type SurfaceAlignment } from './types.js'

/** One surface's two trees. */
export interface SeedTrees {
  /** English files, adopted (`init-ids` has run), with tree-relative paths. */
  readonly english: readonly SeedFile[]
  /** The translated parallel tree's files, same relative paths. Untrusted. */
  readonly translated: readonly SeedFile[]
}

/** Everything one run needs. Omit a surface to leave it out of the run. */
export interface SeedInput {
  /** Target locale, e.g. `pt-BR`. Every catalog must be for this locale. */
  readonly locale: string
  /** Human-readable seed source, recorded on every seeded entry. */
  readonly provenance: string
  readonly slides?: SeedTrees & { readonly frontmatterTextKeys?: readonly string[] }
  readonly labs?: SeedTrees
  readonly quiz?: SeedTrees & { readonly schema: QuizSchemaVariant }
  /** The locale's catalogs as they stand — every English unit should already have an entry. */
  readonly catalogs: readonly Catalog[]
  readonly limits?: Partial<SeedLimits>
}

/** Result of {@link seed}. */
export interface SeedResult {
  /** The catalogs, in the order given, with seeded entries added. */
  readonly catalogs: readonly Catalog[]
  readonly report: SeedReport
  /** The raw alignment, for callers that want more than the report. */
  readonly alignments: readonly SurfaceAlignment[]
}

/**
 * Align a translated parallel tree against the English sources and record every aligned
 * translation as a `needs-review` draft.
 *
 * @throws {SeedInputError} for unusable caller input: an unsafe locale or provenance, an
 *   English file that cannot be extracted, a catalog of another locale, duplicated paths
 *   or unit ids, or an exceeded limit. A translated file never throws; it misses.
 */
export function seed(input: SeedInput): SeedResult {
  let locale: string
  try {
    locale = assertSafeLocale(input.locale)
  } catch (error) {
    if (error instanceof LocaleError) throw new SeedInputError(error.message, { cause: error })
    throw error
  }
  const provenance = assertSafeProvenance(input.provenance)
  const limits = input.limits === undefined ? {} : { limits: input.limits }

  const alignments: SurfaceAlignment[] = []
  if (input.slides !== undefined) {
    const { english, translated, frontmatterTextKeys } = input.slides
    alignments.push(
      alignSlides(english, translated, {
        ...limits,
        ...(frontmatterTextKeys === undefined ? {} : { frontmatterTextKeys }),
      }),
    )
  }
  if (input.labs !== undefined) {
    alignments.push(alignLabs(input.labs.english, input.labs.translated, limits))
  }
  if (input.quiz !== undefined) {
    const { english, translated, schema } = input.quiz
    alignments.push(alignQuiz(english, translated, { ...limits, schema }))
  }

  const drafts = alignments.flatMap((alignment) =>
    alignment.sections.flatMap((section) => section.drafts),
  )
  const applied = applySeedDrafts(input.catalogs, drafts, { locale, provenance })
  return {
    catalogs: applied.catalogs,
    report: buildSeedReport(alignments, applied.outcomes, { locale, provenance }),
    alignments,
  }
}
