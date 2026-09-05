/** The translatable unit and its per-locale lifecycle. */

import { sourceHash } from './source-hash.js'
import { assertSafeUnitId, type UnitId } from './unit-id.js'

/** Lifecycle of a translation for one unit in one locale (gettext-aligned). */
export type UnitState =
  | 'missing' // no translation yet
  | 'fuzzy' // source changed since translation; needs human revalidation
  | 'needs-review' // drafted (e.g. seeded or machine-assisted); not yet human-accepted
  | 'reviewed' // human-accepted; shipping-grade

/**
 * Every state, in worst-to-best order — the order reports and violations use.
 *
 * Frozen, not merely `as const`: `evaluatePolicy` iterates this array to find the
 * ceilings it enforces, so a module that could splice `needs-review` out of it would
 * flip a release verdict from fail to pass while the frozen policy still read
 * `{'needs-review': 0}`. A readonly type stops a compile; only a freeze stops a
 * process.
 */
export const UNIT_STATES = Object.freeze([
  'missing',
  'fuzzy',
  'needs-review',
  'reviewed',
] as const) satisfies readonly UnitState[]

/** Type guard for {@link UnitState}, for reading a state out of a catalog or JSON. */
export function isUnitState(value: unknown): value is UnitState {
  return typeof value === 'string' && (UNIT_STATES as readonly string[]).includes(value)
}

/** One extracted translatable unit with provenance. */
export interface TranslationUnit {
  readonly id: UnitId
  /** English source text, markdown inline markup left literal. */
  readonly source: string
  /** Hash of the source at extraction time — staleness anchor. */
  readonly sourceHash: string
}

/**
 * Build a unit from an identity and its source text, anchoring it on
 * {@link sourceHash}. Every extractor goes through here so the anchor is computed one
 * way, and so a hostile identity is rejected at the boundary where content enters the
 * tool rather than at the boundary where it leaves.
 *
 * @throws {import('./unit-id.js').UnitIdError} when the identity is unsafe.
 */
export function createTranslationUnit(id: UnitId, source: string): TranslationUnit {
  assertSafeUnitId(id)
  return { id, source, sourceHash: sourceHash(source) }
}
