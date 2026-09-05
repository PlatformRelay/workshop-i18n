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
  ({ kind: 'markdown', continuationPrefix, context, cell: false }) as const

const tableCell = () =>
  ({ kind: 'markdown', continuationPrefix: '', context: 'body', cell: true }) as const

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

  it('rejects a lone surrogate, which UTF-8 encoding would replace on the way out', () => {
    // `decodeSource` refuses invalid UTF-8 coming in; a lone surrogate is the same loss on
    // the way out, silently substituted as U+FFFD when the composed file is written.
    for (const lone of ['eins \ud800 zwei', 'eins \udc00 zwei', 'eins \ud83d zwei']) {
      expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': lone })).toThrow(
        CompositionError,
      )
    }
  })

  it('accepts a well-formed surrogate pair', () => {
    expect(composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins 🧑‍🚀 zwei' })).toContain(
      'eins 🧑‍🚀 zwei',
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

  it('rejects a fence indented past what CommonMark allows, because Slidev has no limit', () => {
    // Slidev opens a fence on `line.trimStart().startsWith("```")` — any indentation at
    // all. A four-space-indented fence is code to CommonMark and a fence to the renderer,
    // which then skips from here to the next line starting with the same run and eats
    // whole slides on the way.
    for (const indent of ['    ', '\t', '        ']) {
      expect(() =>
        composeSkeleton(skeleton, {
          'slides:s1:body/p-1': `eins\n${indent}\u0060\u0060\u0060yaml`,
        }),
      ).toThrow(CompositionError)
    }
  })

  it('rejects a fence a container prefix would indent into one', () => {
    // The prefix is applied before the check, so a bare fence inside a nested list item
    // arrives at the renderer four spaces deep.
    const nested = createSkeleton('- a\n  - b\n', [
      hole('slides:s1:body/l-1/li-2/p-1', 8, 9, 'b', markdown('    ')),
    ])
    expect(() => composeSkeleton(nested, { 'slides:s1:body/l-1/li-2/p-1': 'x\n```' })).toThrow(
      CompositionError,
    )
  })

  it('rejects a tilde fence, which the markdown renderer opens even though the scanner does not', () => {
    expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins\n~~~yaml' })).toThrow(
      CompositionError,
    )
  })

  it('rejects every line Slidev reads as a separator, not only an exact one', () => {
    // Slidev's test is `rawLine.trimEnd().startsWith("---")`, and `trimEnd` removes every
    // Unicode space — including the no-break space a European TMS emits.
    for (const line of ['---', '--- x', '-----x', '---\u00a0', '---\u2003', '----']) {
      expect(() =>
        composeSkeleton(skeleton, { 'slides:s1:body/p-1': `eins\n${line}\nzwei` }),
      ).toThrow(CompositionError)
    }
  })

  it('rejects a fence that only the text before the hole indents into one', () => {
    // A paragraph inside a list item starts after two spaces of indentation, so the hole
    // does not begin at column 0 — but its line does, and Slidev opens a fence at any
    // indent. Judging the first line without the text in front of it applies the
    // separator's column-0 reasoning to a predicate that has no column-0 rule.
    const source = '- item\n\n  A second paragraph.\n'
    const indented = createSkeleton(source, [
      hole('slides:s1:body/l-1/li-1/p-2', 10, 29, 'A second paragraph.', markdown('  ')),
    ])
    expect(() =>
      composeSkeleton(indented, { 'slides:s1:body/l-1/li-1/p-2': '\u0060\u0060\u0060yaml' }),
    ).toThrow(CompositionError)
    expect(() => composeSkeleton(indented, { 'slides:s1:body/l-1/li-1/p-2': '~~~yaml' })).toThrow(
      CompositionError,
    )
  })

  it('rejects a comment delimiter synthesised across the edge of a hole', () => {
    // Nothing the translator wrote is a delimiter; the `>` already sat after the hole.
    const source = '<!--\nSpeaker: text> tail\n-->\n'
    const seam = createSkeleton(source, [
      hole('slides:s1:note/p-1', 5, 18, 'Speaker: text', markdown('', 'note')),
    ])
    expect(() => composeSkeleton(seam, { 'slides:s1:note/p-1': 'Sprecher: --' })).toThrow(
      CompositionError,
    )
  })

  it('rejects a translation that drops a comment delimiter the source had', () => {
    // The msgid spans the whole paragraph, inline comment included, so a translator can
    // simply not carry the `-->` across. Removing one is exactly as fatal as adding one:
    // the comment stays open and swallows every slide after it.
    const source = 'Intro <!-- aside --> continues.\n'
    const inline = createSkeleton(source, [
      hole('slides:s1:body/p-1', 0, 31, 'Intro <!-- aside --> continues.'),
    ])
    expect(() =>
      composeSkeleton(inline, { 'slides:s1:body/p-1': 'Einleitung <!-- Notiz fortgesetzt.' }),
    ).toThrow(CompositionError)
  })

  it('rejects a translation that drops the opener but keeps the terminator', () => {
    const source = 'Intro <!-- aside --> continues.\n'
    const inline = createSkeleton(source, [
      hole('slides:s1:body/p-1', 0, 31, 'Intro <!-- aside --> continues.'),
    ])
    expect(() =>
      composeSkeleton(inline, { 'slides:s1:body/p-1': 'Einleitung Notiz --> fortgesetzt.' }),
    ).toThrow(CompositionError)
  })

  it('allows a translation that carries every delimiter across unchanged', () => {
    const source = 'Intro <!-- aside --> continues.\n'
    const inline = createSkeleton(source, [
      hole('slides:s1:body/p-1', 0, 31, 'Intro <!-- aside --> continues.'),
    ])
    expect(
      composeSkeleton(inline, { 'slides:s1:body/p-1': 'Einleitung <!-- Notiz --> weiter.' }),
    ).toBe('Einleitung <!-- Notiz --> weiter.\n')
  })

  it('still allows a hole whose line already contains a comment delimiter', () => {
    // A one-line speaker note is wrapped in delimiters the translator did not add.
    const source = '<!-- Speaker: eine Zeile. -->\n'
    const inline = createSkeleton(source, [
      hole('slides:s1:note/p-1', 5, 25, 'Speaker: eine Zeile.', markdown('', 'note')),
    ])
    expect(composeSkeleton(inline, { 'slides:s1:note/p-1': 'Sprecher: kurz.' })).toBe(
      '<!-- Sprecher: kurz. -->\n',
    )
  })

  it('rejects a translation that turns its own line into an indented code block', () => {
    // A hole that begins a line at column 0 starts a block, so four spaces in front of the
    // translation makes CommonMark render the unit as code. The blast radius is the unit
    // rather than the deck, but it is still a silent change of what the audience reads.
    for (const indent of ['    ', '\t', '        ']) {
      expect(() =>
        composeSkeleton(skeleton, { 'slides:s1:body/p-1': `${indent}eingerückt` }),
      ).toThrow(CompositionError)
    }
  })

  it('rejects an indented block that opens after a blank line inside the translation', () => {
    // The guard read only the first line, so a unit that starts a fresh block partway
    // through slipped past: `\n    code` renders the paragraph away entirely, leaving a
    // code block where prose was.
    for (const text of ['\n    code', 'Erste Zeile\n\n    code', 'a\n\n\tcode']) {
      expect(() => composeSkeleton(skeleton, { 'slides:s1:body/p-1': text })).toThrow(
        CompositionError,
      )
    }
  })

  it('allows an indented line that continues a paragraph rather than opening a block', () => {
    // No blank line in front of it, so CommonMark reads it as a lazy continuation.
    expect(composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'Erste\n    zweite' })).toContain(
      'Erste\n    zweite',
    )
  })

  it('allows indentation on a hole that does not begin its line', () => {
    const inline = createSkeleton('# Heading\n', [
      hole('slides:s1:body/h1-1/title', 2, 9, 'Heading'),
    ])
    expect(composeSkeleton(inline, { 'slides:s1:body/h1-1/title': '    Titel' })).toBe(
      '#     Titel\n',
    )
  })

  it('rejects a bare pipe added inside a table cell, which adds a column', () => {
    const source = '| Verb | Effect |\n| --- | --- |\n'
    const table = createSkeleton(source, [
      { ...hole('slides:s1:body/t-1/r-1/c-1', 2, 6, 'Verb'), encoding: tableCell() },
    ])
    expect(() => composeSkeleton(table, { 'slides:s1:body/t-1/r-1/c-1': 'Verb | Zusatz' })).toThrow(
      CompositionError,
    )
    expect(composeSkeleton(table, { 'slides:s1:body/t-1/r-1/c-1': 'Verb \\| Zusatz' })).toContain(
      'Verb \\| Zusatz',
    )
  })

  it('allows a dash run that is not at the start of its line', () => {
    const inline = createSkeleton('# Heading\n', [
      hole('slides:s1:body/h1-1/title', 2, 9, 'Heading'),
    ])
    expect(composeSkeleton(inline, { 'slides:s1:body/h1-1/title': '--- x' })).toBe('# --- x\n')
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

  it('rejects a dash run in a frontmatter value, which truncates the block', () => {
    // Slidev's frontmatter regex is lazy and unanchored at the close: the *first* `---`
    // anywhere after the opener ends the block, so an em dash typed as `---` inside a
    // value makes the renderer show the rest of the frontmatter, `slideId:` included, as
    // slide prose.
    expect(() => composeSkeleton(skeleton, { 'slides:s1:fm/kicker': 'Erste --- Zweite' })).toThrow(
      CompositionError,
    )
  })

  it('emits a double-quoted scalar so hostile translations cannot restructure the YAML', () => {
    const composed = composeSkeleton(skeleton, {
      'slides:s1:fm/kicker': 'Warum: Pods?',
      'slides:s1:fm/heading': 'Zeile eins\nZeile zwei',
    })
    expect(composed).toBe('---\nkicker: "Warum: Pods?"\nheading: "Zeile eins\\nZeile zwei"\n---\n')
  })
})
