/**
 * Recording aligned drafts in the locale's catalogs — the only place seeding writes.
 *
 * Constitution V and spec 002 FR-007: a seeded entry enters as `needs-review` and nothing
 * here can produce `reviewed`. Writing goes through catalog-po's draft door,
 * `applyDraftTranslation`, which sets the `needs-review` flag itself and refuses human
 * work on its own; this module adds the seed provenance comment next to it.
 *
 * ## Stricter than the draft door, on purpose
 *
 * `applyDraftTranslation` allows overwriting any machine draft (`isDraftable`). Seeding
 * is stricter: it writes **only into an entry with no translation at all**. An entry that
 * already carries a different `needs-review` draft is kept, because a PO entry cannot say
 * whether a person has been editing that draft in a TMS without accepting it yet — and
 * spec 004 AS-3 promises that a re-run never overwrites human-touched work. The cost is
 * that an improved seed source does not replace an older seed; the report says
 * `kept-draft` for every such unit, so an operator who wants the replacement can clear
 * those entries deliberately.
 *
 * A re-run with the same drafts is a zero-byte change: an entry whose draft already
 * equals the candidate is left exactly as it is (`already-seeded`). An entry that is empty
 * *but still carries a seed comment* had its draft cleared by a person — a rejection of
 * that draft — so it is kept empty too (`kept-cleared`).
 */

import {
  applyDraftTranslation,
  type Catalog,
  type CatalogEntry,
  isDraftable,
  type PoComment,
  toCatalogEntry,
} from '@workshop-i18n/catalog-po'
import { assertSafeLocale, assertSafeUnitId, formatUnitId, LocaleError } from '@workshop-i18n/core'
import { type SeedDraft, SeedInputError } from './types.js'

/** `#.` key carrying the seed source an entry was drafted from. */
export const SEED_COMMENT_KEY = 'workshop-i18n-seed'

/**
 * `#.` key carrying the warnings a seeded draft was accepted with (`code-span-divergence`,
 * …). TMS products show extracted comments next to the string, so the reviewer who decides
 * on the draft sees why it deserves a closer look.
 */
export const SEED_WARNING_COMMENT_KEY = 'workshop-i18n-seed-warning'

/** Longest accepted provenance label; it is one PO comment line. */
export const MAX_PROVENANCE_LENGTH = 200

/** What happened to one draft. */
export type SeedOutcomeKind =
  /** The entry had no translation; it now holds the draft as `needs-review`. */
  | 'seeded'
  /** The entry already holds this exact draft; nothing changed. */
  | 'already-seeded'
  /** The entry holds human work (`reviewed`, or `fuzzy` without the draft marker); kept. */
  | 'kept-human'
  /** The entry holds a different draft, which may be mid-review; kept. */
  | 'kept-draft'
  /**
   * The entry is empty but carries a seed comment: an earlier seed was cleared by a
   * person, which is a decision about that draft, and re-seeding would undo it. Kept.
   */
  | 'kept-cleared'
  /** No catalog has a live entry for this unit; run `extract` first. */
  | 'not-in-catalog'
  /** The catalog's English differs from the English the draft was aligned against. */
  | 'source-changed'

/** Every outcome, in the order reports list them. */
export const SEED_OUTCOMES: readonly SeedOutcomeKind[] = Object.freeze([
  'seeded',
  'already-seeded',
  'kept-human',
  'kept-draft',
  'kept-cleared',
  'not-in-catalog',
  'source-changed',
])

/** One draft's outcome, by formatted unit id. */
export interface SeedOutcome {
  readonly id: string
  readonly outcome: SeedOutcomeKind
}

/** Options for {@link applySeedDrafts}. */
export interface ApplySeedOptions {
  /** Every catalog must be for this locale. */
  readonly locale: string
  /** Human-readable seed source, e.g. `Kubernetes-Workshop PR #55 by <name> (@handle)`. */
  readonly provenance: string
}

/** Result of {@link applySeedDrafts}. */
export interface ApplySeedResult {
  /** The catalogs, in the order given; untouched ones are returned as the same object. */
  readonly catalogs: readonly Catalog[]
  /** One outcome per draft, ordered by unit id. */
  readonly outcomes: readonly SeedOutcome[]
}

/**
 * True for a character that cannot appear in a one-line PO comment or would disguise one:
 * C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
 */
function isUnsafeLabelChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

/**
 * Validate a provenance label: it becomes a PO comment line, so it must be one line of
 * printable text.
 *
 * @throws {SeedInputError}
 */
export function assertSafeProvenance(label: unknown): string {
  if (typeof label !== 'string' || label.trim() === '') {
    throw new SeedInputError('seed provenance must be a non-empty string')
  }
  if (label.length > MAX_PROVENANCE_LENGTH) {
    throw new SeedInputError(`seed provenance must be at most ${MAX_PROVENANCE_LENGTH} characters`)
  }
  if ([...label].some(isUnsafeLabelChar)) {
    throw new SeedInputError('seed provenance must be one line without control characters')
  }
  return label
}

/** True for a `#.` comment under `key`. */
function hasKey(comment: PoComment, key: string): boolean {
  return comment.marker === '.' && comment.text.trimStart().startsWith(`${key}:`)
}

/** True for the `#.` comment a seed run writes. */
function isSeedComment(comment: PoComment): boolean {
  return hasKey(comment, SEED_COMMENT_KEY)
}

/**
 * The seed comments — provenance, then any warnings — replacing earlier ones at the
 * position the first of them held, or appended after the other comments.
 */
function withSeedComments(
  comments: readonly PoComment[],
  label: string,
  warnings: readonly string[],
): readonly PoComment[] {
  const fresh: PoComment[] = [
    { marker: '.', text: ` ${SEED_COMMENT_KEY}: ${label}` },
    ...(warnings.length === 0
      ? []
      : [{ marker: '.' as const, text: ` ${SEED_WARNING_COMMENT_KEY}: ${warnings.join(', ')}` }]),
  ]
  const owned = (comment: PoComment) =>
    hasKey(comment, SEED_COMMENT_KEY) || hasKey(comment, SEED_WARNING_COMMENT_KEY)
  const index = comments.findIndex(owned)
  const kept = comments.filter((comment) => !owned(comment))
  const at = index < 0 ? kept.length : comments.slice(0, index).filter((c) => !owned(c)).length
  return [...kept.slice(0, at), ...fresh, ...kept.slice(at)]
}

function outcomeFor(entry: CatalogEntry, draft: SeedDraft): SeedOutcomeKind | undefined {
  if (entry.source !== draft.source) return 'source-changed'
  if (!isDraftable(entry)) return 'kept-human'
  if (entry.state === 'missing') {
    return entry.po.comments.some(isSeedComment) ? 'kept-cleared' : undefined
  }
  return entry.translation === draft.translation && entry.state === 'needs-review'
    ? 'already-seeded'
    : 'kept-draft'
}

/**
 * Record seed drafts in whichever catalog holds each unit.
 *
 * Catalogs are located by the unit ids they contain, never by a path or name convention,
 * so this works for any split of catalogs the CLI chooses.
 *
 * @throws {SeedInputError} for a catalog of another locale, a unit id claimed by two
 *   catalogs, an unsafe draft id, or an unusable provenance label.
 */
export function applySeedDrafts(
  catalogs: readonly Catalog[],
  drafts: readonly SeedDraft[],
  options: ApplySeedOptions,
): ApplySeedResult {
  let locale: string
  try {
    locale = assertSafeLocale(options.locale)
  } catch (error) {
    if (error instanceof LocaleError) throw new SeedInputError(error.message, { cause: error })
    throw error
  }
  const label = assertSafeProvenance(options.provenance)

  const owner = new Map<string, number>()
  catalogs.forEach((catalog, index) => {
    if (catalog.identity.locale !== locale) {
      throw new SeedInputError(
        `catalog ${JSON.stringify(catalog.identity.name)} is for locale ${JSON.stringify(catalog.identity.locale)}, not ${JSON.stringify(locale)}`,
      )
    }
    for (const entry of catalog.entries) {
      const key = formatUnitId(entry.id)
      const previous = owner.get(key)
      if (previous !== undefined) {
        throw new SeedInputError(
          `unit ${JSON.stringify(key)} is in catalogs ${JSON.stringify(catalogs[previous]?.identity.name)} and ${JSON.stringify(catalog.identity.name)}; seeding cannot choose between them`,
        )
      }
      owner.set(key, index)
    }
  })

  const result = [...catalogs]
  const outcomes: SeedOutcome[] = []
  const sorted = [...drafts].sort((a, b) => {
    const left = formatUnitId(a.id)
    const right = formatUnitId(b.id)
    return left < right ? -1 : left > right ? 1 : 0
  })
  const seen = new Set<string>()
  for (const draft of sorted) {
    assertSafeUnitId(draft.id)
    const id = formatUnitId(draft.id)
    if (seen.has(id)) {
      // Only reachable when the English corpus declares one container id in two files,
      // which `init-ids --check` rejects. Letting the first draft win would be a guess.
      throw new SeedInputError(
        `two drafts target unit ${JSON.stringify(id)}; container ids must be unique across the English corpus`,
      )
    }
    seen.add(id)
    const index = owner.get(id)
    const catalog = index === undefined ? undefined : result[index]
    const entry = catalog?.entries.find((item) => formatUnitId(item.id) === id)
    if (index === undefined || catalog === undefined || entry === undefined) {
      outcomes.push({ id, outcome: 'not-in-catalog' })
      continue
    }
    const kept = outcomeFor(entry, draft)
    if (kept !== undefined) {
      outcomes.push({ id, outcome: kept })
      continue
    }
    const drafted = applyDraftTranslation(catalog, draft.id, draft.translation)
    const entries = drafted.entries.map((item) =>
      formatUnitId(item.id) === id
        ? toCatalogEntry(
            { ...item.po, comments: withSeedComments(item.po.comments, label, draft.warnings) },
            item.id,
          )
        : item,
    )
    result[index] = { ...drafted, entries }
    outcomes.push({ id, outcome: 'seeded' })
  }
  return { catalogs: result, outcomes }
}
