import { isUnitState, UNIT_STATES, type UnitState } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import type { PoEntry } from '../src/index.js'
import { FUZZY_FLAG, NEEDS_REVIEW_FLAG, unitStateOf } from '../src/index.js'

function entry(overrides: Partial<PoEntry> = {}): PoEntry {
  return {
    comments: [],
    flags: [],
    msgctxt: 'slides:s01:body/1',
    msgid: 'A Pod.',
    msgstr: [''],
    obsolete: false,
    line: 0,
    ...overrides,
  }
}

describe('unitStateOf', () => {
  it('maps an empty msgstr to missing', () => {
    expect(unitStateOf(entry())).toBe('missing')
  })

  it('maps a plain translation to reviewed — the human action is the absent flag', () => {
    expect(unitStateOf(entry({ msgstr: ['Ein Pod.'] }))).toBe('reviewed')
  })

  it('maps the fuzzy flag to fuzzy', () => {
    expect(unitStateOf(entry({ msgstr: ['Ein Pod.'], flags: [FUZZY_FLAG] }))).toBe('fuzzy')
  })

  it('maps the needs-review flag to needs-review', () => {
    expect(unitStateOf(entry({ msgstr: ['Ein Pod.'], flags: [NEEDS_REVIEW_FLAG] }))).toBe(
      'needs-review',
    )
  })

  it('gives fuzzy precedence over needs-review, so a stale draft is never under-reported', () => {
    const both = entry({ msgstr: ['Ein Pod.'], flags: [NEEDS_REVIEW_FLAG, FUZZY_FLAG] })
    expect(unitStateOf(both)).toBe('fuzzy')
  })

  it('reports an empty msgstr as missing even when flagged, because nothing was drafted', () => {
    expect(unitStateOf(entry({ flags: [FUZZY_FLAG] }))).toBe('missing')
    expect(unitStateOf(entry({ flags: [NEEDS_REVIEW_FLAG] }))).toBe('missing')
  })

  it('treats a plural entry as translated only when every form is filled', () => {
    const plural = { msgidPlural: '%d Pods', msgstr: ['ein Pod', ''] }
    expect(unitStateOf(entry(plural))).toBe('missing')
    expect(unitStateOf(entry({ ...plural, msgstr: ['ein Pod', 'viele Pods'] }))).toBe('reviewed')
  })

  /**
   * Core now throws {@link UnknownUnitStateError} when a producer hands it a state
   * outside the four. This mapping is that producer, so totality is pinned here rather
   * than discovered downstream.
   */
  it('is total: every flag combination yields one of core’s four states', () => {
    const vocabulary = [
      FUZZY_FLAG,
      NEEDS_REVIEW_FLAG,
      'c-format',
      'python-brace-format',
      'approved',
    ]
    const seen = new Set<UnitState>()
    for (let mask = 0; mask < 1 << vocabulary.length; mask += 1) {
      const flags = vocabulary.filter((_, index) => (mask & (1 << index)) !== 0)
      for (const msgstr of [[''], ['Ein Pod.']]) {
        const state = unitStateOf(entry({ flags, msgstr }))
        expect(isUnitState(state), `flags ${flags.join(',')}`).toBe(true)
        seen.add(state)
      }
    }
    expect([...seen].sort()).toEqual([...UNIT_STATES].sort())
  })

  /**
   * **The promotion invariant** (constitution V, ADR 0009).
   *
   * Human acceptance is expressed by the *absence* of a gating flag, and by nothing
   * else. No flag a TMS, a seeding pass, or a machine translation pass can write may
   * promote an entry past `needs-review` or `fuzzy` — those are exactly the surfaces
   * unreviewed prose arrives on, so a flag that promotes is a path for it to ship.
   *
   * This is defended rather than asserted because the totality test above cannot see it:
   * that test pins *that* a valid state comes out, not *which*. Inserting
   * `if (entry.flags.includes('approved')) return 'reviewed'` into `unitStateOf` leaves
   * the whole rest of the suite green and makes a machine translation shipping-grade.
   */
  it('lets no TMS flag promote a gated entry — acceptance is the absence of a flag', () => {
    const promotionish = ['approved', 'reviewed', 'accepted', 'no-review', 'signed-off', 'verified']
    const translated = ['Ein Pod.']

    for (let mask = 0; mask < 1 << promotionish.length; mask += 1) {
      const claim = promotionish.filter((_, index) => (mask & (1 << index)) !== 0)
      const label = claim.length === 0 ? '(none)' : claim.join(',')

      expect(
        unitStateOf(entry({ msgstr: translated, flags: [...claim, NEEDS_REVIEW_FLAG] })),
        label,
      ).toBe('needs-review')
      expect(
        unitStateOf(entry({ msgstr: translated, flags: [NEEDS_REVIEW_FLAG, ...claim] })),
        label,
      ).toBe('needs-review')
      expect(unitStateOf(entry({ msgstr: translated, flags: [...claim, FUZZY_FLAG] })), label).toBe(
        'fuzzy',
      )
      expect(
        unitStateOf(
          entry({ msgstr: translated, flags: [...claim, NEEDS_REVIEW_FLAG, FUZZY_FLAG] }),
        ),
        label,
      ).toBe('fuzzy')
      expect(
        unitStateOf(entry({ msgstr: [''], flags: [...claim, NEEDS_REVIEW_FLAG] })),
        label,
      ).toBe('missing')
    }
  })

  it('reaches reviewed only when no gating flag is present at all', () => {
    expect(unitStateOf(entry({ msgstr: ['Ein Pod.'], flags: ['approved'] }))).toBe('reviewed')
    expect(unitStateOf(entry({ msgstr: ['Ein Pod.'], flags: [] }))).toBe('reviewed')
    expect(unitStateOf(entry({ msgstr: ['Ein Pod.'], flags: [NEEDS_REVIEW_FLAG] }))).not.toBe(
      'reviewed',
    )
  })

  it('never lets a flag or comment speak to requiredness — it maps state only', () => {
    const loaded = entry({
      msgstr: ['Ein Pod.'],
      flags: ['optional', 'no-review-needed', 'approved'],
      comments: [{ marker: '', text: ' required: false' }],
    })
    // The mapping's whole return type is UnitState; there is nowhere for requiredness to
    // arrive from the catalog, which is the constitution V constraint made structural.
    expect(unitStateOf(loaded)).toBe('reviewed')
    expect(Object.keys(loaded)).not.toContain('required')
  })
})
