import { describe, expect, it } from 'vitest'
import { findCodeSpans, findMustaches } from '../src/inline-scan.js'

const contents = (text: string) => findCodeSpans(text).map((span) => span.content)

describe('findCodeSpans', () => {
  it.each([
    ['one span', 'run `kubectl get pods` now', ['kubectl get pods']],
    ['two spans', '`a` and `b`', ['a', 'b']],
    ['a double-backtick span holding a backtick', 'use `` a`b `` here', [' a`b ']],
    ['an unmatched opener is literal text', 'a ` b', []],
    ['a closer must be the same length', '`a`` b`', ['a`` b']],
    ['an unmatched longer run is skipped, a later pair still matches', '``` x `y`', ['y']],
    ['a backslash-escaped backtick cannot open', 'a \\`b` c`', [' c']],
    ['inside a span a backslash is literal and the run still closes', '`a\\` b', ['a\\']],
  ])('%s', (_label, text, expected) => {
    expect(contents(text)).toEqual(expected)
  })

  it('reports offsets that slice back to the whole span', () => {
    const text = 'x `y` z'
    const [span] = findCodeSpans(text)
    expect(text.slice(span?.start, span?.end)).toBe('`y`')
  })

  it('is linear on hostile backtick runs', () => {
    const hostile = `${'`'.repeat(8000)}${' `x'.repeat(8000)}`
    const started = performance.now()
    findCodeSpans(hostile)
    findCodeSpans('`'.repeat(20000))
    findCodeSpans(Array.from({ length: 4000 }, (_, index) => '`'.repeat(index % 50)).join('a'))
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('findMustaches', () => {
  it('finds complete interpolations and counts openers', () => {
    expect(findMustaches('a {{ x }} b {{y}} c {{ open')).toEqual({
      complete: ['{{ x }}', '{{y}}'],
      openers: 3,
    })
  })

  it('is linear on hostile openers', () => {
    const started = performance.now()
    findMustaches('{{'.repeat(100_000))
    expect(performance.now() - started).toBeLessThan(500)
  })
})
