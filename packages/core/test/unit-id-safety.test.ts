import { describe, expect, it } from 'vitest'
import {
  assertSafeUnitId,
  compareUnitIds,
  formatUnitId,
  isSafeContainerId,
  isSafeUnitKey,
  parseSafeUnitId,
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

describe('identity safety — unit keys', () => {
  it('accepts position-independent structural keys', () => {
    expect(isSafeUnitKey('body/1')).toBe(true)
    expect(isSafeUnitKey('note:speaker:2')).toBe(true)
    expect(isSafeUnitKey('frontmatter.kicker')).toBe(true)
  })

  it('rejects traversal, backslashes and malformed separators', () => {
    for (const hostile of ['../etc', 'body//1', 'body/', 'a\\b', '..']) {
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
})

describe('compareUnitIds', () => {
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
