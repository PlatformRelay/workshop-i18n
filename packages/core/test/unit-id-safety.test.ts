import { describe, expect, it } from 'vitest'
import {
  assertSafeUnitId,
  compareUnitIds,
  formatUnitId,
  isSafeContainerId,
  isSafeUnitKey,
  parseSafeUnitId,
  parseUnitId,
  SURFACES,
  type UnitId,
  UnitIdError,
  validateUnitId,
} from '../src/index.js'

const safe: UnitId = { surface: 'slides', containerId: 's00-welcome-why', unitKey: 'body/1' }

describe('identity safety — container ids', () => {
  it('accepts readable ids derived from section + heading', () => {
    expect(isSafeContainerId('s00-welcome-why')).toBe(true)
    expect(isSafeContainerId('lab-03.2_networking')).toBe(true)
    expect(isSafeContainerId('q7')).toBe(true)
  })

  it('rejects path traversal, separators and absolute-looking ids', () => {
    for (const hostile of [
      '..',
      '../../etc/passwd',
      'a/../b',
      // `a..b` and `a...b` satisfy the charset, so the traversal clause is the only
      // thing rejecting them. Pinned explicitly: dropping that clause must go red.
      'a..b',
      'a...b',
      'slides/evil',
      'a\\b',
      '/etc/hosts',
    ]) {
      expect(isSafeContainerId(hostile)).toBe(false)
    }
  })

  it('rejects control characters and PO-quoting-hostile characters', () => {
    for (const hostile of ['a\u0000b', 'a\nb', 'a\tb', 'he"llo', 'back\\slash', 'a\u007fb']) {
      expect(isSafeContainerId(hostile)).toBe(false)
    }
  })

  it('rejects empty, dot-leading, dash-leading, non-ASCII and over-long ids', () => {
    expect(isSafeContainerId('')).toBe(false)
    expect(isSafeContainerId('.hidden')).toBe(false)
    expect(isSafeContainerId('-dash')).toBe(false)
    expect(isSafeContainerId('caf\u00e9')).toBe(false)
    expect(isSafeContainerId('\u202egnp.exe')).toBe(false)
    expect(isSafeContainerId(`a${'b'.repeat(200)}`)).toBe(false)
  })
})

describe('identity safety — filesystem-hostile container ids', () => {
  it('rejects Windows reserved device names, whatever their case or extension', () => {
    for (const reserved of ['con', 'NUL', 'Prn', 'aux', 'com1', 'LPT9', 'con.md']) {
      expect(isSafeContainerId(reserved)).toBe(false)
    }
    expect(isSafeContainerId('console')).toBe(true)
    expect(isSafeContainerId('aux-services')).toBe(true)
  })

  it('rejects a trailing dot, which Windows silently strips into a collision', () => {
    expect(isSafeContainerId('s01-pods.')).toBe(false)
    expect(isSafeContainerId('s01-pods')).toBe(true)
  })

  it('names the reason so the init-ids codemod can explain itself', () => {
    const issues = validateUnitId({ surface: 'slides', containerId: 'con', unitKey: 'body/1' })
    expect(issues[0]).toMatchObject({ field: 'containerId', reason: 'reserved-name' })
  })
})

describe('identity safety — unit keys', () => {
  it('accepts position-independent structural keys', () => {
    expect(isSafeUnitKey('body/1')).toBe(true)
    expect(isSafeUnitKey('note:speaker:2')).toBe(true)
    expect(isSafeUnitKey('frontmatter.kicker')).toBe(true)
  })

  it('rejects traversal, backslashes and malformed separators', () => {
    // `a..b` and `a/../b` pass the unit-key charset, so the traversal clause is the only
    // thing rejecting them. Pinned explicitly: removing that clause must go red.
    for (const hostile of ['../etc', 'a..b', 'a/../b', 'body//1', 'body/', 'a\\b', '..']) {
      expect(isSafeUnitKey(hostile)).toBe(false)
    }
  })

  it('rejects quotes and newlines that would break PO msgctxt quoting', () => {
    expect(isSafeUnitKey('body"1')).toBe(false)
    expect(isSafeUnitKey('body\n1')).toBe(false)
  })
})

describe('validateUnitId', () => {
  it('reports no issues for a safe id', () => {
    expect(validateUnitId(safe)).toEqual([])
  })

  it('names the offending field and the reason', () => {
    const issues = validateUnitId({ surface: 'slides', containerId: '../etc', unitKey: 'body\n1' })
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({ field: 'containerId', reason: 'path-traversal' })
    expect(issues[1]).toMatchObject({ field: 'unitKey', reason: 'illegal-character' })
    expect(issues[0]?.message).toContain('containerId')
  })

  it('flags an unknown surface', () => {
    const issues = validateUnitId({
      surface: 'evil' as UnitId['surface'],
      containerId: 'ok',
      unitKey: 'body/1',
    })
    expect(issues[0]).toMatchObject({ field: 'surface', reason: 'unknown-surface' })
  })

  it('reports a non-string container id as an issue, not as a raw TypeError', () => {
    for (const hostile of [42, null, undefined, {}, ['a'], true]) {
      const id = { surface: 'slides', containerId: hostile, unitKey: 'body/1' } as unknown as UnitId
      expect(isSafeContainerId(hostile as unknown as string)).toBe(false)
      expect(validateUnitId(id)[0]).toMatchObject({
        field: 'containerId',
        reason: 'not-a-string',
      })
      expect(() => assertSafeUnitId(id)).toThrow(UnitIdError)
    }
  })

  it('reports a hostile surface as an issue, and never runs its toString', () => {
    const hostile: unknown[] = [
      42,
      null,
      undefined,
      Object.create(null),
      Symbol('surface'),
      10n,
      {
        toString() {
          throw new Error('boom')
        },
      },
      {
        get [Symbol.toPrimitive]() {
          throw new Error('boom')
        },
      },
    ]
    for (const surface of hostile) {
      const id = { surface, containerId: 'ok', unitKey: 'body/1' } as unknown as UnitId
      expect(validateUnitId(id)[0]).toMatchObject({ field: 'surface', reason: 'unknown-surface' })
      expect(() => assertSafeUnitId(id)).toThrow(UnitIdError)
    }
  })

  it('reports a non-string unit key the same way', () => {
    const id = { surface: 'labs', containerId: 'lab-01', unitKey: 7 } as unknown as UnitId
    expect(validateUnitId(id)[0]).toMatchObject({ field: 'unitKey', reason: 'not-a-string' })
    expect(isSafeUnitKey(7 as unknown as string)).toBe(false)
  })
})

describe('assertSafeUnitId', () => {
  it('passes a safe id through', () => {
    expect(() => assertSafeUnitId(safe)).not.toThrow()
  })

  it('throws a UnitIdError carrying every issue', () => {
    let error: unknown
    try {
      assertSafeUnitId({ surface: 'labs', containerId: '..', unitKey: 'a\u0000b' })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(UnitIdError)
    expect((error as UnitIdError).issues).toHaveLength(2)
    expect((error as UnitIdError).message).toMatch(/unsafe unit id/)
  })

  it('escapes hostile characters in the error message instead of echoing them raw', () => {
    expect(() => assertSafeUnitId({ ...safe, containerId: 'a\u001bb' })).toThrow(/\\u001b/)
  })
})

describe('formatUnitId', () => {
  it('refuses to interpolate a non-string segment', () => {
    const hostile = {
      toString() {
        throw new Error('boom')
      },
    }
    expect(() => formatUnitId({ ...safe, containerId: hostile as unknown as string })).toThrow(
      UnitIdError,
    )
    expect(() => formatUnitId({ ...safe, unitKey: 7 as unknown as string })).toThrow(UnitIdError)
    expect(() =>
      formatUnitId({
        surface: hostile as unknown as UnitId['surface'],
        ...{ containerId: 'a', unitKey: 'b' },
      }),
    ).toThrow(UnitIdError)
  })

  it('still formats a well-formed id', () => {
    expect(formatUnitId(safe)).toBe('slides:s00-welcome-why:body/1')
  })
})

describe('parseSafeUnitId', () => {
  it('parses and validates in one step', () => {
    expect(parseSafeUnitId(formatUnitId(safe))).toEqual(safe)
  })

  it('rejects a hostile id that parses structurally', () => {
    expect(() => parseSafeUnitId('slides:../../etc:body/1')).toThrow(UnitIdError)
  })

  it('still rejects structurally malformed ids', () => {
    expect(() => parseSafeUnitId('slides:only-two')).toThrow(/invalid unit id/)
  })

  it('accepts exactly the surfaces isSurface accepts', () => {
    for (const surface of SURFACES) {
      expect(parseUnitId(`${surface}:c:k`).surface).toBe(surface)
    }
  })
})

describe('compareUnitIds', () => {
  it('orders by code unit, not by locale collation', () => {
    // ICU sorts "a" before "B"; code-unit order puts "B" (0x42) first. Catalog ordering
    // must not depend on the machine's collation, so this pins the code-unit answer —
    // swapping in localeCompare turns this red.
    const upper: UnitId = { surface: 'slides', containerId: 'B', unitKey: 'body/1' }
    const lower: UnitId = { surface: 'slides', containerId: 'a', unitKey: 'body/1' }
    expect(compareUnitIds(upper, lower)).toBeLessThan(0)
    expect('B'.localeCompare('a')).toBeGreaterThan(0)

    const upperKey: UnitId = { surface: 'slides', containerId: 's01', unitKey: 'Body/1' }
    const lowerKey: UnitId = { surface: 'slides', containerId: 's01', unitKey: 'body/1' }
    expect(compareUnitIds(upperKey, lowerKey)).toBeLessThan(0)
  })

  it('is a total order: antisymmetric, and 0 only for equal ids', () => {
    const a: UnitId = { surface: 'slides', containerId: 'a-b', unitKey: 'body/1' }
    const b: UnitId = { surface: 'slides', containerId: 'ab', unitKey: 'body/1' }
    expect(compareUnitIds(a, b)).toBe(-compareUnitIds(b, a))
    expect(compareUnitIds(a, { ...a })).toBe(0)
    expect(compareUnitIds(a, b)).not.toBe(0)
  })

  it('orders deterministically by formatted id', () => {
    const ids: UnitId[] = [
      { surface: 'slides', containerId: 'b', unitKey: 'body/1' },
      { surface: 'labs', containerId: 'a', unitKey: 'body/1' },
      { surface: 'slides', containerId: 'a', unitKey: 'body/2' },
      { surface: 'slides', containerId: 'a', unitKey: 'body/1' },
    ]
    expect([...ids].sort(compareUnitIds).map(formatUnitId)).toEqual([
      'labs:a:body/1',
      'slides:a:body/1',
      'slides:a:body/2',
      'slides:b:body/1',
    ])
  })
})
