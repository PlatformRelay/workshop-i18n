import { describe, expect, it } from 'vitest'
import {
  JsonScanError,
  type JsonString,
  MAX_NESTING_DEPTH,
  memberOf,
  scanJson,
} from '../src/json-scan.js'

function scanString(json: string): JsonString {
  const root = scanJson(json)
  if (root.kind !== 'string') throw new Error('expected a string at the root')
  return root
}

describe('scanJson', () => {
  it('records the exact range of every string, quotes included', () => {
    const text = '{"a": "hello"}'
    const root = scanJson(text)
    const member = memberOf(root, 'a')
    if (member?.kind !== 'string') throw new Error('expected a string')
    expect(text.slice(member.start, member.end)).toBe('"hello"')
    expect(text.slice(member.innerStart, member.innerEnd)).toBe('hello')
    expect(member.value).toBe('hello')
  })

  it('keeps the raw text of an escaped string while decoding its value', () => {
    const text = String.raw`"a\"b\\c\/d\n\té🚀"`
    const node = scanString(text)
    expect(node.value).toBe('a"b\\c/d\n\té🚀')
    expect(text.slice(node.innerStart, node.innerEnd)).toBe(String.raw`a\"b\\c\/d\n\té🚀`)
  })

  it('decodes every escape exactly as JSON.parse does', () => {
    const cases = [
      String.raw`"\b\f\n\r\t"`,
      String.raw`"\u0000\u001f\u007f"`,
      String.raw`"\ud83d\ude80"`,
      String.raw`"\u00e9\u20ac"`,
      '"🚀 literal 🚀"',
      '"üÜber"',
      '"plain"',
      '"café"',
      String.raw`"lone \ud800 surrogate"`,
    ]
    for (const text of cases) {
      expect(scanString(text).value).toBe(JSON.parse(text))
    }
  })

  it('walks objects, arrays and scalars', () => {
    const root = scanJson('{"n": 1, "f": -2.5e3, "t": true, "z": null, "a": [1, "two"]}')
    expect(root.kind).toBe('object')
    expect(memberOf(root, 'n')).toMatchObject({ kind: 'number', value: 1 })
    expect(memberOf(root, 'f')).toMatchObject({ kind: 'number', value: -2500 })
    expect(memberOf(root, 't')).toMatchObject({ kind: 'boolean', value: true })
    expect(memberOf(root, 'z')).toMatchObject({ kind: 'null' })
    const array = memberOf(root, 'a')
    expect(array?.kind === 'array' && array.items).toHaveLength(2)
  })

  it('tolerates every JSON whitespace spelling, including none at all', () => {
    expect(scanJson('{"a":[1,2]}').kind).toBe('object')
    expect(scanJson('\t{\r\n "a" :\t[ 1 , 2 ]\n}\n ').kind).toBe('object')
  })

  it.each([
    ['truncated input', '{"a": '],
    ['a trailing comma', '{"a": 1,}'],
    ['a single-quoted string', "{'a': 1}"],
    ['an unquoted key', '{a: 1}'],
    ['trailing content after the document', '{} garbage'],
    ['a raw control character inside a string', '"line\nbreak"'],
    ['a raw tab inside a string', '"tab\there"'],
    ['an unknown escape', String.raw`"\x41"`],
    ['a truncated unicode escape', String.raw`"\u12"`],
    ['a leading byte-order mark', '﻿{"a": 1}'],
    ['a lone plus sign', '+1'],
    ['a leading zero', '01'],
    ['NaN', 'NaN'],
    ['an empty document', ''],
  ])('refuses %s', (_label, text) => {
    expect(() => scanJson(text)).toThrow(JsonScanError)
  })

  it('refuses a duplicate object key rather than silently keeping one of them', () => {
    expect(() => scanJson('{"a": 1, "a": 2}')).toThrow(JsonScanError)
  })

  it('names the file and the line of a failure', () => {
    let caught: unknown
    try {
      scanJson('{\n  "a": nope\n}', 'quiz/questions.json')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(JsonScanError)
    expect((caught as JsonScanError).line).toBe(2)
    expect((caught as JsonScanError).message).toContain('quiz/questions.json')
  })

  it('accepts nesting far deeper than any real bank', () => {
    const deep = `${'['.repeat(MAX_NESTING_DEPTH)}1${']'.repeat(MAX_NESTING_DEPTH)}`
    expect(() => scanJson(deep)).not.toThrow()
  })

  it('refuses hostile nesting with a named error instead of exhausting the stack', () => {
    // Without the depth limit this is an unhandled RangeError: a crash with no file, no
    // line and no diagnostic code, on input SECURITY.md says to treat as hostile.
    const tooDeep = `${'['.repeat(MAX_NESTING_DEPTH + 1)}1${']'.repeat(MAX_NESTING_DEPTH + 1)}`
    expect(() => scanJson(tooDeep, 'quiz/questions.json')).toThrow(JsonScanError)
    expect(() => scanJson(tooDeep)).toThrow(/nested deeper than/)
    const wayTooDeep = `${'['.repeat(50_000)}1${']'.repeat(50_000)}`
    expect(() => scanJson(wayTooDeep)).toThrow(JsonScanError)
  })

  it('counts nesting per branch, not cumulatively across siblings', () => {
    const wide = `[${Array.from({ length: 2_000 }, () => '[1]').join(',')}]`
    expect(() => scanJson(wide)).not.toThrow()
  })
})

describe('memberOf', () => {
  it('returns undefined for a missing key and never walks the prototype', () => {
    const root = scanJson('{"a": 1}')
    expect(memberOf(root, 'b')).toBeUndefined()
    expect(memberOf(root, 'constructor')).toBeUndefined()
    expect(memberOf(root, '__proto__')).toBeUndefined()
  })
})
