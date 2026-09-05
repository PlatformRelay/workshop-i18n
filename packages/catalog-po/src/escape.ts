/**
 * C-style string escaping, the half of the PO format that eats parsers.
 *
 * The write side has exactly one spelling per input, so a value that has not changed
 * re-serializes to the same bytes (spec 002 FR-005). The read side accepts everything
 * GNU gettext writes — mnemonics, octal byte escapes, two-digit hex — and rejects the
 * rest loudly instead of guessing.
 *
 * Byte escapes are decoded as a *run*: `msgcat` can spell `é` as `\303\251`, two bytes
 * of one character, so the bytes are buffered and decoded as UTF-8 together. The decoder
 * is `fatal`, so an invalid sequence is an error rather than a U+FFFD substitution that
 * would silently corrupt a translation.
 */

import { type PoLocation, PoSyntaxError } from './errors.js'

/** Control characters that have a C mnemonic, in the spelling the writer emits. */
const WRITE_MNEMONICS: ReadonlyMap<number, string> = new Map([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0b, '\\v'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
])

/** The inverse table, plus the two characters that would otherwise end the string. */
const READ_MNEMONICS: ReadonlyMap<string, string> = new Map([
  ['a', '\u0007'],
  ['b', '\u0008'],
  ['t', '\t'],
  ['n', '\n'],
  ['v', '\u000b'],
  ['f', '\u000c'],
  ['r', '\u000d'],
  ['"', '"'],
  ['\\', '\\'],
  ["'", "'"],
  ['?', '?'],
])

const OCTAL_DIGIT = /^[0-7]$/
const HEX_DIGIT = /^[0-9a-fA-F]$/

/**
 * Escape a value for the inside of a PO quoted string. Non-ASCII text is left literal —
 * catalogs are UTF-8 (ADR 0004) — while control characters without a mnemonic become
 * three-digit octal, which is unambiguous in the gettext grammar in a way that `\x` is not.
 */
export function escapePoString(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (character === '\\') {
      out += '\\\\'
    } else if (character === '"') {
      out += '\\"'
    } else {
      const mnemonic = WRITE_MNEMONICS.get(code)
      if (mnemonic !== undefined) {
        out += mnemonic
      } else if (code < 0x20 || code === 0x7f) {
        out += `\\${code.toString(8).padStart(3, '0')}`
      } else {
        out += character
      }
    }
  }
  return out
}

/**
 * Decode the raw text between the quotes of one PO string (or of several adjacent
 * strings already concatenated raw — concatenating before decoding is what lets a
 * multi-byte character survive being split across continuation lines).
 *
 * @throws {PoSyntaxError} on a malformed, ambiguous or unknown escape.
 */
export function unescapePoString(raw: string, at: PoLocation): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let out = ''
  let bytes: number[] = []

  const flushBytes = (): void => {
    if (bytes.length === 0) return
    try {
      out += decoder.decode(Uint8Array.from(bytes))
    } catch {
      const spelling = bytes.map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')
      throw new PoSyntaxError(at, `byte escape run ${spelling} is not valid UTF-8`)
    }
    bytes = []
  }

  let index = 0
  while (index < raw.length) {
    const character = raw[index]
    if (character === undefined) break
    if (character !== '\\') {
      flushBytes()
      out += character
      index += 1
      continue
    }

    const next = raw[index + 1]
    if (next === undefined) {
      throw new PoSyntaxError(at, 'string ends with a lone backslash')
    }

    const mnemonic = READ_MNEMONICS.get(next)
    if (mnemonic !== undefined) {
      flushBytes()
      out += mnemonic
      index += 2
      continue
    }

    if (OCTAL_DIGIT.test(next)) {
      let digits = ''
      let scan = index + 1
      while (scan < raw.length && digits.length < 3) {
        const digit = raw[scan]
        if (digit === undefined || !OCTAL_DIGIT.test(digit)) break
        digits += digit
        scan += 1
      }
      const value = Number.parseInt(digits, 8)
      if (value > 0xff) {
        throw new PoSyntaxError(at, `octal escape \\${digits} is larger than one byte`)
      }
      bytes.push(value)
      index = scan
      continue
    }

    if (next === 'x') {
      const first = raw[index + 2]
      const second = raw[index + 3]
      if (
        first === undefined ||
        second === undefined ||
        !HEX_DIGIT.test(first) ||
        !HEX_DIGIT.test(second)
      ) {
        throw new PoSyntaxError(at, 'hex escape needs exactly two hexadecimal digits')
      }
      const third = raw[index + 4]
      if (third !== undefined && HEX_DIGIT.test(third)) {
        throw new PoSyntaxError(
          at,
          'hex escape is ambiguous: gettext reads hex escapes greedily, so write the byte in octal instead',
        )
      }
      bytes.push(Number.parseInt(first + second, 16))
      index += 4
      continue
    }

    throw new PoSyntaxError(at, `unknown escape "\\${next}"`)
  }

  flushBytes()
  return out
}
