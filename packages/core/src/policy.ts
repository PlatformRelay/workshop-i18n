/**
 * Counting translation states and evaluating release policy (spec 002 FR-006).
 *
 * `status` needs two things: a per locale x section tally to show a human, and a
 * machine-readable verdict for CI. Both live here as pure functions. Deciding what to
 * *do* about a verdict — the exit code, the message, whether `--strict` compose aborts —
 * belongs to the CLI (ADR 0003: exit codes carry policy), so nothing in this module
 * returns or implies one.
 */

import { isUnitState, UNIT_STATES, type UnitState } from './unit.js'
import { compareUnitIds, formatUnitId, type UnitId } from './unit-id.js'

/** One unit's translation state in one locale, as read from a catalog. */
export interface UnitStatus {
  readonly id: UnitId
  /** Target locale, e.g. `de` or `pt-BR`. */
  readonly locale: string
  /** Section (or catalog) the unit belongs to — the grouping `status` reports by. */
  readonly section: string
  readonly state: UnitState
  /**
   * Whether this unit must be *translated* for the locale to ship. Defaults to `true`;
   * set `false` for content a locale may legitimately leave in English.
   *
   * ## What it does not mean
   *
   * `required: false` means "may ship in English". It never means "may ship
   * unreviewed" — see {@link OPTIONAL_EXEMPT_STATES}. A `needs-review` unit stays
   * gated whatever this flag says, because that state ships drafted prose, not English.
   *
   * ## Where it may come from
   *
   * Constitution V now hangs off this field, so its provenance is part of the contract:
   * it MUST come from an operator decision — a manifest declaration or an explicit CLI
   * flag, both of which get PR review. It MUST NOT be derived from catalog content: not
   * a PO flag, not a translator comment, not a TMS field, not anything a seeding or MT
   * pass can write. Those are precisely the surfaces unreviewed drafts arrive on, and
   * letting them set this flag would let content decide whether human review is
   * required. Populate it from the manifest, or leave it unset; never from the `.po`
   * file you are reading states out of.
   */
  readonly required?: boolean
}

/** Count of units in each state. Always carries every state, zero-filled. */
export type StateCounts = Readonly<Record<UnitState, number>>

/** A fresh all-zero {@link StateCounts}. */
export function emptyStateCounts(): StateCounts {
  return { missing: 0, fuzzy: 0, 'needs-review': 0, reviewed: 0 }
}

/** Tally for one section of one locale. */
export interface SectionStateCounts {
  readonly section: string
  readonly total: number
  readonly counts: StateCounts
}

/** Tally for one locale, plus its sections in stable order. */
export interface LocaleStateCounts {
  readonly locale: string
  readonly total: number
  readonly counts: StateCounts
  readonly sections: readonly SectionStateCounts[]
}

/** The whole `status` tally: every locale, plus corpus-wide totals. */
export interface StateReport {
  readonly locales: readonly LocaleStateCounts[]
  readonly total: number
  readonly totals: StateCounts
}

/**
 * Thrown when one unit id appears twice in the same locale — spec 002's "unit id
 * collisions after a bad manual edit" edge case. Both entries are named so the
 * offending catalog lines are findable.
 */
export class DuplicateUnitError extends Error {
  readonly unitId: string
  readonly locale: string
  readonly sections: readonly [string, string]

  constructor(unitId: string, locale: string, sections: readonly [string, string]) {
    super(
      `duplicate unit id ${JSON.stringify(unitId)} in locale ${JSON.stringify(locale)}: ` +
        `sections ${JSON.stringify(sections[0])} and ${JSON.stringify(sections[1])}`,
    )
    this.name = 'DuplicateUnitError'
    this.unitId = unitId
    this.locale = locale
    this.sections = sections
  }
}

/**
 * Thrown when a unit carries a state this release does not know. Catalog layers map
 * gettext flags onto {@link UnitState}, and a mapping bug must stop the run rather than
 * pass through: an unknown state matches no ceiling, so it would be gated by nothing,
 * and counting it would put a phantom key and a `NaN` into the report that spec 002
 * SC-003 says both workshops' CI can consume without post-processing (`NaN` serialises
 * to `null`). This is the same rule `definePolicy` applies to unknown threshold keys.
 */
export class UnknownUnitStateError extends Error {
  readonly unitId: string
  readonly locale: string
  readonly state: string

  constructor(unitId: string, locale: string, state: unknown) {
    super(
      `unit ${JSON.stringify(unitId)} in locale ${JSON.stringify(locale)} has unknown ` +
        `translation state ${JSON.stringify(String(state))} — known states are ` +
        `${UNIT_STATES.join(', ')}`,
    )
    this.name = 'UnknownUnitStateError'
    this.unitId = unitId
    this.locale = locale
    this.state = String(state)
  }
}

function bump(counts: Record<UnitState, number>, state: UnitState): void {
  counts[state] += 1
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Tally unit states per locale and section. Deterministic: locales and sections come
 * back in code-unit order regardless of input order, so `status --json` is diffable
 * (spec 002 SC-003).
 *
 * **It tallies what it is handed, and cannot see what it is not.** A locale whose
 * catalogs are empty — or absent, or filtered out by a bad glob — produces no rows here,
 * so it reports zero of everything and satisfies `release`: an untranslated locale
 * looks finished. The fix is to build the input from the English unit set rather than
 * from the catalog, which is what {@link statusesForLocale} does. Call that first.
 *
 * @throws {DuplicateUnitError} when a unit id repeats within one locale.
 */
export function tallyUnitStates(units: Iterable<UnitStatus>): StateReport {
  const locales = new Map<
    string,
    { counts: Record<UnitState, number>; sections: Map<string, Record<UnitState, number>> }
  >()
  // Duplicate detection is keyed locale -> unit id -> section. A nested map rather than
  // a joined string key: any separator character can occur inside a locale or an id, and
  // the separator this once used was a raw NUL byte, which made the whole file undiffable.
  const seen = new Map<string, Map<string, string>>()
  const totals: Record<UnitState, number> = { ...emptyStateCounts() }
  let total = 0

  for (const unit of units) {
    const id = formatUnitId(unit.id)
    let seenInLocale = seen.get(unit.locale)
    if (seenInLocale === undefined) {
      seenInLocale = new Map()
      seen.set(unit.locale, seenInLocale)
    }
    const previousSection = seenInLocale.get(id)
    if (previousSection !== undefined) {
      throw new DuplicateUnitError(id, unit.locale, [previousSection, unit.section])
    }
    seenInLocale.set(id, unit.section)

    if (!isUnitState(unit.state)) {
      throw new UnknownUnitStateError(id, unit.locale, unit.state)
    }

    let locale = locales.get(unit.locale)
    if (locale === undefined) {
      locale = { counts: { ...emptyStateCounts() }, sections: new Map() }
      locales.set(unit.locale, locale)
    }
    let section = locale.sections.get(unit.section)
    if (section === undefined) {
      section = { ...emptyStateCounts() }
      locale.sections.set(unit.section, section)
    }

    bump(locale.counts, unit.state)
    bump(section, unit.state)
    bump(totals, unit.state)
    total += 1
  }

  // Frozen like `POLICIES`: a report is evidence, and evidence a consumer can edit in
  // place is not evidence. It is also the `status --json` payload, so callers that hold
  // it while rendering must not be able to change what was measured.
  return Object.freeze({
    total,
    totals: Object.freeze(totals),
    locales: Object.freeze(
      [...locales.entries()]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([locale, data]) =>
          Object.freeze({
            locale,
            total: UNIT_STATES.reduce((sum, state) => sum + data.counts[state], 0),
            counts: Object.freeze(data.counts),
            sections: Object.freeze(
              [...data.sections.entries()]
                .sort(([a], [b]) => compareStrings(a, b))
                .map(([section, counts]) =>
                  Object.freeze({
                    section,
                    total: UNIT_STATES.reduce((sum, state) => sum + counts[state], 0),
                    counts: Object.freeze(counts),
                  }),
                ),
            ),
          }),
        ),
    ),
  })
}

/**
 * An English unit as extraction knows it: identity, the section it reports under, and
 * whether a locale must translate it.
 *
 * `section` and `required` live on this side of the boundary on purpose. They describe
 * the *source*, so they come from extraction and the manifest — operator-owned, PR-
 * reviewed inputs — and never from a catalog, where a translator, a TMS or a seeding
 * pass could set them (see {@link UnitStatus.required}).
 */
export interface SourceUnit {
  readonly id: UnitId
  readonly section: string
  readonly required?: boolean
}

/**
 * Project the English unit set onto one locale's known states — the input
 * {@link tallyUnitStates} and {@link evaluatePolicy} actually want.
 *
 * Every English unit appears in the result. A unit the catalog has no entry for is
 * `missing`, which is what makes an empty or absent catalog fail `release` instead of
 * passing it (see the note on {@link tallyUnitStates}). An entry whose id is no longer
 * in the English set is dropped: spec 002 FR-004 keeps those in the PO as obsolete
 * entries so the translation survives, but they describe content that no longer exists
 * and must not count toward a gate.
 *
 * Only `state` is taken from the catalog. `section` and `required` come from the source
 * unit, so a catalog cannot relabel a unit into another section or mark itself optional.
 *
 * This lives in core, and is pure, because `status` and `compose --strict` both need it:
 * spec 003 SC-003 only holds if they agree on the unit set, and two lanes synthesising
 * "what should exist in this locale" separately is the obvious way for them to disagree.
 *
 * @throws {DuplicateUnitError} when an id repeats in `source` or in `known`.
 * @throws {UnknownUnitStateError} when a known entry carries an unrecognised state.
 */
export function statusesForLocale(
  source: Iterable<SourceUnit>,
  known: Iterable<UnitStatus>,
  locale: string,
): readonly UnitStatus[] {
  const states = new Map<string, UnitState>()
  const sections = new Map<string, string>()
  for (const entry of known) {
    if (entry.locale !== locale) continue
    const id = formatUnitId(entry.id)
    const previous = sections.get(id)
    if (previous !== undefined) {
      throw new DuplicateUnitError(id, locale, [previous, entry.section])
    }
    if (!isUnitState(entry.state)) {
      throw new UnknownUnitStateError(id, locale, entry.state)
    }
    sections.set(id, entry.section)
    states.set(id, entry.state)
  }

  const seen = new Map<string, string>()
  const statuses: UnitStatus[] = []
  for (const unit of source) {
    const id = formatUnitId(unit.id)
    const previous = seen.get(id)
    if (previous !== undefined) {
      throw new DuplicateUnitError(id, locale, [previous, unit.section])
    }
    seen.set(id, unit.section)
    statuses.push({
      id: unit.id,
      locale,
      section: unit.section,
      state: states.get(id) ?? 'missing',
      ...(unit.required === undefined ? {} : { required: unit.required }),
    })
  }
  return statuses.sort((a, b) => compareUnitIds(a.id, b.id))
}

/** Maximum number of gated units allowed in each state. An absent state is ungated. */
export type StateThresholds = { readonly [S in UnitState]?: number }

/** A named gate over state counts (spec 002, "Policy"). */
export interface Policy {
  readonly name: string
  /** Per-locale ceilings. `{ fuzzy: 0 }` means "no locale may ship a fuzzy unit". */
  readonly maxRequired: StateThresholds
  /** When true, units marked `required: false` are gated as well. Defaults to false. */
  readonly gateOptionalUnits: boolean
}

/**
 * Build a custom policy, validating its thresholds.
 *
 * Unknown state keys are rejected rather than ignored, for the same reason the manifest
 * rejects unknown keys: a misspelled `needsReview: 0` that parses as "no ceiling" is a
 * gate the author believes they have and does not, which is the failure mode this whole
 * layer exists to prevent.
 *
 * The thresholds are copied and the result is frozen, so a policy cannot be weakened
 * later through the object the caller still holds.
 */
/** Policies this module built, and therefore already validated and froze. */
const VALIDATED_POLICIES = new WeakSet<Policy>()

export function definePolicy(
  name: string,
  maxRequired: StateThresholds,
  options?: { readonly gateOptionalUnits?: boolean },
): Policy {
  const thresholds: Record<string, number> = {}
  for (const [key, limit] of Object.entries(maxRequired)) {
    if (!isUnitState(key)) {
      throw new Error(
        `policy ${JSON.stringify(name)}: ${JSON.stringify(key)} is not a translation state — ` +
          `known states are ${UNIT_STATES.join(', ')}`,
      )
    }
    if (limit === undefined) continue
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      throw new Error(
        `policy ${JSON.stringify(name)}: threshold for ${key} must be a non-negative integer, ` +
          `got ${JSON.stringify(limit)}`,
      )
    }
    thresholds[key] = limit
  }
  const policy = Object.freeze({
    name,
    maxRequired: Object.freeze(thresholds) as StateThresholds,
    gateOptionalUnits: options?.gateOptionalUnits === true,
  })
  VALIDATED_POLICIES.add(policy)
  return policy
}

/** The built-in policy names. */
export type PolicyName = 'release' | 'preview'

/**
 * The built-in policies.
 *
 * `release` is the shipping gate: zero missing, zero fuzzy, and zero `needs-review`
 * required units. `needs-review` is listed explicitly because constitution V forbids
 * shipping prose no human has accepted — a seeded or machine-drafted entry must never
 * satisfy a release, and leaving it out of this list is exactly how it would.
 *
 * `preview` gates nothing on translation state, and that is the whole point: preview
 * composition renders missing and fuzzy units as watermarked English fallback (ADR
 * 0009), so an incomplete locale is the expected, useful state. It exists as a named
 * policy so `status --policy preview` produces the same machine-readable shape as
 * `release`, and so a consumer that wants a floor ("no more than 20 missing before we
 * bother reviewers") tightens it with {@link definePolicy} rather than inventing one.
 *
 * Deep-frozen: a release gate that any imported module could edit in place is not a
 * gate, and a policy that changes under a running process breaks the same-input,
 * same-output promise this module is built on (constitution IV).
 */
export const POLICIES: Readonly<Record<PolicyName, Policy>> = Object.freeze({
  release: definePolicy('release', { missing: 0, fuzzy: 0, 'needs-review': 0 }),
  preview: definePolicy('preview', {}),
})

/** Type guard for a built-in policy name. */
export function isPolicyName(value: unknown): value is PolicyName {
  return typeof value === 'string' && Object.hasOwn(POLICIES, value)
}

/**
 * Resolve a policy name to a {@link Policy}. A policy this module built passes through
 * unchanged; any other object is re-run through {@link definePolicy}, which validates
 * its keys and thresholds and returns a frozen copy.
 *
 * The re-run is the point. TypeScript's excess-property check does not apply to a value
 * read from JSON, which is exactly what a `--policy-file` flag will hand this function,
 * so `{ name: 'ours', maxRequired: { fuzzzy: 0 } }` type-checks, gates nothing and
 * reports success — the silent gate-disable `definePolicy` already refuses when it is
 * the one being called.
 */
export function resolvePolicy(policy: Policy | PolicyName): Policy {
  if (typeof policy === 'string') {
    if (!isPolicyName(policy)) {
      throw new Error(
        `unknown policy ${JSON.stringify(policy)}: known policies are ` +
          `${Object.keys(POLICIES).sort().join(', ')}`,
      )
    }
    return POLICIES[policy]
  }
  if (VALIDATED_POLICIES.has(policy)) return policy
  if (typeof policy?.name !== 'string') {
    throw new Error(`invalid policy: name must be a string, got ${typeof policy?.name}`)
  }
  return definePolicy(policy.name, policy.maxRequired ?? {}, {
    gateOptionalUnits: policy.gateOptionalUnits === true,
  })
}

/** A unit that broke a policy, with the section a reviewer should look in. */
export interface ViolatingUnit {
  readonly id: string
  readonly section: string
}

/** One locale exceeding one state's ceiling. */
export interface StatePolicyViolation {
  /** Discriminator — see {@link PolicyViolation}. */
  readonly kind: 'state'
  readonly locale: string
  readonly state: UnitState
  /** The policy's ceiling for this state. */
  readonly limit: number
  /** How many gated units are in this state. */
  readonly count: number
  /** Every offending unit, ordered by id — the review queue, not a sample. */
  readonly units: readonly ViolatingUnit[]
}

/**
 * Why a policy was not satisfied.
 *
 * A discriminated union with one member today. The discriminator exists now because
 * spec 002 FR-006 wants `status` to report override staleness and spec 003 FR-005 makes
 * `--strict` fail on it, and an override is stale independently of any `UnitState` — so
 * a violation that is not keyed by state has to be expressible. Adding
 * `{ kind: 'override-stale', ... }` later must not be a breaking change for the five
 * lanes coding against this type, and it will not be if consumers switch on `kind` and
 * treat an unrecognised kind as a violation rather than ignoring it. Narrow before
 * reading `state`.
 */
export type PolicyViolation = StatePolicyViolation

/** The machine-readable verdict. Carries no exit code by design. */
export interface PolicyEvaluation {
  readonly policy: string
  readonly satisfied: boolean
  readonly violations: readonly PolicyViolation[]
  readonly report: StateReport
}

/**
 * The only states a `required: false` unit is excused from.
 *
 * The rule is drawn from what composition actually emits (spec 003 FR-005): a `missing`
 * or `fuzzy` unit composes as English under a visible fallback watermark, so excusing
 * it ships English that a reviewer can see is English — which is exactly what "this
 * unit may stay untranslated" is asking for. A `needs-review` unit composes its drafted
 * translation with no watermark at all; excusing it would ship machine-drafted prose
 * that no human accepted, behind a green release gate, invisibly. Constitution V
 * forbids creating that path, so optionality stops at the watermark: `needs-review` is
 * gated for every unit, required or not.
 *
 * `fuzzy` is in this list deliberately rather than by omission. A fuzzy unit has an
 * outdated translation *and* a watermarked English fallback, so an optional unit going
 * fuzzy is the same visible outcome as it never being translated. A policy that wants
 * fuzzy gated regardless sets `gateOptionalUnits`.
 */
export const OPTIONAL_EXEMPT_STATES: readonly UnitState[] = Object.freeze(['missing', 'fuzzy'])

function gatedBy(unit: UnitStatus, policy: Policy): boolean {
  if (unit.required !== false) return true
  if (policy.gateOptionalUnits) return true
  return !OPTIONAL_EXEMPT_STATES.includes(unit.state)
}

/**
 * Whether `policy` holds this unit to its ceilings.
 *
 * Exported because spec 003 SC-003 requires `compose --strict` and
 * `status --policy release` to gate on the *same* units: if compose re-derives "does
 * this unit block a release" from `state` and `required` itself, the two answers drift
 * the first time either rule changes, and the guarantee dies quietly. Both lanes call
 * this — or {@link gatedUnits} — instead of reimplementing it.
 *
 * @throws {UnknownUnitStateError} when the unit carries a state this release does not know.
 */
export function isGated(unit: UnitStatus, policy: Policy | PolicyName): boolean {
  if (!isUnitState(unit.state)) {
    throw new UnknownUnitStateError(formatUnitId(unit.id), unit.locale, unit.state)
  }
  return gatedBy(unit, resolvePolicy(policy))
}

/**
 * The units `policy` gates, ordered by locale then unit id. The set `compose --strict`
 * must consider, and the set every {@link PolicyViolation} draws from.
 *
 * @throws {UnknownUnitStateError} when a unit carries a state this release does not know.
 */
export function gatedUnits(
  units: Iterable<UnitStatus>,
  policy: Policy | PolicyName,
): readonly UnitStatus[] {
  const resolved = resolvePolicy(policy)
  return [...units]
    .filter((unit) => isGated(unit, resolved))
    .sort(
      (a, b) =>
        compareStrings(a.locale, b.locale) ||
        compareStrings(formatUnitId(a.id), formatUnitId(b.id)),
    )
}

/**
 * Evaluate a policy over unit states. Pure: it reports what is wrong and leaves what to
 * do about it to the caller.
 *
 * **Building the input:** `UnitStatus.required` decides whether constitution V's gate
 * applies to a unit, so it must come from an operator decision — the manifest or an
 * explicit CLI flag, both PR-reviewed — and never from catalog content: not a PO flag,
 * not a translator comment, not a TMS or seeding field. Content that can set this flag
 * is content deciding whether a human has to review it. Leaving it unset is safe: it
 * defaults to required. See {@link UnitStatus.required}.
 *
 * @throws {DuplicateUnitError} when a unit id repeats within one locale.
 * @throws {UnknownUnitStateError} when a unit carries a state this release does not know.
 */
export function evaluatePolicy(
  units: Iterable<UnitStatus>,
  policy: Policy | PolicyName,
): PolicyEvaluation {
  const resolved = resolvePolicy(policy)
  const all = [...units]
  const report = tallyUnitStates(all)

  const gated = new Map<string, Map<UnitState, ViolatingUnit[]>>()
  for (const unit of all) {
    if (!gatedBy(unit, resolved)) continue
    let byState = gated.get(unit.locale)
    if (byState === undefined) {
      byState = new Map()
      gated.set(unit.locale, byState)
    }
    const bucket = byState.get(unit.state)
    const entry: ViolatingUnit = { id: formatUnitId(unit.id), section: unit.section }
    if (bucket === undefined) byState.set(unit.state, [entry])
    else bucket.push(entry)
  }

  const violations: PolicyViolation[] = []
  for (const { locale } of report.locales) {
    const byState = gated.get(locale)
    if (byState === undefined) continue
    for (const state of UNIT_STATES) {
      const limit = resolved.maxRequired[state]
      if (limit === undefined) continue
      const offenders = byState.get(state) ?? []
      if (offenders.length <= limit) continue
      violations.push({
        kind: 'state',
        locale,
        state,
        limit,
        count: offenders.length,
        units: [...offenders].sort((a, b) => compareStrings(a.id, b.id)),
      })
    }
  }

  return { policy: resolved.name, satisfied: violations.length === 0, violations, report }
}
