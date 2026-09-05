/**
 * The catalog update algorithm — spec 002 User Story 1.
 *
 * Given a catalog and the units a fresh `extract` produced, decide what happens to every
 * entry. The whole point is that the decision is *narrow*: an English edit must invalidate
 * exactly the approvals it affects and nothing else (SC-001), and a run with no English
 * change must produce the same bytes it read (FR-005, SC-002).
 *
 * The rules, one per requirement:
 *
 * - **FR-001** — a unit whose source did not move keeps its translation, its flags, its
 *   translator comments and its review state verbatim. The only lines this rewrites are
 *   the two tool-owned `#.` provenance comments, and only when their values changed.
 * - **FR-003** — a unit whose source moved becomes `fuzzy` with the old source recorded
 *   in `#| msgid`. Its translation is kept: fuzzy means "revalidate this", not "start over".
 * - **FR-004** — a unit that left the English source becomes a `#~` obsolete entry.
 *   Nothing is deleted. Its provenance is left as it was, because refreshing a reference
 *   to content that no longer exists would be a lie.
 * - **FR-002** — `msgctxt` is the unit id and the `#.` comments carry the reference and
 *   the source hash.
 *
 * Staleness is decided by comparing the recorded `msgid` against the fresh source, with
 * the recorded hash as a cross-check: if a valid recorded hash disagrees with the hash of
 * the `msgid` sitting next to it, someone edited the English inside the catalog by hand
 * and the translation matches neither. That is a change too.
 */

import {
  compareUnitIds,
  formatUnitId,
  sourceHash,
  type TranslationUnit,
  type UnitId,
} from '@workshop-i18n/core'
import {
  type Catalog,
  type CatalogEntry,
  CatalogError,
  type CatalogIdentity,
  emptyCatalog,
  toCatalogEntry,
} from './catalog.js'
import type { PoEntry } from './po-file.js'
import { withProvenance } from './provenance.js'
import { FUZZY_FLAG, NEEDS_REVIEW_FLAG } from './state.js'

/** A freshly extracted unit, plus the human-readable pointer recorded alongside it. */
export interface ExtractedUnit extends TranslationUnit {
  /** Where this unit came from, for the `#.` source comment. Free-form and human-facing. */
  readonly reference?: string | undefined
}

/**
 * What one update did, by formatted unit id. Every unit in the fresh set lands in exactly
 * one of `added`, `unchanged`, `fuzzied` or `resurrected`; every unit that left the
 * English source lands in `obsoleted`. Each list is ordered by `compareUnitIds`.
 */
export interface UpdateSummary {
  /** Units with no prior entry at all. They enter as `missing`. */
  readonly added: readonly string[]
  /** Units whose source did not move. Their entries were not touched. */
  readonly unchanged: readonly string[]
  /** Units whose source moved: now `fuzzy`, with the previous source recorded. */
  readonly fuzzied: readonly string[]
  /** Units that were obsolete and are back in the English source, with their work. */
  readonly resurrected: readonly string[]
  /** Units that left the English source. Their entries became `#~`, not deleted. */
  readonly obsoleted: readonly string[]
}

/** Result of {@link updateCatalog}. */
export interface UpdateResult {
  readonly catalog: Catalog
  readonly summary: UpdateSummary
}

/** Options for {@link updateCatalog}. */
export interface UpdateCatalogOptions {
  readonly identity: CatalogIdentity
  /** The freshly extracted units for this catalog. */
  readonly units: readonly ExtractedUnit[]
  /** The catalog as it stands; omit for one that does not exist yet. */
  readonly previous?: Catalog | undefined
}

function provenanceComments(entry: PoEntry, unit: ExtractedUnit): PoEntry {
  const comments = withProvenance(entry.comments, unit.reference, unit.sourceHash)
  return { ...entry, comments }
}

function newEntry(unit: ExtractedUnit): PoEntry {
  return provenanceComments(
    {
      comments: [],
      flags: [],
      msgctxt: formatUnitId(unit.id),
      msgid: unit.source,
      msgstr: [''],
      obsolete: false,
      line: 0,
    },
    unit,
  )
}

/** Carry an unchanged (or revived) entry forward, refreshing only tool-owned lines. */
function carryForward(entry: CatalogEntry, unit: ExtractedUnit): PoEntry {
  const base = entry.po.obsolete ? { ...entry.po, obsolete: false } : entry.po
  return provenanceComments(base, unit)
}

/** Apply FR-003 to an entry whose English moved. */
function markFuzzy(entry: CatalogEntry, unit: ExtractedUnit): PoEntry {
  const base = entry.po.obsolete ? { ...entry.po, obsolete: false } : entry.po
  const flags = base.flags.includes(FUZZY_FLAG) ? base.flags : [...base.flags, FUZZY_FLAG]
  return provenanceComments(
    {
      ...base,
      flags,
      // The previous source is the msgid this translation was actually made against,
      // which is the one we are replacing — not whatever an earlier round recorded.
      previous: { ...base.previous, msgid: entry.source },
      msgid: unit.source,
    },
    unit,
  )
}

/**
 * Has the English behind this entry moved? The `msgid` comparison is primary; the
 * recorded hash catches a catalog whose English was hand-edited without its anchor being
 * updated, where the `msgid` alone would look current.
 */
function sourceMoved(entry: CatalogEntry, unit: ExtractedUnit): boolean {
  if (entry.source !== unit.source) return true
  return entry.recordedHash !== undefined && entry.recordedHash !== sourceHash(entry.source)
}

/**
 * Update a catalog against a fresh set of extracted units.
 *
 * @throws {CatalogError} when the fresh set contains the same unit id twice — an
 *   extractor bug that would otherwise silently collapse two units into one entry.
 */
export function updateCatalog(options: UpdateCatalogOptions): UpdateResult {
  const { identity, units } = options
  const previous = options.previous ?? emptyCatalog(identity)

  const live = new Map(previous.entries.map((entry) => [formatUnitId(entry.id), entry]))
  const dead = new Map(previous.obsolete.map((entry) => [formatUnitId(entry.id), entry]))

  const added: string[] = []
  const unchanged: string[] = []
  const fuzzied: string[] = []
  const resurrected: string[] = []
  const obsoleted: string[] = []

  const sorted = [...units].sort((a, b) => compareUnitIds(a.id, b.id))
  const seen = new Set<string>()
  const entries: CatalogEntry[] = []

  for (const unit of sorted) {
    const key = formatUnitId(unit.id)
    if (seen.has(key)) {
      throw new CatalogError(
        undefined,
        `extracted unit id ${JSON.stringify(key)} appears twice in catalog ${JSON.stringify(identity.name)}`,
      )
    }
    seen.add(key)

    const existing = live.get(key)
    const revived = existing === undefined ? dead.get(key) : undefined
    const base = existing ?? revived

    if (base === undefined) {
      added.push(key)
      entries.push(toCatalogEntry(newEntry(unit), unit.id))
      continue
    }

    const moved = sourceMoved(base, unit)
    const po = moved ? markFuzzy(base, unit) : carryForward(base, unit)
    if (revived !== undefined) resurrected.push(key)
    else if (moved) fuzzied.push(key)
    else unchanged.push(key)
    entries.push(toCatalogEntry(po, unit.id))
  }

  const obsolete: CatalogEntry[] = []
  for (const [key, entry] of live) {
    if (seen.has(key)) continue
    obsoleted.push(key)
    obsolete.push(toCatalogEntry({ ...entry.po, obsolete: true }, entry.id))
  }
  for (const [key, entry] of dead) {
    if (seen.has(key)) continue
    obsolete.push(entry)
  }

  const byId = (a: CatalogEntry, b: CatalogEntry) => compareUnitIds(a.id, b.id)
  return {
    catalog: {
      identity,
      header: previous.header,
      entries: entries.sort(byId),
      obsolete: obsolete.sort(byId),
    },
    summary: {
      added: added.sort(),
      unchanged: unchanged.sort(),
      fuzzied: fuzzied.sort(),
      resurrected: resurrected.sort(),
      obsoleted: obsoleted.sort(),
    },
  }
}

/**
 * May a draft be written over this entry? True when no human wrote what is there:
 *
 * - `missing` — nothing is there;
 * - `needs-review` — an earlier draft, which is machine work;
 * - `fuzzy` **while still carrying {@link NEEDS_REVIEW_FLAG}** — a machine draft whose
 *   English moved under it, which is still machine work.
 *
 * That last case is why this reads flags rather than the collapsed {@link CatalogEntry.state}.
 * `fuzzy` takes precedence in the state mapping, so a seeded unit whose source later
 * changed reports `fuzzy` and the state alone can no longer tell whether a human ever
 * touched it. The catalog still knows — `needs-review` is right there on the entry — and
 * discarding that would make a machine-seeded unit permanently un-re-seedable while
 * telling the operator, falsely, that it was protecting human work.
 *
 * A `fuzzy` entry *without* that marker is a human's translation waiting to be
 * revalidated against a moved source, and stays protected: on spec 004 FR-001's plain
 * reading it is a human-touched entry.
 *
 * A bulk seeding pass filters on this; {@link applyDraftTranslation} enforces it. Both
 * exist because spec 004 FR-001 requires seeding to never overwrite a human-touched
 * entry, and a predicate callers can ask *before* acting is friendlier than a thrown
 * error they must catch per unit.
 */
export function isDraftable(entry: CatalogEntry): boolean {
  if (entry.state === 'missing' || entry.state === 'needs-review') return true
  return entry.state === 'fuzzy' && entry.po.flags.includes(NEEDS_REVIEW_FLAG)
}

/**
 * Record a drafted translation — seeded, machine translated, or imported — as
 * `needs-review` (spec 002 FR-007, ADR 0009, constitution V).
 *
 * There is deliberately no counterpart that produces `reviewed`. A draft becomes
 * shipping-grade only through a human action outside this tool: a reviewer accepting it
 * in the TMS, or a maintainer merging the catalog change in a PR. A function here that
 * could set `reviewed` would be a path for unreviewed prose to ship silently, which is
 * the one thing constitution V forbids.
 *
 * ## It overwrites, so it refuses human work
 *
 * This replaces `msgstr` outright — there is nowhere in a PO entry to keep a displaced
 * translation, since `#|` carries previous *source*, not previous translation. So it
 * writes only where {@link isDraftable} holds. A `reviewed` entry is a human's accepted
 * prose and a `fuzzy` entry is a human's prose waiting to be revalidated against a moved
 * source — the translator's workflow there is to edit what is already written next to
 * `#| msgid`, and a machine draft dropped on top of it destroys exactly that. Spec 004
 * FR-001 states the rule; this is where it is enforced.
 *
 * Demoting the state would not have made an overwrite safe: nothing unreviewed would
 * *ship*, but the human's work would still be gone.
 *
 * A stale `fuzzy` marker is only ever cleared on an entry that had no human translation
 * under it — either nothing was there, or what was there was an earlier draft. The entry
 * stays gated by {@link NEEDS_REVIEW_FLAG} either way, and the `#|` previous-source goes
 * with the translation it was context for.
 *
 * @throws {CatalogError} when the catalog has no live entry for `id`; when the entry
 *   holds human work ({@link isDraftable} is false); or when the draft is empty — an
 *   empty msgstr reads as `missing`, so accepting one would leave a `needs-review` flag
 *   on a unit that has nothing to review.
 */
export function applyDraftTranslation(catalog: Catalog, id: UnitId, translation: string): Catalog {
  const key = formatUnitId(id)
  if (translation === '') {
    throw new CatalogError(
      undefined,
      `refusing to record an empty draft for unit id ${JSON.stringify(key)}`,
    )
  }
  const index = catalog.entries.findIndex((entry) => formatUnitId(entry.id) === key)
  if (index < 0) {
    throw new CatalogError(undefined, `catalog has no entry for unit id ${JSON.stringify(key)}`)
  }
  const entry = catalog.entries[index]
  if (entry === undefined) {
    throw new CatalogError(undefined, `catalog has no entry for unit id ${JSON.stringify(key)}`)
  }

  if (!isDraftable(entry)) {
    // Only reachable for `reviewed`, and for `fuzzy` with no draft marker — both of
    // which are human work. The message may never call a machine draft human-authored,
    // so it says which marker it looked for and did not find.
    throw new CatalogError(
      undefined,
      `refusing to overwrite the human-authored translation of unit id ${JSON.stringify(key)} ` +
        `(state ${JSON.stringify(entry.state)}) with a draft: it carries no ` +
        `${JSON.stringify(NEEDS_REVIEW_FLAG)} flag, so it is not a machine draft`,
    )
  }

  const flags = entry.po.flags.filter((flag) => flag !== FUZZY_FLAG)
  if (!flags.includes(NEEDS_REVIEW_FLAG)) flags.push(NEEDS_REVIEW_FLAG)

  // Drop `#|` along with the translation it described. Previous-source is diff context
  // for revalidating a *specific* translation; once that text is replaced, a `#| msgid`
  // left behind points at prose no longer in the file — and after F-3 this path is
  // reachable with the marker still on, so `#, needs-review` would sit beside a stale
  // `#| msgid` for a translation nobody can see.
  const po: PoEntry = { ...entry.po, flags, msgstr: [translation], previous: undefined }
  const entries = [...catalog.entries]
  entries[index] = toCatalogEntry(po, id)
  return { ...catalog, entries }
}
