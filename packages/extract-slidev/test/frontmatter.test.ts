import { describe, expect, it } from 'vitest'
import { parseSlidevDeck, type SlideRange } from '../src/deck.js'
import {
  DEFAULT_FRONTMATTER_TEXT_KEYS,
  type FrontmatterLocation,
  locateFrontmatter,
} from '../src/frontmatter.js'

function locate(source: string, keys = DEFAULT_FRONTMATTER_TEXT_KEYS): FrontmatterLocation {
  const slide = parseSlidevDeck(source).slides[0] as SlideRange
  const block = slide.frontmatter
  if (block === undefined) throw new Error('fixture has no frontmatter block')
  return locateFrontmatter(source, block, new Set(keys))
}

describe('locateFrontmatter', () => {
  it('locates declared text fields and leaves machinery alone', () => {
    const source = [
      '---',
      'layout: statement',
      'kicker: Why Pods?',
      'image: /covers/section-05.webp',
      'clicks: 3',
      '---',
      '',
    ].join('\n')
    const located = locate(source)
    expect(located.fields.map((field) => field.key)).toEqual(['kicker'])
    expect(source.slice(located.fields[0]?.start, located.fields[0]?.end)).toBe('Why Pods?')
    expect(located.fields[0]?.value).toBe('Why Pods?')
  })

  it('decodes a quoted scalar but spans the quotes, so composition can requote it', () => {
    const source = ['---', "heading: 'It''s a pointer, not a version'", '---', ''].join('\n')
    const located = locate(source)
    expect(located.fields[0]?.value).toBe("It's a pointer, not a version")
    expect(source.slice(located.fields[0]?.start, located.fields[0]?.end)).toBe(
      "'It''s a pointer, not a version'",
    )
  })

  it('spans a block scalar without swallowing the newline that ends it', () => {
    const source = [
      '---',
      'story: |',
      '  first line',
      '  second line',
      'clicks: 2',
      '---',
      '',
    ].join('\n')
    const located = locate(source)
    expect(located.fields[0]?.value).toBe('first line\nsecond line\n')
    expect(source.slice(located.fields[0]?.end)).toBe('\nclicks: 2\n---\n')
  })

  it('keeps non-ASCII in a value intact', () => {
    const source = ['---', "env: 'kind ✓ / namespace: read-only'", '---', ''].join('\n')
    expect(locate(source).fields[0]?.value).toBe('kind ✓ / namespace: read-only')
  })

  it('reads the slide identity', () => {
    const source = ['---', 'slideId: s05-pod-what-is-a-pod', 'layout: statement', '---', ''].join(
      '\n',
    )
    expect(locate(source).slideId).toBe('s05-pod-what-is-a-pod')
  })

  it('reports a declared text field that is not a string scalar instead of extracting it', () => {
    const source = ['---', 'heading:', '  - one', '  - two', '---', ''].join('\n')
    const located = locate(source)
    expect(located.fields).toEqual([])
    expect(located.diagnostics.map((d) => d.code)).toEqual(['non-scalar-text-field'])
    expect(located.diagnostics[0]?.severity).toBe('warning')
  })

  it('does not extract a number that happens to sit under a declared key', () => {
    const source = ['---', 'duration: 40', '---', ''].join('\n')
    expect(locate(source).fields).toEqual([])
  })

  it('reports a dash run inside a value, which truncates the block for the renderer', () => {
    // `RE_FRONTMATTER` is `/^---.*\r?\n([\s\S]*?)---/`: lazy, and its close is not
    // line-anchored. Slidev reads `{title: "a"}` here and renders everything from the
    // dash run onward — the `slideId:` line included — as slide prose.
    const source = ['---', 'slideId: s01-x', 'title: "a --- b"', 'layout: cover', '---', ''].join(
      '\n',
    )
    const located = locate(source)
    expect(located.diagnostics.map((d) => d.code)).toContain('malformed-frontmatter')
    expect(located.diagnostics.find((d) => d.code === 'malformed-frontmatter')?.severity).toBe(
      'error',
    )
  })

  it('reports frontmatter that is not valid YAML', () => {
    const source = ['---', 'heading: "unterminated', '---', ''].join('\n')
    const located = locate(source)
    expect(located.diagnostics.map((d) => d.code)).toEqual(['malformed-frontmatter'])
    expect(located.diagnostics[0]?.severity).toBe('error')
  })

  it('reports frontmatter that is not a mapping', () => {
    const source = ['---', '- one', '- two', '---', ''].join('\n')
    expect(locate(source).diagnostics.map((d) => d.code)).toEqual(['malformed-frontmatter'])
  })

  it('accepts an empty block without complaint', () => {
    const source = ['---', '#  only a comment', '---', ''].join('\n')
    const located = locate(source)
    expect(located.fields).toEqual([])
    expect(located.diagnostics).toEqual([])
  })

  it('extracts nothing when the caller declares no text keys', () => {
    const source = ['---', 'kicker: Why Pods?', '---', ''].join('\n')
    expect(locate(source, []).fields).toEqual([])
  })

  it('declares the consumer deck text keys by default and no machinery keys', () => {
    expect(DEFAULT_FRONTMATTER_TEXT_KEYS).toContain('heading')
    expect(DEFAULT_FRONTMATTER_TEXT_KEYS).toContain('kicker')
    expect(DEFAULT_FRONTMATTER_TEXT_KEYS).toContain('leftHeading')
    for (const machinery of ['layout', 'src', 'image', 'lab', 'class', 'clicks', 'slideId']) {
      expect(DEFAULT_FRONTMATTER_TEXT_KEYS).not.toContain(machinery)
    }
  })
})
