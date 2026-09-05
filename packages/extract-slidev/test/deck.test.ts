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

  it('agrees with Slidev that a tilde fence does not protect a separator, and says so', () => {
    // Slidev 52 tracks backtick fences only, so it splits at the `---` and then reads the
    // rest of the code block as the next slide's frontmatter — two slides, one of them
    // nonsense. Agreeing silently would key prose under a slide nobody sees, so the split
    // matches the renderer and the file is refused.
    const source = [
      '~~~yaml',
      'kind: Role',
      '---',
      'kind: Binding',
      '~~~',
      '',
      '---',
      '',
      '# After',
      '',
    ].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(source.slice(deck.slides[0]?.bodyStart, deck.slides[0]?.bodyEnd)).toBe(
      '~~~yaml\nkind: Role\n',
    )
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['separator-in-tilde-fence'])
    expect(deck.diagnostics[0]?.severity).toBe('error')
    expect(deck.diagnostics[0]?.line).toBe(3)
  })

  it('leaves a tilde fence with no separator in it alone', () => {
    const source = ['~~~text', 'kind: Role', '~~~', '', '---', '', '# After', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(deck.diagnostics).toEqual([])
  })

  it('lets an outer backtick fence protect a tilde fence nested inside it', () => {
    const source = [
      '````md magic-move',
      '~~~yaml',
      'kind: Role',
      '---',
      'kind: Binding',
      '~~~',
      '````',
      '',
      '---',
      '',
      '# After',
      '',
    ].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(deck.diagnostics).toEqual([])
  })

  it('does not let an indented closing fence leave the block open forever', () => {
    const source = ['```text', '---', '  ```', '', '---', '', '# After', ''].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })
})

/**
 * Every expectation here is Slidev 52.19.0's measured answer, taken from its scanner
 * (`dist/core.mjs`, the loop at the end of `parse`) rather than inferred from behaviour.
 * `slidev-parser-differential.test.ts` re-derives them from the real parser when it is
 * available; these pin them so the suite still defends the contract when it is not.
 */
describe('parseSlidevDeck follows Slidev through the shapes fixtures do not contain', () => {
  it('carries HTML-comment state across lines, so a note may contain a separator', () => {
    // Slidev tracks `<!--` / `-->` across the whole scan. Splitting here would mint an
    // identity for a slide nobody renders and let init-ids write into a speaker note.
    const source = [
      '# Welcome',
      '',
      '<!--',
      'Remember the two clusters',
      '',
      '---',
      '',
      'Then move on to the demo',
      '-->',
      '',
    ].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(1)
    expect(deck.diagnostics).toEqual([])
  })

  it('closes a comment that opens and closes on one line', () => {
    const source = 'a <!-- aside --> b\n\n---\n\nc\n'
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })

  it('reopens on a second comment after the first one closed', () => {
    const source = '<!-- one -->\n\n<!--\n---\n-->\n\n---\n\nafter\n'
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })

  it('does not let a dash run of four or more open a frontmatter block', () => {
    // Slidev guards this with `line[3] !== "-"`. Without the guard the slide body is
    // swallowed as frontmatter and the next slide's YAML is offered up as prose.
    const source = ['# One', '', '----', 'layout: cover', '---', '', 'body', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides.every((slide) => slide.frontmatter === undefined)).toBe(true)
  })

  it('splits at a setext underline without swallowing what follows it', () => {
    const source = ['Heading', '----', 'next line', '', '---', '', '# Two', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides[1]?.frontmatter).toBeUndefined()
  })

  it('still opens a block after a separator carrying trailing text', () => {
    // `--- x` has line[3] === " ", so Slidev does open a block here.
    const source = ['# One', '', '--- x', 'layout: cover', '---', '', 'body', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(deck.slides[1]?.frontmatter).toBeDefined()
  })

  it('closes a fence on any line starting with the same backtick run, info string or not', () => {
    // Slidev closes on `startsWith(level)`, so the inner ```ts closes the outer ```md.
    const source = ['```md', '```ts', 'a', '```', '```', '', '---', '', '# After', ''].join('\n')
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })

  it('resumes scanning after a fence that is never closed, and warns that it did', () => {
    const source = ['```yaml', 'kind: Pod', '', '---', '', '# After', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    // Whether a later `---` breaks a slide now depends on whether content further down
    // closes the fence, so slide identity becomes order-dependent. Slidev renders it, so
    // this is not fatal, but it must not be invisible.
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['unclosed-fence'])
    expect(deck.diagnostics[0]?.severity).toBe('warning')
  })

  it('tracks a fence at any indentation, not only up to three spaces', () => {
    const source = ['    ```yaml', 'kind: Pod', '---', '    ```', '', '---', '', '# A', ''].join(
      '\n',
    )
    expect(parseSlidevDeck(source).slides).toHaveLength(2)
  })

  it('invents no slide after a trailing separator with no newline behind it', () => {
    expect(parseSlidevDeck('# One\n\n---').slides).toHaveLength(1)
  })

  it('treats a separator that opens nothing as the slide content it is', () => {
    // A file that is only `---` renders as a slide whose content is `---`. Recording it
    // as an opening delimiter instead left `init-ids` inserting at the end of the file,
    // welding `---slideId: …` together and losing the id on every re-run.
    const deck = parseSlidevDeck('---')
    expect(deck.slides).toHaveLength(1)
    expect(deck.slides[0]?.separator).toBeUndefined()
    expect(deck.slides[0]?.frontmatter).toBeUndefined()
    expect(deck.slides[0]?.start).toBe(0)
    expect(deck.slides[0]?.bodyStart).toBe(0)
  })

  it('does not call a leading four-dash separator the deck headmatter', () => {
    // `----` opens no block, so there is no headmatter to speak of.
    const deck = parseSlidevDeck('----\nlayout: x\n---\n\nbody\n')
    expect(deck.slides[0]?.isHeadmatter).toBe(false)
  })

  it('keeps the empty slide a trailing separator plus newline does produce', () => {
    expect(parseSlidevDeck('# One\n\n---\n').slides).toHaveLength(2)
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

  it('splits on a longer dash run, as Slidev does, and warns that it did', () => {
    const source = ['---', 'layout: cover', '---', '', '# One', '', '----', '', '# Two', ''].join(
      '\n',
    )
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['ambiguous-separator'])
    expect(deck.diagnostics[0]?.severity).toBe('warning')
    expect(deck.diagnostics[0]?.line).toBe(7)
  })

  it('splits at a setext level-two underline, which is the trap the warning exists for', () => {
    const source = ['---', 'layout: cover', '---', '', 'Heading', '-------', '', 'body', ''].join(
      '\n',
    )
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['ambiguous-separator'])
  })

  it('splits at a separator carrying trailing text, as Slidev does', () => {
    const source = ['# One', '', '--- and some text', '', '# Two', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.slides).toHaveLength(2)
    expect(deck.diagnostics.map((d) => d.code)).toEqual(['ambiguous-separator'])
  })

  it('refuses a frontmatter block whose closing delimiter is not exactly three dashes', () => {
    // Slidev consumes three dashes and leaks the rest of the line into the slide body.
    const source = ['---', 'layout: cover', '----', '', '# One', ''].join('\n')
    const deck = parseSlidevDeck(source)
    expect(deck.diagnostics.map((d) => d.code)).toContain('malformed-frontmatter')
    expect(deck.diagnostics.find((d) => d.code === 'malformed-frontmatter')?.severity).toBe('error')
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
