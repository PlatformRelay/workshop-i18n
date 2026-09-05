/**
 * `decodeSource` is the door that keeps offsets and bytes in bijection, and a package
 * that ships it without testing it can have the door flipped open — `fatal: false`
 * substitutes U+FFFD for every invalid byte, so a corrupted bank composes back to a
 * *different* file with a green round-trip suite. That is the silent corruption
 * constitution III exists to prevent, and it is invisible to every other test here,
 * because every fixture is valid UTF-8.
 */

import { describe, expect, it } from 'vitest'
import { decodeSource, positionAt, SourceDecodeError } from '../src/source.js'

describe('decodeSource', () => {
  it('round-trips valid UTF-8, byte for byte', () => {
    const text = '{"prompt": "Pod → ReplicaSet ✓ 🚀"}\n'
    const bytes = Buffer.from(text, 'utf8')
    expect(decodeSource(bytes)).toBe(text)
    expect(Buffer.from(decodeSource(bytes), 'utf8')).toEqual(bytes)
  })

  it('keeps a byte-order mark instead of stripping it', () => {
    // Kept here and refused by the scanner, so a BOM'd bank fails with a named
    // diagnostic rather than being silently repaired into a different file.
    expect(decodeSource(Buffer.from('﻿{}', 'utf8'))).toBe('﻿{}')
  })

  it('refuses invalid UTF-8 rather than substituting U+FFFD', () => {
    const bytes = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])
    expect(() => decodeSource(bytes, 'quiz/questions.json')).toThrow(SourceDecodeError)
    expect(() => decodeSource(bytes, 'quiz/questions.json')).toThrow(/quiz\/questions\.json/)
    expect(() => decodeSource(bytes)).toThrow(/UTF-8/)
  })

  it('refuses a truncated multi-byte sequence', () => {
    expect(() => decodeSource(Buffer.from([0xe2, 0x9c]))).toThrow(SourceDecodeError)
  })

  it('refuses a lone surrogate encoded as CESU-8', () => {
    expect(() => decodeSource(Buffer.from([0xed, 0xa0, 0x80]))).toThrow(SourceDecodeError)
  })

  it('refuses an overlong encoding', () => {
    expect(() => decodeSource(Buffer.from([0xc0, 0xaf]))).toThrow(SourceDecodeError)
  })
})

describe('positionAt', () => {
  it('reports 1-based line and column', () => {
    const text = '{\n  "a": 1\n}'
    expect(positionAt(text, 0)).toEqual({ line: 1, column: 1 })
    expect(positionAt(text, 2)).toEqual({ line: 2, column: 1 })
    expect(positionAt(text, 11)).toEqual({ line: 3, column: 1 })
  })

  it('clamps out-of-range offsets instead of throwing', () => {
    expect(positionAt('{}', -5)).toEqual({ line: 1, column: 1 })
    expect(positionAt('{}', 99)).toEqual({ line: 1, column: 3 })
  })
})
