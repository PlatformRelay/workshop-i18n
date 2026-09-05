import { describe, expect, it } from 'vitest'
import {
  DuplicateUnitError,
  definePolicy,
  emptyStateCounts,
  evaluatePolicy,
  isPolicyName,
  OPTIONAL_EXEMPT_STATES,
  POLICIES,
  type PolicyName,
  parseUnitId,
  resolvePolicy,
  type StateThresholds,
  tallyUnitStates,
  type UnitState,
  type UnitStatus,
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
