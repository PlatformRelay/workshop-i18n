import { describe, expect, it } from 'vitest'
import { stripTags } from '../src/index.js'

/**
 * The pattern `stripTags` replaced, spelled as split-and-join (same matches, same result),
 * kept as the oracle for what it must still return.
 */
const reference = (html: string): string => html.split(/<[^>]*>/).join('')

describe('stripTags', () => {
  it.each([
    ['', ''],
    ['plain text', 'plain text'],
    ['<b>bold</b> text', 'bold text'],
    ['<p><b>abc</b></p>', 'abc'],
    ['<<b>>abc', '>abc'],
    ['a < b > c', 'a  c'],
    ['< 5 items', '< 5 items'],
    ['tail <unclosed', 'tail <unclosed'],
    ['<a\nhref="x">multi-line tag</a>', 'multi-line tag'],
    ['a > b', 'a > b'],
    ['<>', ''],
  ])('removes every tag run from %j', (html, expected) => {
    expect(stripTags(html)).toBe(expected)
    expect(reference(html)).toBe(expected)
  })

  it('returns what the regex it replaced returned, on random markup soup', () => {
    const alphabet = ['<', '>', 'a', 'b', ' ', '\n', '/', '&', ';', '#']
    let seed = 0x2545f491
    const next = (): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x1_0000_0000
    }
    for (let round = 0; round < 5_000; round += 1) {
      let html = ''
      for (let length = Math.floor(next() * 14); length > 0; length -= 1) {
        html += alphabet[Math.floor(next() * alphabet.length)]
      }
      expect(stripTags(html), JSON.stringify(html)).toBe(reference(html))
    }
  })

  it('is linear on a line of 100,000 unclosed "<", where the regex is quadratic', () => {
    const hostile = '<'.repeat(100_000)
    const started = performance.now()
    expect(stripTags(hostile)).toBe(hostile)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
