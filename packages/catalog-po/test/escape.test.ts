import { describe, expect, it } from 'vitest'
import { PoSyntaxError } from '../src/errors.js'
import { escapePoString, unescapePoString } from '../src/escape.js'

const at = { fileName: 'x.po', line: 1 }

describe('escapePoString', () => {
  it('escapes the characters that would otherwise end the string', () => {
    expect(escapePoString('a"b\\c')).toBe('a\\"b\\\\c')
  })

  it('uses the C mnemonics for the whitespace controls', () => {
    expect(escapePoString('a\nb\tc\rd')).toBe('a\\nb\\tc\\rd')
  })

  it('uses the C mnemonics for the remaining named controls', () => {
    expect(escapePoString('\u0007\u0008\u000c\u000b')).toBe('\\a\\b\\f\\v')
  })

  it('falls back to three-digit octal for controls with no mnemonic', () => {
    expect(escapePoString('\u0000\u001f\u007f')).toBe('\\000\\037\\177')
  })

  it('leaves non-ASCII text literal — the catalog is UTF-8', () => {
    expect(escapePoString('Grüße 日本語 🎉')).toBe('Grüße 日本語 🎉')
  })
})

describe('unescapePoString', () => {
  it('inverts every escape the writer produces', () => {
    const hostile = 'a"b\\c\nd\te\rf\u0007\u0000 Grüße 日本語 🎉'
    expect(unescapePoString(escapePoString(hostile), at)).toBe(hostile)
  })

  it('decodes an octal byte run as UTF-8, the way msgcat writes non-ASCII', () => {
    expect(unescapePoString('\\303\\251', at)).toBe('é')
  })

  it('decodes a two-digit hex escape', () => {
    expect(unescapePoString('\\x41', at)).toBe('A')
  })

  it('rejects a hex escape long enough to be ambiguous, naming the line', () => {
    expect(() => unescapePoString('\\x414', at)).toThrow(PoSyntaxError)
    expect(() => unescapePoString('\\x414', at)).toThrow(/x\.po:1/)
  })

  it('rejects a byte run that is not valid UTF-8 rather than substituting U+FFFD', () => {
    expect(() => unescapePoString('\\303', at)).toThrow(PoSyntaxError)
  })

  it('rejects an unknown escape rather than dropping the backslash', () => {
    expect(() => unescapePoString('a\\qb', at)).toThrow(/unknown escape/)
  })

  it('rejects a trailing backslash', () => {
    expect(() => unescapePoString('a\\', at)).toThrow(PoSyntaxError)
  })
})
