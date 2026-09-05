import { describe, expect, it } from 'vitest'
import {
  DuplicateUnitError,
  definePolicy,
  emptyStateCounts,
  evaluatePolicy,
  formatUnitId,
  gatedUnits,
  isGated,
  isPolicyName,
  isSurface,
  type LocaleStateCounts,
  OPTIONAL_EXEMPT_STATES,
  POLICIES,
  type Policy,
  type PolicyName,
  parseUnitId,
  QUIZ_SCHEMA_VARIANTS,
  resolvePolicy,
  type SectionStateCounts,
  type SourceUnit,
  type StateThresholds,
  SURFACES,
  type Surface,
  statusesForLocale,
  tallyUnitStates,
  UNIT_STATES,
  type UnitState,
  type UnitStatus,
  UnknownUnitStateError,
} from '../src/index.js'

function unit(
  raw: string,
  locale: string,
  section: string,
  state: UnitState,
  required = true,
): UnitStatus {
  return { id: parseUnitId(raw), locale, section, state, required }
}

const mixed: UnitStatus[] = [
  unit('slides:s01-pods:body/1', 'de', '01-pods', 'reviewed'),
  unit('slides:s01-pods:body/2', 'de', '01-pods', 'fuzzy'),
  unit('slides:s02-nodes:body/1', 'de', '02-nodes', 'missing'),
  unit('slides:s02-nodes:body/2', 'de', '02-nodes', 'needs-review'),
  unit('slides:s01-pods:body/1', 'pt-BR', '01-pods', 'reviewed'),
]

describe('tallyUnitStates', () => {
  it('counts per locale and per section, zero-filling absent states', () => {
    const report = tallyUnitStates(mixed)
    expect(report.locales.map((l) => l.locale)).toEqual(['de', 'pt-BR'])
    const de = report.locales[0]
    expect(de?.total).toBe(4)
    expect(de?.counts).toEqual({ missing: 1, fuzzy: 1, 'needs-review': 1, reviewed: 1 })
    expect(de?.sections.map((s) => s.section)).toEqual(['01-pods', '02-nodes'])
    expect(de?.sections[0]?.counts).toEqual({
      missing: 0,
      fuzzy: 1,
      'needs-review': 0,
      reviewed: 1,
    })
  })

  it('reports totals across locales', () => {
    const report = tallyUnitStates(mixed)
    expect(report.total).toBe(5)
    expect(report.totals).toEqual({ missing: 1, fuzzy: 1, 'needs-review': 1, reviewed: 2 })
  })

  it('is order-independent and deterministic', () => {
    expect(tallyUnitStates([...mixed].reverse())).toEqual(tallyUnitStates(mixed))
  })

  it('handles no units at all', () => {
    const report = tallyUnitStates([])
    expect(report.locales).toEqual([])
    expect(report.total).toBe(0)
    expect(report.totals).toEqual(emptyStateCounts())
  })

  it('rejects a duplicate unit id within one locale, naming both entries', () => {
    const clash = [
      unit('slides:s01-pods:body/1', 'de', '01-pods', 'reviewed'),
      unit('slides:s01-pods:body/1', 'de', '01-pods-split', 'fuzzy'),
    ]
    expect(() => tallyUnitStates(clash)).toThrow(DuplicateUnitError)
    expect(() => tallyUnitStates(clash)).toThrow(/slides:s01-pods:body\/1/)
    expect(() => tallyUnitStates(clash)).toThrow(/01-pods-split/)
  })

  it('rejects an unrecognised state instead of counting it into NaN', () => {
    const bogus = [
      {
        id: parseUnitId('slides:s01-pods:body/1'),
        locale: 'de',
        section: '01-pods',
        state: 'translated',
      } as unknown as UnitStatus,
    ]
    expect(() => tallyUnitStates(bogus)).toThrow(UnknownUnitStateError)
    expect(() => tallyUnitStates(bogus)).toThrow(/translated/)
    expect(() => tallyUnitStates(bogus)).toThrow(/slides:s01-pods:body\/1/)
    expect(() => evaluatePolicy(bogus, 'release')).toThrow(UnknownUnitStateError)
  })

  it('freezes the report it returns', () => {
    const report = tallyUnitStates(mixed)
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.totals)).toBe(true)
    expect(Object.isFrozen(report.locales)).toBe(true)
    const locale = report.locales[0] as LocaleStateCounts
    expect(Object.isFrozen(locale.counts)).toBe(true)
    expect(Object.isFrozen(locale.sections)).toBe(true)
    expect(Object.isFrozen((locale.sections[0] as SectionStateCounts).counts)).toBe(true)
    expect(() => {
      ;(report.totals as Record<UnitState, number>).reviewed = 99
    }).toThrow(TypeError)
  })

  it('produces a report that JSON round-trips with no NaN and consistent totals', () => {
    const report = tallyUnitStates(mixed)
    const json = JSON.stringify(report)
    expect(json).not.toContain('null')
    expect(json).not.toContain('NaN')
    const sum = report.locales.reduce((total, locale) => total + locale.total, 0)
    expect(sum).toBe(report.total)
    for (const locale of report.locales) {
      const sections = locale.sections.reduce((total, section) => total + section.total, 0)
      expect(sections).toBe(locale.total)
      expect(Object.keys(locale.counts).sort()).toEqual([...UNIT_STATES].sort())
    }
  })

  it('allows the same unit id in different locales', () => {
    expect(() => tallyUnitStates(mixed)).not.toThrow()
  })
})

describe('release policy', () => {
  it('is satisfied by a fully reviewed locale', () => {
    const result = evaluatePolicy(
      [
        unit('slides:s01-pods:body/1', 'de', '01-pods', 'reviewed'),
        unit('slides:s01-pods:body/2', 'de', '01-pods', 'reviewed'),
      ],
      'release',
    )
    expect(result.satisfied).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.policy).toBe('release')
  })

  it('never accepts needs-review — a draft is not human-accepted (constitution V)', () => {
    const result = evaluatePolicy(
      [unit('slides:s01-pods:body/1', 'de', '01-pods', 'needs-review')],
      'release',
    )
    expect(result.satisfied).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      locale: 'de',
      state: 'needs-review',
      limit: 0,
      count: 1,
    })
  })

  it('lists the offending unit ids with their sections', () => {
    const result = evaluatePolicy(
      [
        unit('slides:s02-nodes:body/9', 'de', '02-nodes', 'fuzzy'),
        unit('slides:s01-pods:body/1', 'de', '01-pods', 'fuzzy'),
        unit('labs:lab-01:step/3', 'de', '01-pods', 'fuzzy'),
        unit('slides:s01-pods:body/2', 'de', '01-pods', 'reviewed'),
      ],
      'release',
    )
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.count).toBe(3)
    expect(result.violations[0]?.units).toEqual([
      { id: 'labs:lab-01:step/3', section: '01-pods' },
      { id: 'slides:s01-pods:body/1', section: '01-pods' },
      { id: 'slides:s02-nodes:body/9', section: '02-nodes' },
    ])
  })

  it('reports one violation per locale and state, worst state first', () => {
    const result = evaluatePolicy(mixed, 'release')
    expect(result.violations.map((v) => [v.locale, v.state])).toEqual([
      ['de', 'missing'],
      ['de', 'fuzzy'],
      ['de', 'needs-review'],
    ])
  })

  it('lets an optional unit stay untranslated, but still counts it in the report', () => {
    const result = evaluatePolicy(
      [
        unit('slides:s01-pods:note/1', 'de', '01-pods', 'missing', false),
        unit('slides:s01-pods:body/1', 'de', '01-pods', 'reviewed'),
      ],
      'release',
    )
    expect(result.satisfied).toBe(true)
    expect(result.report.locales[0]?.counts.missing).toBe(1)
  })

  it('lets an optional unit be fuzzy — compose watermarks it as English fallback', () => {
    const result = evaluatePolicy(
      [unit('slides:s01-pods:note/1', 'de', '01-pods', 'fuzzy', false)],
      'release',
    )
    expect(result.satisfied).toBe(true)
  })

  it('gates an optional needs-review unit — optional means English, not unreviewed', () => {
    const result = evaluatePolicy(
      [unit('slides:s01-pods:note/1', 'de', '01-pods', 'needs-review', false)],
      'release',
    )
    expect(result.satisfied).toBe(false)
    expect(result.violations[0]).toMatchObject({ state: 'needs-review', count: 1, limit: 0 })
    expect(result.violations[0]?.units[0]?.id).toBe('slides:s01-pods:note/1')
  })

  it('exempts optional units only in the states composition watermarks', () => {
    expect(OPTIONAL_EXEMPT_STATES).toEqual(['missing', 'fuzzy'])
  })

  it('treats a unit with no explicit `required` flag as required', () => {
    const result = evaluatePolicy(
      [{ id: parseUnitId('slides:s01-pods:body/1'), locale: 'de', section: 'x', state: 'missing' }],
      'release',
    )
    expect(result.satisfied).toBe(false)
  })
})

describe('preview policy', () => {
  it('tolerates every incomplete state — preview composes watermarked fallback', () => {
    const result = evaluatePolicy(mixed, 'preview')
    expect(result.satisfied).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('still returns the full report so `status` has the same shape', () => {
    expect(evaluatePolicy(mixed, 'preview').report).toEqual(tallyUnitStates(mixed))
  })
})

describe('policy resolution', () => {
  it('knows its named policies', () => {
    expect(Object.keys(POLICIES).sort()).toEqual(['preview', 'release'])
    expect(isPolicyName('release')).toBe(true)
    expect(isPolicyName('shipit')).toBe(false)
  })

  it('rejects an unknown policy name, naming the known ones', () => {
    expect(() => evaluatePolicy([], 'shipit' as PolicyName)).toThrow(/shipit/)
    expect(() => evaluatePolicy([], 'shipit' as PolicyName)).toThrow(/release/)
  })

  it('accepts a policy object directly', () => {
    expect(resolvePolicy(POLICIES.release)).toBe(POLICIES.release)
  })

  it('validates a policy object it did not build — a --policy-file cannot smuggle a typo', () => {
    const fromJson = { name: 'raw', maxRequired: { fuzzzy: 0 }, gateOptionalUnits: false }
    expect(() => resolvePolicy(fromJson as unknown as Policy)).toThrow(/fuzzzy/)
    expect(() => evaluatePolicy([], fromJson as unknown as Policy)).toThrow(/fuzzzy/)
  })

  it('normalises and freezes a hand-built policy object', () => {
    const fromJson = { name: 'raw', maxRequired: { fuzzy: 1 }, gateOptionalUnits: false }
    const resolved = resolvePolicy(fromJson as Policy)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.maxRequired)).toBe(true)
    const twoFuzzy = [
      unit('slides:a:body/1', 'de', 's', 'fuzzy'),
      unit('slides:a:body/2', 'de', 's', 'fuzzy'),
    ]
    expect(evaluatePolicy(twoFuzzy, fromJson as Policy).satisfied).toBe(false)

    // The snapshot is taken at resolve time: a later edit to the caller's object cannot
    // reach a policy already resolved from it.
    fromJson.maxRequired.fuzzy = 99
    expect(resolved.maxRequired.fuzzy).toBe(1)
    expect(evaluatePolicy(twoFuzzy, resolved).satisfied).toBe(false)
  })

  it('cannot be weakened at runtime — the built-in policies are deep-frozen', () => {
    expect(Object.isFrozen(POLICIES)).toBe(true)
    expect(Object.isFrozen(POLICIES.release)).toBe(true)
    expect(Object.isFrozen(POLICIES.release.maxRequired)).toBe(true)
    expect(() => {
      ;(POLICIES.release.maxRequired as Record<UnitState, number>)['needs-review'] = 999
    }).toThrow(TypeError)
    expect(POLICIES.release.maxRequired['needs-review']).toBe(0)
    expect(
      evaluatePolicy([unit('slides:a:body/1', 'de', 's', 'needs-review')], 'release').satisfied,
    ).toBe(false)
  })

  it('leaves the exit-code decision to the caller', () => {
    expect(evaluatePolicy(mixed, 'release')).not.toHaveProperty('exitCode')
  })
})

describe('definePolicy', () => {
  const tolerant = definePolicy('tolerant', { fuzzy: 2, missing: 0 })

  it('enforces a threshold above zero', () => {
    const two = [
      unit('slides:a:body/1', 'de', 's', 'fuzzy'),
      unit('slides:a:body/2', 'de', 's', 'fuzzy'),
    ]
    expect(evaluatePolicy(two, tolerant).satisfied).toBe(true)
    const three = [...two, unit('slides:a:body/3', 'de', 's', 'fuzzy')]
    const result = evaluatePolicy(three, tolerant)
    expect(result.satisfied).toBe(false)
    expect(result.violations[0]).toMatchObject({ state: 'fuzzy', limit: 2, count: 3 })
  })

  it('leaves states without a threshold ungated', () => {
    expect(
      evaluatePolicy([unit('slides:a:body/1', 'de', 's', 'needs-review')], tolerant).satisfied,
    ).toBe(true)
  })

  it('can gate optional units too', () => {
    const strict = definePolicy('strict', { missing: 0 }, { gateOptionalUnits: true })
    const units = [unit('slides:a:note/1', 'de', 's', 'missing', false)]
    expect(evaluatePolicy(units, strict).satisfied).toBe(false)
  })

  it('rejects an unknown state key, so a misspelled gate cannot pass for a gate', () => {
    const typo = { needsReview: 0 } as unknown as StateThresholds
    expect(() => definePolicy('typo', typo)).toThrow(/needsReview/)
    expect(() => definePolicy('typo', typo)).toThrow(/needs-review/)
  })

  it('copies the thresholds it was given and freezes what it returns', () => {
    const thresholds = { fuzzy: 1 }
    const policy = definePolicy('snapshot', thresholds)
    thresholds.fuzzy = 99
    expect(policy.maxRequired.fuzzy).toBe(1)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.maxRequired)).toBe(true)
  })

  it('rejects a negative or non-integer threshold', () => {
    expect(() => definePolicy('bad', { fuzzy: -1 })).toThrow(/fuzzy/)
    expect(() => definePolicy('bad', { fuzzy: 1.5 })).toThrow(/fuzzy/)
  })
})

describe('tamper resistance', () => {
  const draft = unit('slides:s01-pods:body/1', 'de', '01-pods', 'needs-review')

  it('cannot be weakened by splicing a state out of UNIT_STATES', () => {
    expect(evaluatePolicy([draft], 'release').satisfied).toBe(false)
    expect(Object.isFrozen(UNIT_STATES)).toBe(true)
    expect(() => {
      ;(UNIT_STATES as unknown as UnitState[]).splice(UNIT_STATES.indexOf('needs-review'), 1)
    }).toThrow(TypeError)
    expect(UNIT_STATES).toContain('needs-review')
    expect(evaluatePolicy([draft], 'release').satisfied).toBe(false)
  })

  it('cannot have a surface pushed into SURFACES', () => {
    expect(Object.isFrozen(SURFACES)).toBe(true)
    expect(() => {
      ;(SURFACES as unknown as Surface[]).push('evil' as Surface)
    }).toThrow(TypeError)
    expect(isSurface('evil')).toBe(false)
  })

  it('freezes the quiz schema variants the manifest validates against', () => {
    expect(Object.isFrozen(QUIZ_SCHEMA_VARIANTS)).toBe(true)
  })
})

describe('gatedUnits / isGated (the predicate compose and status must share)', () => {
  const units: UnitStatus[] = [
    unit('slides:a:body/1', 'de', 's', 'missing'),
    unit('slides:a:note/1', 'de', 's', 'missing', false),
    unit('slides:a:note/2', 'de', 's', 'needs-review', false),
    unit('slides:a:body/2', 'de', 's', 'reviewed'),
  ]

  it('answers for one unit, by policy name or policy object', () => {
    expect(isGated(units[0] as UnitStatus, 'release')).toBe(true)
    expect(isGated(units[1] as UnitStatus, 'release')).toBe(false)
    expect(isGated(units[2] as UnitStatus, 'release')).toBe(true)
    expect(isGated(units[1] as UnitStatus, POLICIES.release)).toBe(false)
    expect(
      isGated(units[1] as UnitStatus, definePolicy('s', {}, { gateOptionalUnits: true })),
    ).toBe(true)
  })

  it('returns the gated units deterministically', () => {
    expect(gatedUnits(units, 'release').map((u) => formatUnitId(u.id))).toEqual([
      'slides:a:body/1',
      'slides:a:body/2',
      'slides:a:note/2',
    ])
    expect(gatedUnits([...units].reverse(), 'release')).toEqual(gatedUnits(units, 'release'))
  })

  it('agrees with evaluatePolicy — every violating unit is a gated unit (SC-003)', () => {
    const gated = new Set(gatedUnits(mixed, 'release').map((u) => formatUnitId(u.id)))
    for (const violation of evaluatePolicy(mixed, 'release').violations) {
      for (const offender of violation.units) expect(gated.has(offender.id)).toBe(true)
    }
  })

  it('rejects an unrecognised state like the tally does', () => {
    const bogus = [{ ...(units[0] as UnitStatus), state: 'translated' } as unknown as UnitStatus]
    expect(() => gatedUnits(bogus, 'release')).toThrow(UnknownUnitStateError)
  })
})

describe('violation kinds', () => {
  it('discriminates violations by kind so new kinds are not a breaking change', () => {
    for (const violation of evaluatePolicy(mixed, 'release').violations) {
      expect(violation.kind).toBe('state')
    }
  })
})

describe('statusesForLocale', () => {
  const source: SourceUnit[] = [
    { id: parseUnitId('slides:s01:body/1'), section: '01-pods' },
    { id: parseUnitId('slides:s01:note/1'), section: '01-pods', required: false },
    { id: parseUnitId('slides:s02:body/1'), section: '02-nodes' },
  ]

  it('reports every English unit as missing when the locale has no catalog at all', () => {
    const statuses = statusesForLocale(source, [], 'de')
    expect(statuses.map((s) => s.state)).toEqual(['missing', 'missing', 'missing'])
    expect(evaluatePolicy(statuses, 'release').satisfied).toBe(false)
  })

  it('applies the states the catalog does know', () => {
    const known: UnitStatus[] = [unit('slides:s01:body/1', 'de', 'whatever', 'reviewed')]
    const statuses = statusesForLocale(source, known, 'de')
    expect(statuses.map((s) => [formatUnitId(s.id), s.state])).toEqual([
      ['slides:s01:body/1', 'reviewed'],
      ['slides:s01:note/1', 'missing'],
      ['slides:s02:body/1', 'missing'],
    ])
  })

  it('takes section and required from the English source, never from the catalog', () => {
    const known = [
      {
        id: parseUnitId('slides:s01:body/1'),
        locale: 'de',
        section: 'attacker-section',
        state: 'needs-review',
        required: false,
      } as UnitStatus,
    ]
    const status = statusesForLocale(source, known, 'de')[0] as UnitStatus
    expect(status.section).toBe('01-pods')
    expect(status.required).toBeUndefined()
    expect(evaluatePolicy(statusesForLocale(source, known, 'de'), 'release').satisfied).toBe(false)
  })

  it('ignores catalog entries for other locales and units no longer in the source', () => {
    const known: UnitStatus[] = [
      unit('slides:s01:body/1', 'pt-BR', '01-pods', 'reviewed'),
      unit('slides:deleted:body/1', 'de', 'gone', 'reviewed'),
    ]
    const statuses = statusesForLocale(source, known, 'de')
    expect(statuses).toHaveLength(3)
    expect(statuses.every((s) => s.state === 'missing')).toBe(true)
    expect(statuses.every((s) => s.locale === 'de')).toBe(true)
  })

  it('rejects a duplicated source unit and a duplicated catalog entry', () => {
    expect(() => statusesForLocale([...source, source[0] as SourceUnit], [], 'de')).toThrow(
      DuplicateUnitError,
    )
    const twice: UnitStatus[] = [
      unit('slides:s01:body/1', 'de', 'a', 'reviewed'),
      unit('slides:s01:body/1', 'de', 'b', 'fuzzy'),
    ]
    expect(() => statusesForLocale(source, twice, 'de')).toThrow(DuplicateUnitError)
  })
})
