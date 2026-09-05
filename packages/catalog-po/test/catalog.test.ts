import { formatUnitId, parseUnitId, sourceHash } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import {
  CatalogError,
  type CatalogIdentity,
  DuplicateCatalogEntryError,
  parseCatalog,
  readCatalog,
  serializeCatalog,
  UnsupportedPoError,
} from '../src/index.js'

const IDENTITY: CatalogIdentity = { locale: 'de', name: '03-pods' }
const FILE = 'i18n/de/03-pods.po'

const read = (text: string) => parseCatalog(text, { identity: IDENTITY, fileName: FILE })

const HEADER = ['msgid ""', 'msgstr ""', '"Language: de\\n"', ''].join('\n')

function entryText(id: string, source: string, translation = ''): string {
  return [
    `#. workshop-i18n-source: sections/03-pods.md`,
    `#. workshop-i18n-hash: ${sourceHash(source)}`,
    `msgctxt "${id}"`,
    `msgid "${source}"`,
    `msgstr "${translation}"`,
    '',
  ].join('\n')
}

describe('parseCatalog — the typed view', () => {
  it('reads ids, source, translation, state and provenance', () => {
    const catalog = read(`${HEADER}\n${entryText('slides:s01:body/1', 'A Pod.', 'Ein Pod.')}`)
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({
      id: parseUnitId('slides:s01:body/1'),
      source: 'A Pod.',
      translation: 'Ein Pod.',
      state: 'reviewed',
      obsolete: false,
      recordedHash: sourceHash('A Pod.'),
      reference: 'sections/03-pods.md',
    })
  })

  it('sorts entries by compareUnitIds regardless of the order in the file', () => {
    const text = [
      HEADER,
      entryText('slides:s02:body/1', 'B'),
      entryText('slides:s01:body/2', 'A'),
      entryText('slides:s01:body/10', 'C'),
    ].join('\n')
    expect(read(text).entries.map((e) => e.id.unitKey)).toEqual(['body/10', 'body/2', 'body/1'])
  })

  it('separates obsolete entries so translation work stays visible but uncounted', () => {
    const text = [
      HEADER,
      entryText('slides:s01:body/1', 'A', 'Ä'),
      '#~ msgctxt "slides:gone:body/1"',
      '#~ msgid "Gone"',
      '#~ msgstr "Weg"',
      '',
    ].join('\n')
    const catalog = read(text)
    expect(catalog.entries.map((e) => e.id.containerId)).toEqual(['s01'])
    expect(catalog.obsolete.map((e) => e.id.containerId)).toEqual(['gone'])
    expect(catalog.obsolete[0]?.translation).toBe('Weg')
  })

  it('reads an empty file as an empty catalog with a canonical header', () => {
    const catalog = read('')
    expect(catalog.entries).toEqual([])
    expect(serializeCatalog(catalog)).toContain('"Language: de\\n"')
  })
})

describe('entry ordering', () => {
  /**
   * `serialize.ts` sorts entries by `msgctxt` in code-unit order; `catalog.ts` sorts the
   * same set with core's `compareUnitIds`. FR-005's zero-byte diff depends on the two
   * never disagreeing, and a `localeCompare` on either side would break it silently on a
   * machine with a different locale, so the agreement is pinned rather than assumed.
   */
  it('agrees with the order serializePo writes, for ids that stress the comparison', () => {
    const ids = [
      'slides:s01:body/1',
      'slides:s01:body/10',
      'slides:s01:body/2',
      'slides:s01:note:speaker/1',
      'slides:s1:body/1',
      'slides:S01:body/1',
      'labs:lab-01:step/1',
      'quiz:q-001:stem/1',
      'slides:a.b_c-d:body/1',
    ]
    const text = [HEADER, ...ids.map((id) => entryText(id, `source for ${id}`))].join('\n')
    const viaCompareUnitIds = read(text).entries.map((entry) => formatUnitId(entry.id))
    const viaSerializer = [...serializeCatalog(read(text)).matchAll(/msgctxt "([^"]+)"/g)].map(
      (match) => match[1],
    )
    expect(viaSerializer).toEqual(viaCompareUnitIds)
    expect(viaCompareUnitIds).toEqual([...ids].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1)))
  })
})

describe('parseCatalog — untrusted input', () => {
  it('rejects a non-header entry with no msgctxt: msgctxt is the identity (FR-002)', () => {
    expect(() => read(`${HEADER}\nmsgid "orphan"\nmsgstr ""\n`)).toThrow(CatalogError)
    expect(() => read(`${HEADER}\nmsgid "orphan"\nmsgstr ""\n`)).toThrow(
      /i18n\/de\/03-pods\.po:\d+/,
    )
  })

  it('validates ids read back out of the file with the safety gate, not just the shape', () => {
    const traversal = `${HEADER}\nmsgctxt "slides:../../etc/passwd:body/1"\nmsgid "x"\nmsgstr ""\n`
    expect(() => read(traversal)).toThrow(CatalogError)
    expect(() => read(traversal)).toThrow(/containerId/)
  })

  it('rejects an unknown surface rather than inventing one', () => {
    expect(() => read(`${HEADER}\nmsgctxt "posters:s01:body/1"\nmsgid "x"\nmsgstr ""\n`)).toThrow(
      CatalogError,
    )
  })

  it('names both entries when a bad manual edit duplicates a msgctxt', () => {
    const text = [
      HEADER,
      entryText('slides:s01:body/1', 'A'),
      entryText('slides:s01:body/1', 'B'),
    ].join('\n')
    expect(() => read(text)).toThrow(DuplicateCatalogEntryError)
    try {
      read(text)
    } catch (error) {
      const duplicate = error as DuplicateCatalogEntryError
      expect(duplicate.unitId).toBe('slides:s01:body/1')
      expect(duplicate.lines).toHaveLength(2)
      expect(duplicate.message).toContain(String(duplicate.lines[0]))
      expect(duplicate.message).toContain(String(duplicate.lines[1]))
    }
  })

  it('catches a duplicate that hides behind an obsolete entry', () => {
    const text = [
      HEADER,
      entryText('slides:s01:body/1', 'A'),
      '#~ msgctxt "slides:s01:body/1"',
      '#~ msgid "A"',
      '#~ msgstr ""',
      '',
    ].join('\n')
    expect(() => read(text)).toThrow(DuplicateCatalogEntryError)
  })

  it('ignores a source hash that is not shaped like one instead of comparing blindly', () => {
    const text = [
      HEADER,
      '#. workshop-i18n-hash: not-a-hash',
      'msgctxt "slides:s01:body/1"',
      'msgid "A"',
      'msgstr "Ä"',
      '',
    ].join('\n')
    expect(read(text).entries[0]?.recordedHash).toBeUndefined()
  })

  it('refuses a headerless catalog rather than inventing a header for it', () => {
    // Both entry points into this layer agree: an empty file is a catalog that does not
    // exist yet, a file with entries and no header is a broken one.
    const headerless = {
      entries: [
        {
          comments: [],
          flags: [],
          msgctxt: 'slides:s01:body/1',
          msgid: 'A',
          msgstr: [''],
          obsolete: false,
          line: 3,
        },
      ],
    }
    expect(() => readCatalog(headerless, { identity: IDENTITY, fileName: FILE })).toThrow(
      /entries but no header entry/,
    )
    expect(readCatalog({ entries: [] }, { identity: IDENTITY, fileName: FILE }).entries).toEqual([])
  })

  it('refuses a second header entry rather than dropping its fields', () => {
    const two = `${HEADER}\nmsgid ""\nmsgstr "Language: fr\\n"\n`
    expect(() => read(two)).toThrow(CatalogError)
    expect(() => read(two)).toThrow(/two header entries/)
  })

  it('refuses a catalog that declares a charset other than UTF-8', () => {
    const latin = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=ISO-8859-1\\n"\n'
    expect(() => read(latin)).toThrow(CatalogError)
  })

  it('refuses a plural entry carrying a unit id — parsed and preserved, never synthesized', () => {
    const text = [
      HEADER,
      'msgctxt "slides:s01:body/1"',
      'msgid "one Pod"',
      'msgid_plural "%d Pods"',
      'msgstr[0] "ein Pod"',
      'msgstr[1] "%d Pods"',
      '',
    ].join('\n')
    expect(() => read(text)).toThrow(UnsupportedPoError)
  })
})

describe('serializeCatalog', () => {
  it('round-trips a catalog to the same bytes it was read from', () => {
    const text = [HEADER, entryText('slides:s01:body/1', 'A', 'Ä')].join('\n')
    const once = serializeCatalog(read(text))
    expect(serializeCatalog(read(once))).toBe(once)
  })

  it('writes no volatile header field of its own', () => {
    expect(serializeCatalog(read(''))).not.toMatch(/POT-Creation-Date|PO-Revision-Date/)
  })
})
