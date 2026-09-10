import { formatUnitId, parseUnitId } from '@workshop-i18n/core'
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
    // An astral letter (Deseret): a pair the budget treats as the letter it is.
    expect(composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins 𐐷 zwei' })).toContain(
      'eins 𐐷 zwei',
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
    // The English cell already carries an escaped pipe, so the character budget allows one
    // `|`: only the column guard can tell the bare pipe from the escaped one.
    const source = '| Verb \\| Noun | Effect |\n| --- | --- |\n'
    const table = createSkeleton(source, [
      { ...hole('slides:s1:body/t-1/r-1/c-1', 2, 14, 'Verb \\| Noun'), encoding: tableCell() },
    ])
    try {
      composeSkeleton(table, { 'slides:s1:body/t-1/r-1/c-1': 'Verb | Zusatz' })
      expect.unreachable('a bare pipe should have been refused')
    } catch (error) {
      expect((error as CompositionError).issues[0]?.reason).toBe('table-column')
    }
    expect(composeSkeleton(table, { 'slides:s1:body/t-1/r-1/c-1': 'Verbo \\| Nomen' })).toContain(
      'Verbo \\| Nomen',
    )
  })

  it('allows a dash run that is not at the start of its line', () => {
    const inline = createSkeleton('# Heading\n', [
      hole('slides:s1:body/h1-1/title', 2, 9, 'Heading'),
    ])
    expect(composeSkeleton(inline, { 'slides:s1:body/h1-1/title': '--- x' })).toBe('# --- x\n')
  })

  it('rejects a line Slidev would read as a slot marker', () => {
    // A translated `::right::` moves everything after it into another slot.
    for (const line of ['::right::', ':: notes ::', '::default::  ']) {
      try {
        composeSkeleton(skeleton, { 'slides:s1:body/p-1': `eins\n${line}\nzwei` })
        expect.unreachable(`${line} should have been refused`)
      } catch (error) {
        // Refused as slot syntax by name, or earlier as a line starting with `::`.
        expect((error as CompositionError).issues[0]?.reason).toMatch(
          /^(?:slot-marker|block-syntax)$/,
        )
      }
    }
  })

  it('judges block syntax inside a list item or a quote, past every container prefix', () => {
    // The English already breaks before a bullet, so the character budget lets the break
    // and the `-` through: only the line rules, reading past the container prefixes, see
    // what the item holds. Each of these built a live component, published `.env` or
    // crashed a real build.
    const english = 'one\n- two, three\n- four'
    const list = createSkeleton(`${english}\n`, [
      hole('slides:s1:body/p-1', 0, english.length, english),
    ])
    for (const [line, reason] of [
      ['- :: Toc', 'block-syntax'],
      ['- - :: Toc', 'block-syntax'],
      ['- [r]: ./.env?raw', 'block-syntax'],
      ['- <<< @/.env', 'block-syntax'],
      ['- $$', 'block-syntax'],
      ['- ::right::', 'block-syntax'],
      ['- ---', 'slide-separator'],
    ] as const) {
      try {
        composeSkeleton(list, { 'slides:s1:body/p-1': `um\n${line}\n- quatro` })
        expect.unreachable(`${line} should have been refused`)
      } catch (error) {
        expect((error as CompositionError).issues[0]?.reason, line).toBe(reason)
      }
    }
    const ordered = 'one\n1) two, three'
    const numbered = createSkeleton(`${ordered}\n`, [
      hole('slides:s1:body/p-1', 0, ordered.length, ordered),
    ])
    expect(() => composeSkeleton(numbered, { 'slides:s1:body/p-1': 'um\n1) :::Toc' })).toThrow(
      /block syntax/,
    )
    // The same item without block syntax in it is a translation.
    expect(composeSkeleton(list, { 'slides:s1:body/p-1': 'um\n- dois, três\n- quatro' })).toBe(
      'um\n- dois, três\n- quatro\n',
    )
  })

  it('rejects a Slidev snippet import or a KaTeX block line the English does not have', () => {
    // Both are Slidev block syntax that a real `slidev build` turned into live code: a
    // snippet line imports a file (`<<< @/.env`) and binds its `{…}` options, and a `$$`
    // line's `{…}` becomes a KaTexBlockWrapper `v-bind`.
    for (const text of [
      'eins\n<<< @/.env txt',
      'eins\n   <<< @/probe.json json {1}',
      'eins\n$$ x\ny\n$$',
      'eins\n  $$',
    ]) {
      try {
        composeSkeleton(skeleton, { 'slides:s1:body/p-1': text })
        expect.unreachable(`${JSON.stringify(text)} should have been refused`)
      } catch (error) {
        expect((error as CompositionError).issues[0]?.reason, text).toBe('block-syntax')
      }
    }
  })

  it('allows marker-shaped text that is not a line of its own', () => {
    expect(composeSkeleton(skeleton, { 'slides:s1:body/p-1': 'eins ::right:: zwei' })).toBe(
      'eins ::right:: zwei\n',
    )
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

describe('composeSkeleton keeps the markup a unit carries (ADR 0015)', () => {
  const source = 'Use <span class="kw-muted">this</span> with {{ $slidev.nav.currentPage }}.\n'
  const text = source.trimEnd()
  const skeleton = createSkeleton(source, [hole('slides:s1:body/p-1', 0, text.length, text)])
  const reasonOf = (translation: string): string | undefined => {
    try {
      composeSkeleton(skeleton, { 'slides:s1:body/p-1': translation })
      return undefined
    } catch (error) {
      return (error as CompositionError).issues[0]?.reason
    }
  }

  it('allows a translation that moves the markup to other words', () => {
    expect(
      reasonOf('Mit {{ $slidev.nav.currentPage }} nutze <span class="kw-muted">das</span>.'),
    ).toBeUndefined()
  })

  it('rejects a translation that edits, drops or adds a tag', () => {
    expect(reasonOf('Nutze <span class="kw-ok">das</span> {{ $slidev.nav.currentPage }}.')).toBe(
      'markup-changed',
    )
    expect(reasonOf('Nutze das {{ $slidev.nav.currentPage }}.')).toBe('markup-changed')
    expect(
      reasonOf(
        'Nutze <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }} <img src=x onerror=alert(1)>.',
      ),
    ).toBe('markup-changed')
  })

  it('rejects any "<" before a non-space character the English does not have', () => {
    // Coarse on purpose: whatever this package's scanner makes of it, a renderer might
    // read a tag, a closer or a bogus comment there (ADR 0015).
    const tail = ' <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }}.'
    for (const added of [
      '<x_y v-html="a">b</x_y>',
      '<svg:a onmouseover="x">b</svg:a>',
      '</ div>',
      '</1',
      '<?x>',
      '<!x>',
      '<3',
    ]) {
      expect(reasonOf(`Nutze ${added}${tail}`), added).toBe('markup-changed')
    }
    // A literal `<` the English does not have costs a fallback too, however it is spelled:
    // the character budget counts it after decoding.
    expect(reasonOf(`Nutze a < b${tail}`)).toBeDefined()
    expect(reasonOf(`Nutze &lt;b&gt;${tail}`)).toBeDefined()
  })

  it('compares the coarse tokens themselves, not only how many there are', () => {
    // Neither the precise scanner (`<4` is text to it) nor the landing count (one `<`
    // either way) sees this; only the coarse multiset does.
    const heart = createSkeleton('Heart <3 always.\n', [
      hole('slides:s1:body/p-1', 0, 16, 'Heart <3 always.'),
    ])
    expect(() => composeSkeleton(heart, { 'slides:s1:body/p-1': 'Herz <4 immer.' })).toThrow(
      /markup/,
    )
  })

  it('counts markup across the edge of the hole, where the skeleton continues it', () => {
    // The translation alone carries no markup and neither does the English, but the `<`
    // in front of the hole reads the hole's first character: `<AB` is a tag start, `< CD`
    // is text. Only the count over the landing line sees the change.
    const glued = createSkeleton('Tick <AB\n', [hole('slides:s1:body/p-1', 6, 8, 'AB')])
    expect(() => composeSkeleton(glued, { 'slides:s1:body/p-1': ' CD' })).toThrow(/markup/)
  })

  it('lets the precise scanner add a refusal the coarse reading cannot see', () => {
    // Coarsely `<a title="x>` ends at the quoted `>`, so an edit after it is invisible;
    // the Vue-grammar scanner reads the whole tag and sees the attribute change.
    const link = 'Use <a title="x>y">link</a> now.\n'
    const linked = createSkeleton(link, [
      hole('slides:s1:body/p-1', 0, link.length - 1, link.trimEnd()),
    ])
    expect(() =>
      composeSkeleton(linked, { 'slides:s1:body/p-1': 'Nutze <a title="x>z">Link</a> jetzt.' }),
    ).toThrow(/markup/)
  })

  it('counts markup across the edge of a prop hole, where only the raw landing count sees it', () => {
    const tag = '<X a="<AB" />\n'
    const prop = createSkeleton(tag, [
      hole('slides:s1:body/x.1/prop:a', 7, 9, 'AB', {
        kind: 'html-attribute',
        quote: '"',
        context: 'body',
      }),
    ])
    expect(() => composeSkeleton(prop, { 'slides:s1:body/x.1/prop:a': ' CD' })).toThrow(/markup/)
  })

  it('counts a live brace pair formed with a reference in the skeleton next to the hole', () => {
    // Raw bytes hold no `{{` before or after; decoded, `&#123;{AB` holds one and the
    // translation removes it. Only the decoded landing count sees that.
    const source = 'Tick &#123;{AB\n'
    const glued = createSkeleton(source, [hole('slides:s1:body/p-1', 11, 14, '{AB')])
    expect(() => composeSkeleton(glued, { 'slides:s1:body/p-1': 'CD' })).toThrow(/markup/)
  })

  it('refuses a character reference or escape that decodes to a live brace or dollar', () => {
    // markdown-it decodes these in prose before Vue sees the HTML, so `&#123;&#123;` becomes
    // a live `{{ }}` interpolation in the rendered slide (verified with markdown-exit).
    for (const hidden of [
      '&#123;&#123; alert(1) &#125;&#125;',
      '&lbrace;&lbrace;x&rbrace;&rbrace;',
      '&#x7b;&#x7B;x&#x7d;&#x7D;',
      '&lcub;&lcub;x&rcub;&rcub;',
      '\\{\\{ x \\}\\}',
      '&#123&#123 x &#125&#125',
      '&#0123;&#0123;x&#0125;&#0125;',
      '&dollar;x&dollar;',
      '&#36;x&#36;',
    ]) {
      expect(
        reasonOf(
          `Nutze ${hidden} <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }}.`,
        ),
        hidden,
      ).toMatch(/^(?:markup-changed|added-syntax)$/)
    }
  })

  it('refuses a brace or a dollar the English does not have, even alone', () => {
    // `{1}{onVnodeMounted: …}` after a `$$` line is a KaTeX block's v-bind; no `{{` needed.
    const tail = ' <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }}.'
    for (const added of ['{x}', 'a } b', '$x$', '\\$x']) {
      expect(reasonOf(`Nutze ${added}${tail}`), added).toBe('added-syntax')
    }
  })

  it('judges a multi-line tag against the English as written, not as re-indented', () => {
    const quoted = '> Use <span\n> class="x">this</span>.\n'
    const english = 'Use <span\nclass="x">this</span>.'
    const nested = createSkeleton(quoted, [
      hole('slides:s1:body/bq-1/p-1', 2, quoted.length - 1, english, markdown('> ')),
    ])
    expect(
      composeSkeleton(nested, { 'slides:s1:body/bq-1/p-1': 'Nutze <span\nclass="x">das</span>.' }),
    ).toBe('> Nutze <span\n> class="x">das</span>.\n')
  })

  it('rejects a translation that keeps every tag but no longer nests them', () => {
    // Same multiset, broken structure: Vue refuses to compile a closing tag before its
    // opener, which fails the whole deck's build rather than one slide.
    expect(reasonOf('Nutze </span>das<span class="kw-muted"> {{ $slidev.nav.currentPage }}.')).toBe(
      'markup-changed',
    )
  })

  it('rejects a translation that edits or adds an interpolation, which Vue would execute', () => {
    expect(reasonOf('Nutze <span class="kw-muted">das</span> {{ alert(1) }}.')).toBe(
      'markup-changed',
    )
    expect(
      reasonOf('Nutze <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }} {{ x }}.'),
    ).toBe('markup-changed')
  })

  it('rejects a tag the translation leaves unterminated, which would swallow the skeleton', () => {
    // A bare `<b` at the end is not a tag by itself — but it lands in front of skeleton
    // that may complete it, so it is refused like any `<` the English does not have.
    expect(
      reasonOf('Nutze <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }} <b'),
    ).toBe('markup-changed')
    expect(
      reasonOf('Nutze <span class="kw-muted">das</span> {{ $slidev.nav.currentPage }} <b class="x'),
    ).toBe('markup-changed')
  })
})

describe('composeSkeleton budgets every character a translation may add (ADR 0015)', () => {
  const md = (english: string) =>
    createSkeleton(`${english}\n`, [hole('slides:s1:body/p-1', 0, english.length, english)])
  const html = (english: string) =>
    createSkeleton(`${english}\n`, [
      hole('slides:s1:body/div.1/t:1', 0, english.length, english, {
        kind: 'html-text',
        continuationPrefix: '',
        context: 'body',
      }),
    ])
  const refused = (skeleton: ReturnType<typeof md>, translation: string): boolean => {
    const id = formatUnitId(skeleton.holes[0]?.id as Hole['id'])
    try {
      composeSkeleton(skeleton, { [id]: translation })
      return false
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionError)
      return true
    }
  }

  it('accepts prose that adds only letters, digits, spaces and prose punctuation', () => {
    const english = 'A Pod runs containers, and the kubelet restarts them.'
    for (const translation of [
      'Um Pod roda contêineres — e o kubelet os reinicia!',
      '¿Qué pasa? «Nada»: el kubelet (sí) reinicia… 100 %',
      'O “kubelet” reinicia‘os’ – sempre.',
    ]) {
      expect(refused(md(english), translation), translation).toBe(false)
    }
  })

  it('refuses any other character the English has fewer of', () => {
    const english = 'A Pod runs containers.'
    for (const added of [
      '*',
      '_',
      '`',
      '~',
      '#',
      '|',
      '@',
      '/',
      '\\',
      '&',
      '^',
      '=',
      '+',
      '[',
      ']',
      '\t',
      '\u2003',
      '\u200b',
      '\u200d',
      '\u202e',
    ]) {
      expect(refused(md(english), `Um Pod roda ${added} contêineres.`), JSON.stringify(added)).toBe(
        true,
      )
    }
  })

  it('lets non-ASCII punctuation and symbols through, which no grammar in the path uses', () => {
    expect(refused(md('A Pod runs containers.'), 'Um Pod → roda · contêineres ≤ 3 ✓ 🚀 €.')).toBe(
      false,
    )
  })

  it('refuses a link target the English does not have, though it is all letters and dots', () => {
    // linkify turns a bare host into a link; the character budget cannot see it.
    expect(refused(md('Read the docs.'), 'Leia evil.com agora.')).toBe(true)
    expect(refused(md('Read the docs.'), 'Leia www.example agora.')).toBe(true)
    expect(refused(md('Edit values.yaml first.'), 'Edite values.yaml primeiro.')).toBe(false)
  })

  it('lets a translation reuse the characters its English already has', () => {
    const english = 'Run **kubectl** / `k9s` — see #42.'
    expect(refused(md(english), 'Rode **kubectl** / `k9s` — veja #42.')).toBe(false)
  })

  it('refuses a markdown image, which the build imports as an asset', () => {
    // A real `slidev build` published `.env` for `![x](./.env?raw)` in prose.
    const english = 'A Pod runs containers and the kubelet restarts them.'
    expect(
      refused(md(english), 'Um Pod roda contêineres ![x](./.env?raw) e o kubelet os reinicia.'),
    ).toBe(true)
    // A link turned into an image needs only a `!`, which is free prose punctuation.
    const link = 'See [the file](./probe.json) for details.'
    expect(refused(md(link), 'Veja ![o arquivo](./probe.json) para detalhes.')).toBe(true)
    // The reference form, with a definition line added below.
    const reference = 'See [the docs][r] now.\n\n[r]: https://example.com'
    expect(refused(md(reference), 'Veja ![a doc][r] agora.\n\n[r]: https://example.com')).toBe(true)
  })

  it('refuses a reference definition line the English does not have', () => {
    const english = 'See [the docs](https://example.com) now [x].'
    expect(refused(md(english), 'Veja [x] agora.\n[x]: https://example.com')).toBe(true)
  })

  it('refuses a run of three backticks or tildes anywhere, not only at the start of a line', () => {
    // After a list bullet or a quote marker the run opens a fence Slidev turns into a
    // PlantUml, Mermaid or twoslash block.
    const item = createSkeleton('- one item\n', [
      hole('slides:s1:body/l-1/li-1/p-1', 2, 10, 'one item', markdown('  ')),
    ])
    for (const fence of ['```plantuml', '~~~ts twoslash', 'eins ``` zwei']) {
      expect(() => composeSkeleton(item, { 'slides:s1:body/l-1/li-1/p-1': fence }), fence).toThrow(
        CompositionError,
      )
    }
    // Even when the English has enough backticks for it, in two inline code spans.
    expect(refused(md('Use `a` and `b` here.'), 'Use ```a`` and `b here.')).toBe(true)
  })

  it('refuses markup moved out of an inline code span, where it would come alive', () => {
    expect(
      refused(md('Run `<img src=x onerror=y>` now.'), 'Rode <img src=x onerror=y> agora.'),
    ).toBe(true)
    expect(
      refused(
        md("Try `kubectl get pods -o jsonpath='{.items[*]}'` next."),
        'Tente **kubectl**{onclick="alert(1)"} `get pods -o jsonpath=\'.items[*]\'` depois.',
      ),
    ).toBe(true)
  })

  it('refuses an MDC component or block shape the English does not have', () => {
    const english = 'Pods run: containers, always.'
    expect(refused(md(english), 'Pods rodam :Button contêineres.')).toBe(true)
    expect(refused(md(english), 'Pods rodam\n::alert\ncontêineres.')).toBe(true)
  })

  it('refuses any line starting with a colon, which the MDC block grammar trims and reads', () => {
    // `@comark/markdown-it` accepts two or more colons and trims before the name, so all of
    // these build a live component, and `:1 …` crashes the whole build.
    const english = 'Pods run containers, always.'
    for (const line of [':: Toc', ':::Toc', '::::Toc', '  :: Toc', ':1 x']) {
      expect(refused(md(english), `Pods rodam\n${line}\ncontêineres.`), line).toBe(true)
    }
  })

  it('refuses an inline MDC name in the renderer name class, digits and $ included', () => {
    const english = 'Pods run containers, always.'
    for (const name of [':1', ':$x', ':x-y', ':_z']) {
      expect(refused(md(english), `Pods rodam ${name} contêineres.`), name).toBe(true)
    }
    expect(refused(md(english), 'Pods rodam: contêineres, sempre.')).toBe(false)
  })

  it('lets a line break through only where the next line cannot start a block', () => {
    // Measured on the real pt-BR drafts: re-wrapped prose puts `(`, a code span, bold or a
    // number at the start of a line all the time, and none of those can start a block.
    for (const line of [
      'contêineres, sempre.',
      '  contêineres, sempre.',
      '(contêineres), sempre.',
      '**contêineres** sempre.',
      '*sempre* contêineres.',
      '2. contêineres',
      '2023 contêineres',
      '→ contêineres',
      '#hashtag contêineres',
    ]) {
      expect(refused(md(`Pods rodam ${line}`), `Pods rodam\n${line}`), line).toBe(false)
    }
    expect(refused(md('Pods run `kubectl` always.'), 'Pods rodam\n`kubectl` sempre.')).toBe(false)
    // A list item, an ordered list at 1, a heading, a quote, a setext underline, a table
    // row or an HTML block start is a line a block rule reads.
    for (const line of [
      '- contêineres',
      '* contêineres',
      '+ x',
      '1. contêineres',
      '1) x',
      '# Título',
      '> citação',
      '===',
      '| a | b |',
      '<div>',
    ]) {
      expect(refused(md(`Pods rodam ${line}`), `Pods rodam\n${line}`), line).toBe(true)
    }
  })

  it('lets every line break through inside a raw HTML block, where no block rule runs', () => {
    const english = 'Pods run containers, always.'
    expect(refused(html(english), 'Pods rodam\n- contêineres, sempre.')).toBe(false)
  })

  it('refuses an added v-drag, which Slidev rewrites wherever it first appears', () => {
    expect(refused(md('Drag the box to move it.'), 'Arraste v-drag a caixa.')).toBe(true)
  })

  it('decodes references before budgeting, in prose and in HTML text alike', () => {
    // Undecoded, `&#42;` spends only `&` and `#`, which the English has plenty of; decoded
    // it is a `*` — emphasis — which the English does not have.
    const english = 'A & B & C & D & E #### x'
    expect(refused(md(english), '&#42;&#42;x&#42;&#42;')).toBe(true)
    expect(refused(html(english), '&#42;&#42;x&#42;&#42;')).toBe(true)
  })

  it('decodes a live brace pair in HTML text before counting markup, over-approximating', () => {
    // Inert to Vue inside a raw HTML block (it decodes references after finding `{{`), but
    // ADR 0015 counts it anyway: the English's braces cover the budget, so only the decoded
    // markup count sees the new pair.
    expect(refused(html('{{x}} { { } }'), '{{x}} &#123;&#123;y&#125;&#125;')).toBe(true)
  })

  it('decodes references in HTML text before budgeting, as it does in prose', () => {
    // Undecoded, this translation spends only `&` and `#`, which the English has plenty
    // of; decoded, it adds two braces.
    const english = 'A & B & C & D ## ##'
    expect(refused(html(english), 'A &#123;&#123;x&#125;&#125;')).toBe(true)
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
