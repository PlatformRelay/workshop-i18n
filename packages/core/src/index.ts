/**
 * Domain model for workshop localization. Pure types and functions — no I/O.
 *
 * Identity scheme (ADR 0005): every translatable unit carries an explicit, immutable
 * identity that survives source edits and file moves. Slides carry `slideId` in
 * frontmatter; units are addressed as `<surface>:<containerId>:<unitKey>`.
 */

/** Content surface a unit was extracted from. */
export type Surface = 'slides' | 'labs' | 'quiz'

/**
 * Stable unit identity, used as PO `msgctxt`. Never derived from file path,
 * ordinal position, or content hash.
 */
export interface UnitId {
  readonly surface: Surface
  /** Explicit container identity, e.g. a `slideId`, lab id, or quiz question id. */
  readonly containerId: string
  /** Position-independent key of the unit within its container. */
  readonly unitKey: string
}

/** Lifecycle of a translation for one unit in one locale (gettext-aligned). */
export type UnitState =
  | 'missing' // no translation yet
  | 'fuzzy' // source changed since translation; needs human revalidation
  | 'needs-review' // drafted (e.g. seeded or machine-assisted); not yet human-accepted
  | 'reviewed' // human-accepted; shipping-grade

/** One extracted translatable unit with provenance. */
export interface TranslationUnit {
  readonly id: UnitId
  /** English source text, markdown inline markup left literal. */
  readonly source: string
  /** Hash of the source at extraction time — staleness anchor. */
  readonly sourceHash: string
}

export function formatUnitId(id: UnitId): string {
  return `${id.surface}:${id.containerId}:${id.unitKey}`
}

export function parseUnitId(raw: string): UnitId {
  const parts = raw.split(':')
  if (parts.length < 3) {
    throw new Error(`invalid unit id: ${JSON.stringify(raw)}`)
  }
  const [surface, containerId, ...rest] = parts
  if (surface !== 'slides' && surface !== 'labs' && surface !== 'quiz') {
    throw new Error(`invalid surface in unit id: ${JSON.stringify(raw)}`)
  }
  if (containerId === undefined || containerId === '' || rest.join(':') === '') {
    throw new Error(`invalid unit id: ${JSON.stringify(raw)}`)
  }
  return { surface, containerId, unitKey: rest.join(':') }
}
