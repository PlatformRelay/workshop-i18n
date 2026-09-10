/**
 * The shapes a seed run speaks in: the files it is handed, the alignment it produces, and
 * the reasons it gives for everything it declined to align.
 *
 * Every English unit handed to an aligner ends up in exactly one place — a
 * {@link SeedDraft} or the `unitIds` of exactly one {@link SeedMiss} — so a report can
 * account for the whole English corpus rather than only for what matched. The tests pin
 * that partition as a property.
 */

import type { Surface, UnitId } from '@workshop-i18n/core'

/** One file as the caller read it. The path is a label and the pairing key, never an identity. */
export interface SeedFile {
  /** Path relative to the tree root, identical in the English and the translated tree. */
  readonly path: string
  readonly text: string
}

/**
 * Why an English unit was not aligned to a translation. Machine-readable so a CLI can
 * group and count; every miss also carries a human `detail`.
 */
export type SeedMissReason =
  /** The translated tree has no file at this path. */
  | 'no-translated-file'
  /** The translated file is larger than {@link SeedLimits.maxFileLength}. */
  | 'translated-file-too-large'
  /** The translated file cannot be located as written (a diagnostic error). */
  | 'unreadable-translation'
  /** The translated deck splits into a different number of slides. */
  | 'slide-count-mismatch'
  /** The translated file declares a container identity that disagrees with the English one. */
  | 'container-id-conflict'
  /** The container's (or heading scope's) unit structure differs from the English. */
  | 'structure-diverged'
  /** The translated quiz bank has no question with this id. */
  | 'question-missing'
  /** The translated text is byte-identical to the English: nothing was translated. */
  | 'identical-to-source'
  /** The translated text is empty. */
  | 'empty-translation'
  /** The translation introduces markup the English does not have (tags, `{{ }}`, comments). */
  | 'markup-divergence'
  /** The translation is implausibly longer than its source — a likely misalignment. */
  | 'length-divergence'

/** Every miss reason, in the order reports list them. */
export const SEED_MISS_REASONS: readonly SeedMissReason[] = Object.freeze([
  'no-translated-file',
  'translated-file-too-large',
  'unreadable-translation',
  'slide-count-mismatch',
  'container-id-conflict',
  'structure-diverged',
  'question-missing',
  'markup-divergence',
  'length-divergence',
  'empty-translation',
  'identical-to-source',
])

/** One refusal to align, and every English unit it left unseeded. */
export interface SeedMiss {
  readonly reason: SeedMissReason
  /** The container the miss is about, or `undefined` when it covers the whole file. */
  readonly containerId: string | undefined
  /** Formatted English unit ids this miss left unseeded, sorted. May be empty for a unitless container. */
  readonly unitIds: readonly string[]
  /** Human-readable explanation. Never contains translated content verbatim. */
  readonly detail: string
}

/**
 * Something about an aligned translation a reviewer should look at, which is not by
 * itself a reason to refuse it — translators legitimately rephrase around inline code.
 */
export type SeedWarningCode = 'code-span-divergence' | 'link-divergence'

/** An English unit aligned to a translated string, ready to become a needs-review draft. */
export interface SeedDraft {
  readonly id: UnitId
  /** The English source the alignment was made against (the catalog `msgid`). */
  readonly source: string
  /** The translated text, in the same decoded form as `source`. */
  readonly translation: string
  readonly warnings: readonly SeedWarningCode[]
}

/**
 * Non-prose bytes that differ between an English container and its aligned translation.
 * These are never imported — fences, HTML and machinery stay English skeleton — but a
 * translator's work there (translated code comments, translated `<KwCard>` prose) is
 * reported so it is not silently lost either.
 */
export interface SkeletonDivergence {
  /** Differing skeleton segments that contain a fenced block. */
  readonly fence: number
  /** Differing skeleton segments that contain raw HTML (and no fence). */
  readonly html: number
  /** Any other differing skeleton segment. */
  readonly other: number
}

/** One English file (a report section) aligned against its translated counterpart. */
export interface SectionAlignment {
  readonly surface: Surface
  /** The English file's path. */
  readonly section: string
  /** How many units the English file yields. */
  readonly englishUnits: number
  readonly drafts: readonly SeedDraft[]
  readonly misses: readonly SeedMiss[]
  readonly skeletonDivergence: SkeletonDivergence
}

/** One surface aligned: every English section, plus translated files nothing paired with. */
export interface SurfaceAlignment {
  readonly surface: Surface
  /** Sections ordered by path. */
  readonly sections: readonly SectionAlignment[]
  /** Translated paths with no English counterpart, sorted. Never read further. */
  readonly unpairedTranslated: readonly string[]
}

/** Bounds on untrusted input. */
export interface SeedLimits {
  /** Longest translated file accepted, in UTF-16 code units. */
  readonly maxFileLength: number
  /** Most translated files accepted per surface. */
  readonly maxFiles: number
  /**
   * A translation longer than `lengthRatio * source.length + lengthSlack` is refused as
   * a likely misalignment. Portuguese runs ~1.2x English; the bound is far above that.
   */
  readonly lengthRatio: number
  readonly lengthSlack: number
}

/** The bounds used when a caller does not override them. */
export const DEFAULT_SEED_LIMITS: SeedLimits = Object.freeze({
  maxFileLength: 2 * 1024 * 1024,
  maxFiles: 10_000,
  lengthRatio: 6,
  lengthSlack: 200,
})

/** Thrown when the *caller's* input is unusable — as opposed to a translated file, which only ever misses. */
export class SeedInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SeedInputError'
  }
}
