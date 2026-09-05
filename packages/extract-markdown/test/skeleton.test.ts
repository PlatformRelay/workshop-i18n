import type { UnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import {
  CompositionError,
  composeSkeleton,
  createSkeleton,
  type Hole,
  SkeletonError,
  skeletonUnits,
  stripContinuationPrefix,
} from '../src/skeleton.js'

const id = (unitKey: string): UnitId => ({ surface: 'labs', containerId: 'day-1-05-pod', unitKey })

function markdownHole(start: number, end: number, source: string, unitKey: string): Hole {
  return {
    id: id(unitKey),
    start,
    end,
    source,
    encoding: { kind: 'markdown', continuationPrefix: '' },
  }
}

describe('createSkeleton', () => {
  const source = 'alpha bravo charlie'

  it('sorts holes into ascending order', () => {
    const skeleton = createSkeleton(source, [
      markdownHole(12, 19, 'charlie', 'body/p-2'),
      markdownHole(0, 5, 'alpha', 'body/p-1'),
    ])
    expect(skeleton.holes.map((hole) => hole.start)).toEqual([0, 12])
    expect(skeleton.source).toBe(source)
  })

  it('rejects overlapping holes', () => {
    expect(() =>
      createSkeleton(source, [
        markdownHole(0, 8, 'alpha br', 'body/p-1'),
        markdownHole(6, 11, 'bravo', 'body/p-2'),
      ]),
    ).toThrow(SkeletonError)
  })

  it('rejects a range outside the source', () => {
    expect(() => createSkeleton(source, [markdownHole(0, 999, 'x', 'body/p-1')])).toThrow(
      SkeletonError,
    )
  })

  it('rejects a duplicate identity', () => {
    expect(() =>
      createSkeleton(source, [
        markdownHole(0, 5, 'alpha', 'body/p-1'),
        markdownHole(6, 11, 'bravo', 'body/p-1'),
      ]),
    ).toThrow(SkeletonError)
  })
})

describe('skeletonUnits', () => {
  it('mints every unit through the core factory, in identity order', () => {
    const skeleton = createSkeleton('bravo alpha', [
      markdownHole(6, 11, 'alpha', 'body/p-2'),
      markdownHole(0, 5, 'bravo', 'body/p-1'),
    ])
    const units = skeletonUnits(skeleton)
    expect(units.map((unit) => unit.id.unitKey)).toEqual(['body/p-1', 'body/p-2'])
    expect(units.every((unit) => unit.sourceHash.startsWith('sha256:'))).toBe(true)
  })
})

describe('composeSkeleton', () => {
  const source = '# Title\n\nFirst paragraph.\n\n```bash\nkubectl get pods\n```\n\nSecond.\n'
  const skeleton = createSkeleton(source, [
    markdownHole(2, 7, 'Title', 'body/h1-1/title'),
    markdownHole(9, 25, 'First paragraph.', 'body/h1-1/p-1'),
    markdownHole(57, 64, 'Second.', 'body/h1-1/p-2'),
  ])

  it('reproduces the source from an empty catalog', () => {
    expect(composeSkeleton(skeleton, {})).toBe(source)
  })

  it('treats an identity translation as a no-op', () => {
    expect(
      composeSkeleton(skeleton, {
        'labs:day-1-05-pod:body/h1-1/title': 'Title',
        'labs:day-1-05-pod:body/h1-1/p-1': 'First paragraph.',
      }),
    ).toBe(source)
  })

  it('splices translations without moving any other byte', () => {
    const composed = composeSkeleton(skeleton, {
      'labs:day-1-05-pod:body/h1-1/title': 'Titel',
      'labs:day-1-05-pod:body/h1-1/p-2': 'Zweiter.',
    })
    expect(composed).toBe(
      '# Titel\n\nFirst paragraph.\n\n```bash\nkubectl get pods\n```\n\nZweiter.\n',
    )
  })

  it('accepts a Map as well as a record', () => {
    const composed = composeSkeleton(
      skeleton,
      new Map([['labs:day-1-05-pod:body/h1-1/title', 'Titel']]),
    )
    expect(composed).toContain('# Titel')
  })

  it.each([
    ['a thematic break', 'erste Zeile\n---\nzweite', 'thematic-break'],
    ['a setext underline', 'erste Zeile\n===\nzweite', 'setext-underline'],
    ['a fence opener', 'erste\n```bash\nzweite', 'fence-opener'],
    ['a tilde fence opener', 'erste\n~~~\nzweite', 'fence-opener'],
    ['an HTML comment opener', 'erste <!-- versteckt', 'comment-terminator'],
    ['an HTML comment terminator', 'erste --> zweite', 'comment-terminator'],
    ['a control character', 'erste \u0007 zweite', 'control-byte'],
  ] as const)('refuses a translation containing %s', (_label, translation, reason) => {
    let caught: unknown
    try {
      composeSkeleton(skeleton, { 'labs:day-1-05-pod:body/h1-1/p-1': translation })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CompositionError)
    expect((caught as CompositionError).issues.map((issue) => issue.reason)).toEqual([reason])
    expect((caught as CompositionError).issues[0]?.id).toBe('labs:day-1-05-pod:body/h1-1/p-1')
  })

  it('reports every refused replacement, not just the first', () => {
    let caught: unknown
    try {
      composeSkeleton(skeleton, {
        'labs:day-1-05-pod:body/h1-1/p-1': 'a\n---\nb',
        'labs:day-1-05-pod:body/h1-1/p-2': 'c <!-- d',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as CompositionError).issues).toHaveLength(2)
  })

  it('re-applies the container prefix to every continuation line', () => {
    const quoted = '> wrapped one\n> wrapped two\n'
    const withPrefix = createSkeleton(quoted, [
      {
        id: id('body/bq-1/p-1'),
        start: 2,
        end: 27,
        source: 'wrapped one\nwrapped two',
        encoding: { kind: 'markdown', continuationPrefix: '> ' },
      },
    ])
    expect(composeSkeleton(withPrefix, { 'labs:day-1-05-pod:body/bq-1/p-1': 'eins\nzwei' })).toBe(
      '> eins\n> zwei\n',
    )
  })

  it('re-emits CRLF spans with CRLF', () => {
    const crlf = 'eine Zeile\r\nzweite Zeile\r\n'
    const skel = createSkeleton(crlf, [
      {
        id: id('body/p-1'),
        start: 0,
        end: 24,
        source: 'eine Zeile\nzweite Zeile',
        encoding: { kind: 'markdown', continuationPrefix: '' },
      },
    ])
    expect(composeSkeleton(skel, { 'labs:day-1-05-pod:body/p-1': 'a\nb' })).toBe('a\r\nb\r\n')
  })

  describe('html-inline holes', () => {
    const html = '<details><summary>Solution</summary>\n'
    const skel = createSkeleton(html, [
      {
        id: id('body/html-1/summary-1'),
        start: 18,
        end: 26,
        source: 'Solution',
        encoding: { kind: 'html-inline' },
      },
    ])

    it('splices inside the summary tag', () => {
      expect(composeSkeleton(skel, { 'labs:day-1-05-pod:body/html-1/summary-1': 'Lösung' })).toBe(
        '<details><summary>Lösung</summary>\n',
      )
    })

    it.each([
      ['a closing summary tag', 'a</summary><script>', 'tag-escape'],
      ['a line break', 'erste\nzweite', 'tag-escape'],
      ['a comment opener', 'a <!-- b', 'comment-terminator'],
    ] as const)('refuses a summary translation containing %s', (_label, translation, reason) => {
      let caught: unknown
      try {
        composeSkeleton(skel, { 'labs:day-1-05-pod:body/html-1/summary-1': translation })
      } catch (error) {
        caught = error
      }
      expect((caught as CompositionError).issues.map((issue) => issue.reason)).toEqual([reason])
    })

    it('allows inline markup that does not close the tag', () => {
      expect(
        composeSkeleton(skel, {
          'labs:day-1-05-pod:body/html-1/summary-1': 'Fehler <code>403</code>',
        }),
      ).toBe('<details><summary>Fehler <code>403</code></summary>\n')
    })
  })
})

describe('stripContinuationPrefix', () => {
  it('removes the prefix from continuation lines only', () => {
    expect(stripContinuationPrefix('> a\n> b\n> c', '> ')).toBe('> a\nb\nc')
  })

  it('leaves a line that does not carry the prefix intact', () => {
    expect(stripContinuationPrefix('> a\nlazy', '> ')).toBe('> a\nlazy')
  })

  it('normalizes CRLF to LF so unit text has one spelling', () => {
    expect(stripContinuationPrefix('a\r\nb', '')).toBe('a\nb')
  })
})
