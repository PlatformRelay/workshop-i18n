import { parseUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import {
  CompositionError,
  composeSkeleton,
  createSkeleton,
  type Hole,
  type HoleEncoding,
  SkeletonError,
  skeletonUnits,
} from '../src/skeleton.js'

const markdown = (continuationPrefix = '', context: 'body' | 'note' = 'body') =>
  ({ kind: 'markdown', continuationPrefix, context }) as const

function hole(
  id: string,
  start: number,
  end: number,
  source: string,
  encoding: HoleEncoding = markdown(),
): Hole {
  return { id: parseUnitId(id), start, end, source, encoding }
}

describe('createSkeleton', () => {
  const source = 'alpha beta gamma'

  it('sorts holes ascending so composition can splice them in descending order', () => {
    const skeleton = createSkeleton(source, [
      hole('slides:s1:body/p-2', 11, 16, 'gamma'),
      hole('slides:s1:body/p-1', 0, 5, 'alpha'),
    ])
    expect(skeleton.holes.map((h) => h.start)).toEqual([0, 11])
  })

  it('refuses overlapping holes — two units may never claim the same byte', () => {
    expect(() =>
      createSkeleton(source, [
        hole('slides:s1:body/p-1', 0, 6, 'alpha '),
        hole('slides:s1:body/p-2', 5, 10, ' beta'),
      ]),
    ).toThrow(SkeletonError)
  })

  it('refuses a hole that runs past the end of the source', () => {
    expect(() => createSkeleton(source, [hole('slides:s1:body/p-1', 11, 99, 'gamma')])).toThrow(
      SkeletonError,
    )
  })

  it('refuses a reversed range', () => {
    expect(() => createSkeleton(source, [hole('slides:s1:body/p-1', 11, 4, 'x')])).toThrow(
      SkeletonError,
    )
  })

  it('refuses two holes sharing one identity', () => {
    expect(() =>
      createSkeleton(source, [
        hole('slides:s1:body/p-1', 0, 5, 'alpha'),
        hole('slides:s1:body/p-1', 11, 16, 'gamma'),
      ]),
    ).toThrow(SkeletonError)
  })
})

describe('skeletonUnits', () => {
  it('mints every unit through the core factory, in identity order', () => {
    const skeleton = createSkeleton('alpha beta gamma', [
      hole('slides:s1:body/p-2', 11, 16, 'gamma'),
      hole('slides:s1:body/p-1', 0, 5, 'alpha'),
    ])
    const units = skeletonUnits(skeleton)
    expect(units.map((u) => u.id.unitKey)).toEqual(['body/p-1', 'body/p-2'])
    expect(units[0]?.sourceHash).toMatch(/^sha256:[0-9a-f]{16}$/)
  })
})

describe('composeSkeleton', () => {
  const source = '# Heading\n\nA paragraph.\n'
  const skeleton = createSkeleton(source, [
    hole('slides:s1:body/h1-1/title', 2, 9, 'Heading'),
    hole('slides:s1:body/h1-1/p-1', 11, 23, 'A paragraph.'),
  ])

  it('reproduces the source byte-for-byte when nothing is translated (ADR 0012)', () => {
    expect(composeSkeleton(skeleton, {})).toBe(source)
  })

  it('splices only the holes and copies every other byte through', () => {
    expect(composeSkeleton(skeleton, { 'slides:s1:body/h1-1/p-1': 'Ein Absatz.' })).toBe(
      '# Heading\n\nEin Absatz.\n',
    )
  })

  it('ignores translations for identities the skeleton does not contain', () => {
    expect(composeSkeleton(skeleton, { 'slides:s9:body/p-1': 'nope' })).toBe(source)
  })

  it('treats a translation identical to the source as a no-op copy', () => {
    expect(composeSkeleton(skeleton, { 'slides:s1:body/h1-1/title': 'Heading' })).toBe(source)
  })

  it('accepts a Map as well as a record', () => {
    const map = new Map([['slides:s1:body/h1-1/title', 'Überschrift']])
    expect(composeSkeleton(skeleton, map)).toBe('# Überschrift\n\nA paragraph.\n')
  })
})

describe('composeSkeleton line prefixes', () => {
  // `> ` prefixes the continuation line, and is skeleton — it must survive a translation
  // that wraps differently from the English.
  const source = '> quoted line\n> continued here\n'
  const skeleton = createSkeleton(source, [
    hole('slides:s1:body/bq-1/p-1', 2, 30, 'quoted line\ncontinued here', markdown('> ')),
  ])

  it('strips the container prefix out of the unit source', () => {
    expect(skeletonUnits(skeleton)[0]?.source).toBe('quoted line\ncontinued here')
  })

  it('re-applies the container prefix to every continuation line of a translation', () => {
    expect(composeSkeleton(skeleton, { 'slides:s1:body/bq-1/p-1': 'eins\nzwei\ndrei' })).toBe(
      '> eins\n> zwei\n> drei\n',
    )
  })
})

describe('composeSkeleton refuses a replacement that would break out of its hole', () => {
  const source = 'A paragraph.\n'
  const skeleton = createSkeleton(source, [hole('slides:s1:body/p-1', 0, 12, 'A paragraph.')])

  it('rejects a line that Slidev would read as a slide separator', () => {
    expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins\n---\nzwei' })).toThrow(
      CompositionError,
    )
  })

  it('rejects a line that would open a fenced code block', () => {
    expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins\n```js\nzwei' })).toThrow(
      CompositionError,
    )
  })

  it('rejects a control byte', () => {
    expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins\u0000zwei' })).toThrow(
      CompositionError,
    )
  })

  it('names the offending identity', () => {
    try {
      composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins\n---\nzwei' })
      expect.unreachable('composition should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionError)
      expect((error as CompositionError).issues[0]?.id).toBe('slides:s1:body/p-1')
      expect((error as CompositionError).issues[0]?.reason).toBe('slide-separator')
    }
  })

  it('rejects a body translation that opens an HTML comment', () => {
    // Bytes would survive, but the renderer would swallow the skeleton after the hole.
    expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins <!-- zwei' })).toThrow(
      CompositionError,
    )
  })

  it('rejects a speaker-note translation that closes the HTML comment early', () => {
    const note = '<!--\nSpeaker: hello\n-->\n'
    const noteSkeleton = createSkeleton(note, [
      hole('slides:s1:note/p-1', 5, 19, 'Speaker: hello', markdown('', 'note')),
    ])
    expect(() => composeSkeleton(noteSkeleton, { 'slides:s1:note/p-1': 'ende --> jetzt' })).toThrow(
      CompositionError,
    )
  })
})

describe('composeSkeleton re-encodes a YAML scalar', () => {
  const source = "---\nkicker: Why Pods?\nheading: 'It''s here'\n---\n"
  const skeleton = createSkeleton(source, [
    hole('slides:s1:fm/kicker', 12, 21, 'Why Pods?', { kind: 'yaml-scalar' }),
    hole('slides:s1:fm/heading', 31, 43, "It's here", { kind: 'yaml-scalar' }),
  ])

  it('copies the original scalar bytes when nothing is translated', () => {
    expect(composeSkeleton(skeleton, {})).toBe(source)
  })

  it('emits a double-quoted scalar so hostile translations cannot restructure the YAML', () => {
    const composed = composeSkeleton(skeleton, {
      'slides:s1:fm/kicker': 'Warum: Pods?',
      'slides:s1:fm/heading': 'Zeile eins\nZeile zwei',
    })
    expect(composed).toBe('---\nkicker: "Warum: Pods?"\nheading: "Zeile eins\\nZeile zwei"\n---\n')
  })
})
