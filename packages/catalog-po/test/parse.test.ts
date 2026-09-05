import { describe, expect, it } from 'vitest'
import { PoSyntaxError, parsePo, UnsupportedPoError } from '../src/index.js'

const FILE = 'i18n/de/slides.po'

function parse(text: string) {
  return parsePo(text, { fileName: FILE })
}

const HEADER = ['msgid ""', 'msgstr "Language: de\\n"', ''].join('\n')

describe('parsePo — structure', () => {
  it('reads the header as the first entry', () => {
    const file = parse(HEADER)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0]?.msgid).toBe('')
    expect(file.entries[0]?.msgstr).toEqual(['Language: de\n'])
  })

  it('reads msgctxt, msgid and msgstr', () => {
    const file = parse(
      `${HEADER}\nmsgctxt "slides:s01:body/1"\nmsgid "A Pod."\nmsgstr "Ein Pod."\n`,
    )
    expect(file.entries[1]).toMatchObject({
      msgctxt: 'slides:s01:body/1',
      msgid: 'A Pod.',
      msgstr: ['Ein Pod.'],
      obsolete: false,
    })
  })

  it('joins adjacent strings across continuation lines', () => {
    const file = parse(
      `${HEADER}\nmsgctxt "slides:s01:body/1"\nmsgid ""\n"first\\n"\n"second"\nmsgstr ""\n"eins\\n"\n"zwei"\n`,
    )
    expect(file.entries[1]?.msgid).toBe('first\nsecond')
    expect(file.entries[1]?.msgstr).toEqual(['eins\nzwei'])
  })

  it('joins adjacent strings written on one line', () => {
    const file = parse(`${HEADER}\nmsgid "a" "b"\nmsgstr "c" "d"\n`)
    expect(file.entries[1]?.msgid).toBe('ab')
    expect(file.entries[1]?.msgstr).toEqual(['cd'])
  })

  it('separates entries that are not separated by a blank line', () => {
    const file = parse(
      `${HEADER}\nmsgctxt "slides:a:x"\nmsgid "A"\nmsgstr ""\nmsgctxt "slides:b:x"\nmsgid "B"\nmsgstr ""\n`,
    )
    expect(file.entries.map((e) => e.msgctxt)).toEqual([undefined, 'slides:a:x', 'slides:b:x'])
  })

  it('records the line each entry starts on, for downstream diagnostics', () => {
    const file = parse(`${HEADER}\nmsgctxt "slides:a:x"\nmsgid "A"\nmsgstr ""\n`)
    expect(file.entries[1]?.line).toBe(4)
  })

  it('strips a UTF-8 BOM and tolerates CRLF line endings', () => {
    const file = parse('﻿msgid ""\r\nmsgstr "Language: de\\n"\r\n')
    expect(file.entries[0]?.msgstr).toEqual(['Language: de\n'])
  })
})

describe('parsePo — comments', () => {
  const text = [
    HEADER,
    '# a translator note',
    '#. workshop-i18n-source: sections/01.md',
    '#: legacy/reference.md:12',
    '#% an annotation class we do not model',
    '#, fuzzy, c-format',
    '#| msgctxt "slides:s01:body/0"',
    '#| msgid "Old source"',
    'msgctxt "slides:s01:body/1"',
    'msgid "New source"',
    'msgstr "Neue Quelle"',
    '',
  ].join('\n')

  it('keeps every comment class in order, including ones it does not interpret', () => {
    const entry = parse(text).entries[1]
    expect(entry?.comments).toEqual([
      { marker: '', text: ' a translator note' },
      { marker: '.', text: ' workshop-i18n-source: sections/01.md' },
      { marker: ':', text: ' legacy/reference.md:12' },
      { marker: '', text: '% an annotation class we do not model' },
    ])
  })

  it('reads flags in order, from any number of flag lines', () => {
    expect(parse(text).entries[1]?.flags).toEqual(['fuzzy', 'c-format'])
    const two = parse(`${HEADER}\n#, fuzzy\n#, c-format\nmsgid "a"\nmsgstr ""\n`)
    expect(two.entries[1]?.flags).toEqual(['fuzzy', 'c-format'])
  })

  it('reads previous-source, which gettext-parser drops entirely', () => {
    expect(parse(text).entries[1]?.previous).toEqual({
      msgctxt: 'slides:s01:body/0',
      msgid: 'Old source',
    })
  })

  it('joins previous-source continuation lines', () => {
    const file = parse(`${HEADER}\n#| msgid ""\n#| "one\\n"\n#| "two"\nmsgid "a"\nmsgstr ""\n`)
    expect(file.entries[1]?.previous?.msgid).toBe('one\ntwo')
  })
})

describe('parsePo — obsolete entries', () => {
  it('reads an obsolete entry rather than discarding it', () => {
    const file = parse(
      `${HEADER}\n#~ msgctxt "slides:gone:body/1"\n#~ msgid "Removed"\n#~ msgstr "Entfernt"\n`,
    )
    expect(file.entries[1]).toMatchObject({
      obsolete: true,
      msgctxt: 'slides:gone:body/1',
      msgid: 'Removed',
      msgstr: ['Entfernt'],
    })
  })

  it('reads obsolete continuation lines and obsolete previous-source', () => {
    const file = parse(
      `${HEADER}\n#~| msgid "Older"\n#~ msgid ""\n#~ "one\\n"\n#~ "two"\n#~ msgstr ""\n`,
    )
    expect(file.entries[1]?.msgid).toBe('one\ntwo')
    expect(file.entries[1]?.previous?.msgid).toBe('Older')
  })

  it('rejects an entry that mixes obsolete and live lines', () => {
    expect(() => parse(`${HEADER}\n#~ msgid "Removed"\nmsgstr "Entfernt"\n`)).toThrow(PoSyntaxError)
  })
})

describe('parsePo — plural forms', () => {
  it('parses and preserves plural entries', () => {
    const file = parse(
      `${HEADER}\nmsgid "one file"\nmsgid_plural "%d files"\nmsgstr[0] "eine Datei"\nmsgstr[1] "%d Dateien"\n`,
    )
    expect(file.entries[1]).toMatchObject({
      msgid: 'one file',
      msgidPlural: '%d files',
      msgstr: ['eine Datei', '%d Dateien'],
    })
  })

  it('rejects plural indices that arrive out of order or with a gap', () => {
    expect(() =>
      parse(`${HEADER}\nmsgid "a"\nmsgid_plural "b"\nmsgstr[0] "x"\nmsgstr[2] "y"\n`),
    ).toThrow(PoSyntaxError)
  })

  it('rejects a singular msgstr mixed with indexed ones', () => {
    expect(() =>
      parse(`${HEADER}\nmsgid "a"\nmsgid_plural "b"\nmsgstr "x"\nmsgstr[1] "y"\n`),
    ).toThrow(PoSyntaxError)
  })

  it('rejects indexed msgstr without msgid_plural — an unsupported construct, not a quiet drop', () => {
    expect(() => parse(`${HEADER}\nmsgid "a"\nmsgstr[0] "x"\n`)).toThrow(UnsupportedPoError)
  })
})

describe('parsePo — hard errors name the file and line', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['unterminated string', `${HEADER}\nmsgid "a\nmsgstr ""\n`],
    ['unknown keyword', `${HEADER}\nmsgidd "a"\nmsgstr ""\n`],
    ['continuation with no keyword', `${HEADER}\n"orphan"\nmsgstr ""\n`],
    ['duplicate msgid in one entry', `${HEADER}\nmsgid "a"\nmsgid "b"\nmsgstr ""\n`],
    ['msgstr before msgid', `${HEADER}\nmsgstr "a"\nmsgid "b"\n`],
    ['entry with no msgstr', `${HEADER}\nmsgid "a"\n`],
    ['entry with no msgid', `${HEADER}\nmsgctxt "slides:a:x"\nmsgstr "a"\n`],
    ['trailing garbage after a string', `${HEADER}\nmsgid "a" junk\nmsgstr ""\n`],
    ['comment after the entry body', `${HEADER}\nmsgid "a"\nmsgstr ""\n#, fuzzy\n`],
  ]

  for (const [name, text] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => parse(text)).toThrow(PoSyntaxError)
      expect(() => parse(text)).toThrow(new RegExp(`${FILE.replace(/[.\\/]/g, '\\$&')}:\\d+`))
    })
  }

  it('never returns a partial parse — the error is thrown, not collected', () => {
    let thrown: unknown
    try {
      parse(`${HEADER}\nmsgid "a\nmsgstr ""\n`)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PoSyntaxError)
    expect((thrown as PoSyntaxError).fileName).toBe(FILE)
    expect((thrown as PoSyntaxError).line).toBe(4)
  })

  it('rejects a file whose first entry is not the header', () => {
    expect(() => parse('msgctxt "slides:a:x"\nmsgid "a"\nmsgstr ""\n')).toThrow(PoSyntaxError)
  })

  it('accepts an entirely empty file as an empty catalog', () => {
    expect(parse('').entries).toEqual([])
    expect(parse('\n\n').entries).toEqual([])
  })
})
