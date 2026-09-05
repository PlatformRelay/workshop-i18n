import { describe, expect, it } from 'vitest'
import { decodeSource, positionAt, SourceDecodeError } from '../src/source.js'

/**
 * `decodeSource` is the guard the whole offset model rests on: offsets index the decoded
 * string, and that is only reversible to the exact bytes if decoding cannot silently
 * repair anything. `readFileSync(path, 'utf8')` does repair — it substitutes U+FFFD —
 * which would make a corrupted file round-trip green. Constitution III wants that proven.
 */
describe('decodeSource', () => {
  const invalid = new Uint8Array([0x41, 0xff, 0xfe, 0x42])

  it('refuses bytes that are not valid UTF-8', () => {
    expect(() => decodeSource(invalid)).toThrow(SourceDecodeError)
  })

  it('does not substitute U+FFFD for a bad byte, which would lose it silently', () => {
    let decoded: string | undefined
    try {
      decoded = decodeSource(invalid)
    } catch {
      decoded = undefined
    }
    expect(decoded).toBeUndefined()
    // The lenient decoder is exactly what must not happen here.
    expect(new TextDecoder('utf-8').decode(invalid)).toContain('�')
  })

  it('names the file it was given, so a report can point at it', () => {
    try {
      decodeSource(invalid, 'pages/S05-pod/index.md')
      expect.unreachable('decoding should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(SourceDecodeError)
      expect((error as SourceDecodeError).source).toBe('pages/S05-pod/index.md')
      expect((error as SourceDecodeError).message).toContain('pages/S05-pod/index.md')
    }
  })

  it('keeps a byte-order mark, because composition has to copy it back out', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a])
    const decoded = decodeSource(withBom)
    expect(decoded).toBe('﻿a\n')
    expect(Buffer.from(decoded, 'utf8')).toEqual(Buffer.from(withBom))
  })

  it('round-trips astral characters and every line ending unchanged', () => {
    for (const text of ['a\r\nb\n', '🐳 👨‍👩‍👧‍👦 🇩🇪', 'ünïcödé — ✓', '']) {
      const bytes = Buffer.from(text, 'utf8')
      expect(decodeSource(bytes)).toBe(text)
      expect(Buffer.from(decodeSource(bytes), 'utf8')).toEqual(bytes)
    }
  })
})

describe('positionAt', () => {
  const text = 'one\ntwo\nthree'

  it('reports 1-based line and column', () => {
    expect(positionAt(text, 0)).toEqual({ line: 1, column: 1 })
    expect(positionAt(text, 4)).toEqual({ line: 2, column: 1 })
    expect(positionAt(text, 9)).toEqual({ line: 3, column: 2 })
  })

  it('clamps an offset outside the text instead of returning nonsense', () => {
    expect(positionAt(text, -5)).toEqual({ line: 1, column: 1 })
    expect(positionAt(text, 9_999)).toEqual({ line: 3, column: 6 })
  })
})
