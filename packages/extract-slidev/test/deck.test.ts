import { describe, expect, it } from 'vitest'
import { parseSlidevDeck, type SlideRange } from '../src/deck.js'

function bodies(source: string): readonly string[] {
  return parseSlidevDeck(source).slides.map((slide) => source.slice(slide.bodyStart, slide.bodyEnd))
}

function frontmatterOf(source: string, slide: SlideRange): string | undefined {
  const block = slide.frontmatter
  return block === undefined ? undefined : source.slice(block.bodyStart, block.bodyEnd)
}

describe('parseSlidevDeck', () => {
  it('reads the leading block as the first slide frontmatter (Slidev headmatter)', () => {
    const source = ['---', 'theme: default', 'layout: cover', '---', '', '# Welcome', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0]?.isHeadmatter).toBe(true)
    expect(frontmatterOf(source, deck.slides[0] as SlideRange)).toBe(
      'theme: default\nlayout: cover\n',
    )
    expect(bodies(source)).toEqual(['\n# Welcome\n'])
  })

  it('starts the first slide at offset zero when the file has no leading block', () => {
    const source = '# Welcome\n\n---\n\n# Second\n'
    const deck = parseSlidevDeck(source)
    expect(deck.slides[0]?.start).toBe(0)
    expect(deck.slides[0]?.isHeadmatter).toBe(false)
    expect(deck.slides[0]?.frontmatter).toBeUndefined()
    expect(bodies(source)).toEqual(['# Welcome\n\n', '\n# Second\n'])
  })

  it('separates a slide that carries frontmatter from one that does not', () => {
    const source = [
      '---',
      'layout: cover',
      '---',
      '',
      '# One',
      '',
      '---',
      '',
      '# Two',
      '',
      '---',
      'layout: statement',
      'kicker: Why Pods?',
      '---',
      '',
      '# Three',
      '',
    ].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides.map((slide) => frontmatterOf(source, slide))).toEqual([
      'layout: cover\n',
      undefined,
      'layout: statement\nkicker: Why Pods?\n',
    ])
    expect(bodies(source)).toEqual(['\n# One\n\n', '\n# Two\n\n', '\n# Three\n'])
  })

  it('covers the whole source with slide ranges and loses no byte', () => {
    const source = ['---', 'layout: cover', '---', '', '# One', '', '---', '', '# Two', ''].join(
      '\n',
    )
    const deck = parseSlidevDeck(source)
    const rebuilt = deck.slides
      .map((slide, index) => {
        const previousEnd = index === 0 ? 0 : (deck.slides[index - 1]?.end ?? 0)
        return source.slice(previousEnd, slide.end)
      })
      .join('')
    expect(rebuilt).toBe(source)
  })
})

describe('parseSlidevDeck fence awareness', () => {
  it('ignores a YAML document separator inside a fenced block', () => {
    const source = [
      '---',
      'layout: code',
      '---',
      '',
      '```yaml',
      'kind: Role',
      '---',
      'kind: RoleBinding',
      '```',
      '',
    ].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(1)
  })

  it('ignores a separator inside a magic-move fence nested in a four-backtick fence', () => {
    const source = [
      '---',
      'layout: code',
      '---',
      '',
      '````md magic-move',
      '```yaml',
      'a: 1',
      '---',
      'b: 2',
      '```',
      '```yaml',
      'c: 3',
      '```',
      '````',
      '',
      '---',
      '',
      '# After',
      '',
    ].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(source.slice(deck.slides[1]?.bodyStart ?? 0)).toBe('\n# After\n')
  })

  it('ignores a separator inside a tilde fence', () => {
    const source = ['~~~text', '---', '~~~', '', '---', '', '# After', ''].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })

  it('does not let an indented closing fence leave the block open forever', () => {
    const source = ['```text', '---', '  ```', '', '---', '', '# After', ''].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })
})

describe('parseSlidevDeck diagnostics', () => {
  it('reports a frontmatter block that is never closed and keeps the slide usable', () => {
    const source = ['---', 'layout: cover', '', '# Never closed', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['unclosed-frontmatter'])
    expect(deck.diagnostics[0]?.severity).toBe('error')
    expect(deck.slides[0]?.frontmatter).toBeUndefined()
  })

  it('warns about a longer dash run rather than silently disagreeing with Slidev', () => {
    const source = ['---', 'layout: cover', '---', '', '# One', '', '----', '', '# Two', ''].join(
      '\n',
    )
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(1)
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['ambiguous-separator'])
    expect(deck.diagnostics[0]?.severity).toBe('warning')
    expect(deck.diagnostics[0]?.line).toBe(7)
  })

  it('does not warn about a dash run inside a fence', () => {
    const source = ['---', 'layout: cover', '---', '', '```text', '----', '```', ''].join('\n')
    expect(parseSlidevDeck(source).diagnostics).toEqual([])
  })
})

describe('parseSlidevDeck line endings and whitespace', () => {
  it('accepts CRLF without normalizing the source', () => {
    const source = ['---', 'layout: cover', '---', '', '# One', '', '---', '', '# Two', ''].join(
      '\r\n',
    )
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(frontmatterOf(source, deck.slides[0] as SlideRange)).toBe('layout: cover\r\n')
    expect(source.slice(deck.slides[1]?.bodyStart ?? 0)).toBe('\r\n# Two\r\n')
  })

  it('accepts trailing whitespace on a separator line', () => {
    const source = [
      '---',
      'layout: cover',
      '---  ',
      '',
      '# One',
      '',
      '---\t',
      '',
      '# Two',
      '',
    ].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })

  it('treats an indented dash run as content, not a separator', () => {
    const source = ['---', 'layout: cover', '---', '', ' ---', '', '# One', ''].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(1)
  })

  it('keeps a byte-order mark as part of the source', () => {
    const source = '﻿---\nlayout: cover\n---\n\n# One\n'
    const deck = parseSlidevDeck(source)
    // A byte-order mark before the opening delimiter must not hide the headmatter, and it
    // must still be present in the source that composition copies back out.
    expect(deck.slides).toHaveLength(1)
    expect(frontmatterOf(source, deck.slides[0] as SlideRange)).toBe('layout: cover\n')
    expect(source.startsWith('\ufeff')).toBe(true)
  })
})
