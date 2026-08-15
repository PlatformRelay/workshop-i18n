import { describe, expect, it } from 'vitest'
import { formatUnitId, parseUnitId, type UnitId } from '../src/index.js'

describe('unit identity', () => {
  const id: UnitId = { surface: 'slides', containerId: 's00-welcome-why', unitKey: 'body/1' }

  it('round-trips format → parse', () => {
    expect(parseUnitId(formatUnitId(id))).toEqual(id)
  })

  it('preserves colons inside the unit key', () => {
    const odd: UnitId = { ...id, unitKey: 'note:speaker:2' }
    expect(parseUnitId(formatUnitId(odd))).toEqual(odd)
  })

  it('rejects malformed ids', () => {
    expect(() => parseUnitId('slides:only-two')).toThrow(/invalid unit id/)
    expect(() => parseUnitId('bogus:c:k')).toThrow(/invalid surface/)
    expect(() => parseUnitId('slides::k')).toThrow(/invalid unit id/)
  })
})
