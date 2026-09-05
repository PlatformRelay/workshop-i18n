import { describe, expect, it } from 'vitest'
import { parsePo, serializePo } from '../src/index.js'

const FILE = 'i18n/de/slides.po'
const parse = (text: string) => parsePo(text, { fileName: FILE })
const canonical = (text: string) => serializePo(parse(text))

const HEADER = 'msgid ""\nmsgstr "Language: de\\n"\n'

describe('serializePo — canonical spelling', () => {
  it('writes one entry per blank-line-separated block and ends with a newline', () => {
    const text = `${HEADER}\nmsgctxt "slides:a:x"\nmsgid "A"\nmsgstr "Ä"\n`
    expect(canonical(text)).toBe(
      'msgid ""\nmsgstr "Language: de\\n"\n\nmsgctxt "slides:a:x"\nmsgid "A"\nmsgstr "Ä"\n',
    )
  })

  it('emits comment classes in the order they were read, then flags, then previous-source', () => {
    const text = [
      HEADER,
      '#| msgid "Old"',
      '#, fuzzy',
      '#: ref.md:1',
      '#. extracted',
      '# translator',
      'msgctxt "slides:a:x"',
      'msgid "A"',
      'msgstr "B"',
      '',
    ].join('\n')
    expect(canonical(text)).toBe(
      [
        'msgid ""',
        'msgstr "Language: de\\n"',
        '',
        '#: ref.md:1',
        '#. extracted',
        '# translator',
        '#, fuzzy',
        '#| msgid "Old"',
        'msgctxt "slides:a:x"',
        'msgid "A"',
        'msgstr "B"',
        '',
      ].join('\n'),
    )
  })

  it('splits a multi-line string after each newline and never mid-line', () => {
    const long = 'x'.repeat(400)
    const text = `${HEADER}\nmsgctxt "slides:a:x"\nmsgid "one\\ntwo"\nmsgstr "${long}"\n`
    expect(canonical(text)).toBe(
      [
        'msgid ""',
        'msgstr "Language: de\\n"',
        '',
        'msgctxt "slides:a:x"',
        'msgid ""',
        '"one\\n"',
        '"two"',
        `msgstr "${long}"`,
        '',
      ].join('\n'),
    )
  })

  it('keeps a string that merely ends in a newline on one line, as gettext does', () => {
    const out = canonical(`${HEADER}\nmsgctxt "slides:a:x"\nmsgid "one\\n"\nmsgstr ""\n`)
    expect(out).toContain('msgid "one\\n"\n')
  })

  it('orders entries by msgctxt, with the header first and obsolete entries last', () => {
    const text = [
      HEADER,
      '#~ msgctxt "slides:z:gone"',
      '#~ msgid "Z"',
      '#~ msgstr ""',
      '',
      'msgctxt "slides:b:x"',
      'msgid "B"',
      'msgstr ""',
      '',
      'msgctxt "slides:a:x"',
      'msgid "A"',
      'msgstr ""',
      '',
    ].join('\n')
    const contexts = [...canonical(text).matchAll(/msgctxt "([^"]+)"/g)].map((m) => m[1])
    expect(contexts).toEqual(['slides:a:x', 'slides:b:x', 'slides:z:gone'])
    expect(canonical(text)).toContain('#~ msgctxt "slides:z:gone"')
  })

  it('writes obsolete previous-source with the #~| prefix', () => {
    const out = canonical(`${HEADER}\n#~| msgid "Older"\n#~ msgid "Z"\n#~ msgstr ""\n`)
    expect(out).toContain('#~| msgid "Older"')
  })

  it('writes plural entries back with indexed msgstr', () => {
    const out = canonical(
      `${HEADER}\nmsgid "one file"\nmsgid_plural "%d files"\nmsgstr[0] "eine"\nmsgstr[1] "viele"\n`,
    )
    expect(out).toContain('msgid_plural "%d files"')
    expect(out).toContain('msgstr[0] "eine"')
    expect(out).toContain('msgstr[1] "viele"')
  })

  it('carries no timestamp of its own — the zero-byte-diff property (FR-005)', () => {
    const out = canonical(`${HEADER}\nmsgctxt "slides:a:x"\nmsgid "A"\nmsgstr ""\n`)
    expect(out).not.toMatch(/POT-Creation-Date|PO-Revision-Date/)
    expect(out).toBe(canonical(`${HEADER}\nmsgctxt "slides:a:x"\nmsgid "A"\nmsgstr ""\n`))
  })
})

describe('serializePo — idempotence', () => {
  const messy = [
    '# header note',
    'msgid ""',
    'msgstr ""',
    '"Language: de\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '',
    '#, fuzzy',
    '#. hash: sha256:0123456789abcdef',
    'msgctxt "slides:b:x"',
    'msgid "B  with \\"quotes\\" and \\\\ backslash"',
    'msgstr ""',
    '',
    'msgctxt "slides:a:x"',
    'msgid ""',
    '"multi\\n"',
    '"line"',
    'msgstr "übersetzt\\t— mit Tab"',
    '',
    '#~ msgctxt "slides:gone:x"',
    '#~ msgid "Gone"',
    '#~ msgstr "Weg"',
    '',
  ].join('\n')

  it('reaches a fixed point after one pass', () => {
    const once = canonical(messy)
    expect(canonical(once)).toBe(once)
  })

  it('re-parses to exactly the model it was written from', () => {
    const once = parse(canonical(messy))
    expect(parse(canonical(serializePo(once)))).toEqual(once)
  })
})
