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
 * equals the candidate is left exactly as it is (`already-seeded`).
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

/** The seed comment, replacing an earlier one in place or appended after the others. */
function withSeedComment(comments: readonly PoComment[], label: string): readonly PoComment[] {
  const fresh: PoComment = { marker: '.', text: ` ${SEED_COMMENT_KEY}: ${label}` }
  const isSeed = (comment: PoComment) =>
    comment.marker === '.' && comment.text.trimStart().startsWith(`${SEED_COMMENT_KEY}:`)
  const index = comments.findIndex(isSeed)
  if (index < 0) return [...comments, fresh]
  return comments
    .filter((comment, at) => at === index || !isSeed(comment))
    .map((comment) => (isSeed(comment) ? fresh : comment))
}

function outcomeFor(entry: CatalogEntry, draft: SeedDraft): SeedOutcomeKind | undefined {
  if (entry.source !== draft.source) return 'source-changed'
  if (!isDraftable(entry)) return 'kept-human'
  if (entry.state === 'missing') return undefined
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
  for (const draft of sorted) {
    assertSafeUnitId(draft.id)
    const id = formatUnitId(draft.id)
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
            { ...item.po, comments: withSeedComment(item.po.comments, label) },
            item.id,
          )
        : item,
    )
    result[index] = { ...drafted, entries }
    outcomes.push({ id, outcome: 'seeded' })
  }
  return { catalogs: result, outcomes }
}
