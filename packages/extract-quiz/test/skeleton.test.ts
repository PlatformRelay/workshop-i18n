import type { UnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import {
  CompositionError,
  composeSkeleton,
  createSkeleton,
  encodeJsonStringBody,
  type Hole,
  SkeletonError,
  skeletonUnits,
} from '../src/skeleton.js'

const id = (unitKey: string): UnitId => ({ surface: 'quiz', containerId: 'S00-Q-RET-01', unitKey })

const SOURCE = '{ "prompt": "Why?", "explanation": "Because." }'
const PROMPT_START = SOURCE.indexOf('Why?')
const EXPLANATION_START = SOURCE.indexOf('Because.')

function hole(start: number, text: string, unitKey: string): Hole {
  return {
    id: id(unitKey),
    start,
    end: start + text.length,
    source: text,
    encoding: { kind: 'json-string' },
  }
}

const SKELETON = createSkeleton(SOURCE, [
  hole(PROMPT_START, 'Why?', 'prompt'),
  hole(EXPLANATION_START, 'Because.', 'explanation'),
])

describe('encodeJsonStringBody', () => {
  it('escapes exactly what JSON.stringify escapes, without the surrounding quotes', () => {
    for (const text of ['plain', 'a"b', 'a\\b', 'a\nb', 'a\tb', 'café', '🚀', 'a\u0007b']) {
      expect(`"${encodeJsonStringBody(text)}"`).toBe(JSON.stringify(text))
    }
  })

  it('produces a body that JSON.parse reads back unchanged', () => {
    for (const text of ['a"b\\c/d', '↔ ✓ 🚀', 'Zeile\nZwei']) {
      expect(JSON.parse(`"${encodeJsonStringBody(text)}"`)).toBe(text)
    }
  })
})

describe('createSkeleton', () => {
  it('rejects overlapping holes, out-of-range ranges and duplicate identities', () => {
    expect(() => createSkeleton(SOURCE, [hole(0, SOURCE, 'a'), hole(1, 'x', 'b')])).toThrow(
      SkeletonError,
    )
    expect(() => createSkeleton('short', [hole(0, 'much longer than the source', 'a')])).toThrow(
      SkeletonError,
    )
    expect(() =>
      createSkeleton(SOURCE, [hole(PROMPT_START, 'Why?', 'a'), hole(EXPLANATION_START, 'x', 'a')]),
    ).toThrow(SkeletonError)
  })
})

describe('skeletonUnits', () => {
  it('mints every unit through the core factory, in identity order', () => {
    expect(skeletonUnits(SKELETON).map((unit) => unit.id.unitKey)).toEqual([
      'explanation',
      'prompt',
    ])
    expect(skeletonUnits(SKELETON).every((unit) => unit.sourceHash.startsWith('sha256:'))).toBe(
      true,
    )
  })
})

describe('composeSkeleton', () => {
  it('reproduces the source from an empty catalog, whitespace and key order included', () => {
    expect(composeSkeleton(SKELETON, {})).toBe(SOURCE)
  })

  it('treats an identity translation as a no-op, so an escaped source keeps its spelling', () => {
    // The source spells the accent as an escape; the unit's decoded value does not. An
    // identity translation must therefore copy the original bytes rather than re-encode,
    // or every unchanged string in the file would be rewritten into a different spelling.
    const escaped = String.raw`{"prompt": "caf\u00e9"}`
    const start = escaped.indexOf(String.raw`caf\u00e9`)
    const skeleton = createSkeleton(escaped, [
      {
        id: id('prompt'),
        start,
        end: start + String.raw`caf\u00e9`.length,
        source: 'café',
        encoding: { kind: 'json-string' },
      },
    ])
    expect(composeSkeleton(skeleton, { 'quiz:S00-Q-RET-01:prompt': 'café' })).toBe(escaped)
  })

  it('splices a translation as an escaped JSON string body', () => {
    const composed = composeSkeleton(SKELETON, {
      'quiz:S00-Q-RET-01:prompt': 'Warum "so"?',
      'quiz:S00-Q-RET-01:explanation': 'Weil.\nDarum.',
    })
    expect(composed).toBe('{ "prompt": "Warum \\"so\\"?", "explanation": "Weil.\\nDarum." }')
    expect(JSON.parse(composed)).toEqual({ prompt: 'Warum "so"?', explanation: 'Weil.\nDarum.' })
  })

  it('leaves every byte outside the holes untouched, including the original indentation', () => {
    const pretty = '{\n\t"prompt": "Why?"\n}\n'
    const start = pretty.indexOf('Why?')
    const skeleton = createSkeleton(pretty, [
      {
        id: id('prompt'),
        start,
        end: start + 4,
        source: 'Why?',
        encoding: { kind: 'json-string' },
      },
    ])
    expect(composeSkeleton(skeleton, { 'quiz:S00-Q-RET-01:prompt': 'Warum?' })).toBe(
      '{\n\t"prompt": "Warum?"\n}\n',
    )
  })

  it.each([
    ['a control character', 'a\u0007b', 'control-byte'],
    ['a lone high surrogate', 'a\ud800b', 'lone-surrogate'],
    ['a lone low surrogate', 'a\udc00b', 'lone-surrogate'],
  ] as const)('refuses a translation containing %s', (_label, translation, reason) => {
    let caught: unknown
    try {
      composeSkeleton(SKELETON, { 'quiz:S00-Q-RET-01:prompt': translation })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CompositionError)
    expect((caught as CompositionError).issues.map((issue) => issue.reason)).toEqual([reason])
    expect((caught as CompositionError).issues[0]?.id).toBe('quiz:S00-Q-RET-01:prompt')
  })

  it('allows a newline and a tab, which JSON escapes rather than emits raw', () => {
    const composed = composeSkeleton(SKELETON, { 'quiz:S00-Q-RET-01:prompt': 'a\nb\tc' })
    expect(composed).toContain(String.raw`"a\nb\tc"`)
    expect(() => JSON.parse(composed)).not.toThrow()
  })

  it('reports every refused replacement, not just the first', () => {
    let caught: unknown
    try {
      composeSkeleton(SKELETON, {
        'quiz:S00-Q-RET-01:prompt': 'a\u0007b',
        'quiz:S00-Q-RET-01:explanation': 'c\ud800d',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as CompositionError).issues).toHaveLength(2)
  })

  it('accepts a Map as well as a record', () => {
    expect(composeSkeleton(SKELETON, new Map([['quiz:S00-Q-RET-01:prompt', 'Warum?']]))).toContain(
      '"Warum?"',
    )
  })
})
