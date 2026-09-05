import { describe, expect, it } from 'vitest'
import { decodeSource, positionAt, SourceDecodeError } from '../src/source.js'

describe('decodeSource', () => {
  it('round-trips valid UTF-8, byte for byte', () => {
    const text = 'Pod → ReplicaSet ✓ 🚀\r\nzweite Zeile\n'
    const bytes = Buffer.from(text, 'utf8')
    expect(decodeSource(bytes)).toBe(text)
    expect(Buffer.from(decodeSource(bytes), 'utf8')).toEqual(bytes)
  })

  it('keeps a byte-order mark instead of stripping it', () => {
    const bytes = Buffer.from('﻿# Lab\n', 'utf8')
    expect(decodeSource(bytes)).toBe('﻿# Lab\n')
  })

  it('refuses invalid UTF-8 rather than substituting U+FFFD', () => {
    const bytes = Buffer.from([0x23, 0x20, 0xff, 0x0a])
    expect(() => decodeSource(bytes, 'labs/day-1/05-pod.md')).toThrow(SourceDecodeError)
    expect(() => decodeSource(bytes, 'labs/day-1/05-pod.md')).toThrow(/labs\/day-1\/05-pod\.md/)
  })

  it('refuses a lone surrogate encoded as CESU-8', () => {
    expect(() => decodeSource(Buffer.from([0xed, 0xa0, 0x80]))).toThrow(SourceDecodeError)
  })
})

describe('positionAt', () => {
  it('reports 1-based line and column', () => {
    const text = 'one\ntwo\nthree'
    expect(positionAt(text, 0)).toEqual({ line: 1, column: 1 })
    expect(positionAt(text, 4)).toEqual({ line: 2, column: 1 })
    expect(positionAt(text, 9)).toEqual({ line: 3, column: 2 })
  })

  it('clamps out-of-range offsets instead of throwing', () => {
    expect(positionAt('abc', -5)).toEqual({ line: 1, column: 1 })
    expect(positionAt('abc', 99)).toEqual({ line: 1, column: 4 })
  })
})
