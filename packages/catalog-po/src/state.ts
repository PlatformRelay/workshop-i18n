/**
 * The gettext <-> `UnitState` mapping (spec 002 "Entry state mapping").
 *
 * ADR 0013 puts this here rather than in `packages/core`: core is the pure domain model
 * and must not grow a gettext dependency, and the flag conventions are a property of the
 * exchange format, not of the domain.
 *
 * ## It maps state, and only state
 *
 * This module answers exactly one question — *what is the translation lifecycle state of
 * this entry?* — and its return type is core's four-value {@link UnitState}. It must
 * never answer, influence, or provide input to a second question: *does this unit need
 * human review at all?*
 *
 * That second question is `UnitStatus.required`, and constitution V hangs off it.
 * Requiredness comes only from an operator decision — a manifest declaration or an
 * explicit CLI flag, both of which get PR review. A PO flag, a translator comment, a
 * TMS-written field, or anything else inside a catalog MUST NOT be able to produce
 * `required: false`, because those are precisely the surfaces a seeding or machine
 * translation pass writes to. Letting catalog content set that flag would let content
 * decide whether a human must look at it.
 *
 * If a future change here is tempted to return more than a `UnitState` — an "approved"
 * boolean, a "skip review" hint, anything derived from a flag that sounds like
 * permission — that is the change constitution V forbids. Core enforces the same
 * boundary from the other side: `statusesForLocale` takes only `state` from the catalog
 * and sources `section` and `required` from the English unit set.
 *
 * ## Totality
 *
 * Core now throws `UnknownUnitStateError` when a producer hands it a state outside the
 * four. This mapping is that producer. Every input — including flag combinations we have
 * never seen — resolves to one of the four states; unknown flags are preserved on the
 * entry but do not participate in the mapping.
 */

import type { UnitState } from '@workshop-i18n/core'
import type { PoEntry } from './po-file.js'

/** gettext's own staleness marker: the source changed under an existing translation. */
export const FUZZY_FLAG = 'fuzzy'

/**
 * Marks a translation that exists but has not been human-accepted — seeded, machine
 * drafted, or imported (spec 002 FR-007, ADR 0009).
 *
 * Removing this flag is the human acceptance action, so nothing in this package writes
 * an entry *without* it on a translator's behalf. Spec 004 pins the exact spelling
 * Weblate uses against a fixture; it is a named constant here so that verification
 * changes one line rather than a scattered literal.
 */
export const NEEDS_REVIEW_FLAG = 'needs-review'

/** True when the entry carries a translation at all — every plural form filled. */
function isTranslated(entry: PoEntry): boolean {
  if (entry.msgstr.length === 0) return false
  return entry.msgstr.every((form) => form !== '')
}

/**
 * Map one PO entry onto core's translation state.
 *
 * - no translation -> `missing` (even when flagged: an empty msgstr is nothing to
 *   revalidate, and `missing` is the more conservative of the two);
 * - `fuzzy` -> `fuzzy`, taking precedence over {@link NEEDS_REVIEW_FLAG} so a stale
 *   draft is never reported as merely undrafted;
 * - {@link NEEDS_REVIEW_FLAG} -> `needs-review`;
 * - otherwise -> `reviewed`.
 *
 * The last rule is what makes human acceptance real: a unit reaches `reviewed` only once
 * a person removed the flag in the TMS, or a person merged the catalog change in a PR.
 * See the module doc for the line this function must never cross.
 */
export function unitStateOf(entry: PoEntry): UnitState {
  if (!isTranslated(entry)) return 'missing'
  if (entry.flags.includes(FUZZY_FLAG)) return 'fuzzy'
  if (entry.flags.includes(NEEDS_REVIEW_FLAG)) return 'needs-review'
  return 'reviewed'
}
