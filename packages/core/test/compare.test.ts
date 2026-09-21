import { describe, expect, it } from 'vitest'
import { compareCodeUnits } from '../src/index.js'

describe('compareCodeUnits', () => {
  // Uppercase (U+0041..) sorts before lowercase (U+0061..), and any non-ASCII letter after both.
  const MIXED = ['b', 'B', 'a', 'é', 'Z']
  const CODE_UNIT_ORDER = ['B', 'Z', 'a', 'b', 'é']

  it('orders by UTF-16 code unit, exactly as the default sort does', () => {
    expect([...MIXED].sort(compareCodeUnits)).toEqual(CODE_UNIT_ORDER)
    expect([...MIXED].sort(compareCodeUnits)).toEqual([...MIXED].sort())
  })

  it('is locale-independent: uppercase never interleaves with lowercase', () => {
    expect(['a', 'B', 'A', 'b'].sort(compareCodeUnits)).toEqual(['A', 'B', 'a', 'b'])
  })

  it('compares surrogate pairs by code unit, not by code point', () => {
    // U+FF5E (one code unit, 0xFF5E) sorts after U+1F600 (0xD83D 0xDE00) by code unit.
    expect(['～', '\u{1F600}'].sort(compareCodeUnits)).toEqual(['\u{1F600}', '～'])
  })

  it('returns 0 for equal strings and a prefix sorts first', () => {
    expect(compareCodeUnits('a', 'a')).toBe(0)
    expect(compareCodeUnits('a', 'ab')).toBe(-1)
    expect(compareCodeUnits('ab', 'a')).toBe(1)
  })

  it('leaves equal keys in their original order (the sort is stable)', () => {
    const rows = [
      { key: 'b', n: 1 },
      { key: 'a', n: 2 },
      { key: 'b', n: 3 },
      { key: 'a', n: 4 },
    ]
    const sorted = rows.sort((x, y) => compareCodeUnits(x.key, y.key))
    expect(sorted.map((row) => row.n)).toEqual([2, 4, 1, 3])
  })
})
