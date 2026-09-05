import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslationUnit, parseUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import type { CatalogIdentity, ExtractedUnit, PoEntry } from '../src/index.js'
import {
  CatalogError,
  DuplicateCatalogEntryError,
  PoSyntaxError,
  parseCatalog,
  parsePo,
  serializeCatalog,
  serializePo,
  UnsupportedPoError,
  updateCatalog,
} from '../src/index.js'

/**
 * Golden catalogs (constitution III: losslessness is proven, not claimed).
 *
 * Two kinds live under `fixtures/catalogs`:
 *
 * - **Hand-written** files carrying constructs this tool did not produce — a TMS header,
 *   an unmodelled comment class, foreign flags, plural forms. They pin losslessness
 *   against input we do not control, which is the whole reason ADR 0013 rejects a
 *   dependency that drops what it does not model.
 * - **Generated** files pinning the four stages of the spec 002 User Story 1 scenario.
 *   Regenerate with `UPDATE_GOLDENS=1 pnpm test`; the diff *is* the review.
 *
 * A hand-written fixture can only evidence what we *believe* another tool writes, so the
 * third kind lives one directory down and is covered by `gnu-fixtures.test.ts`:
 * `fixtures/catalogs/gnu-generated/` is byte-for-byte GNU gettext output.
 */
const FIXTURES = fileURLToPath(new URL('../../../fixtures/catalogs/', import.meta.url))
const UPDATE = process.env.UPDATE_GOLDENS === '1'

function golden(name: string, actual: string): void {
  const path = join(FIXTURES, name)
  if (UPDATE) writeFileSync(path, actual)
  expect(readFileSync(path, 'utf8'), `fixture ${name}`).toBe(actual)
}

const IDENTITY: CatalogIdentity = { locale: 'de', name: '03-pods' }

function unit(id: string, source: string, reference = 'sections/03-pods.md'): ExtractedUnit {
  return { ...createTranslationUnit(parseUnitId(id), source), reference }
}

const BASE: readonly ExtractedUnit[] = [
  unit('slides:s01:body/1', 'A Pod is a group of containers.'),
  unit('slides:s01:body/2', 'Pods are **ephemeral**.\nRun `kubectl get pods`.'),
  unit('slides:s02:body/1', 'A Service gives Pods a stable address.'),
]

const TRANSLATIONS: ReadonlyMap<string, string> = new Map([
  ['slides:s01:body/1', 'Ein Pod ist eine Gruppe von Containern.'],
  ['slides:s01:body/2', 'Pods sind **kurzlebig**.\nFühre `kubectl get pods` aus.'],
  ['slides:s02:body/1', 'Ein Service gibt Pods eine stabile Adresse.'],
])

/**
 * Fill in translations the way a human reviewer would: by editing the file. There is no
 * API in this package that promotes a unit to `reviewed`, and that absence is deliberate
 * (constitution V) — so the fixture is built through the codec, not around the rule.
 */
function humanTranslate(text: string): string {
  const file = parsePo(text, { fileName: 'fixture.po' })
  const entries: PoEntry[] = file.entries.map((entry) => {
    const translation = entry.msgctxt === undefined ? undefined : TRANSLATIONS.get(entry.msgctxt)
    return translation === undefined ? entry : { ...entry, msgstr: [translation] }
  })
  return serializePo({ entries })
}

describe('golden scenario — spec 002 User Story 1', () => {
  const firstExtract = serializeCatalog(updateCatalog({ identity: IDENTITY, units: BASE }).catalog)
  const reviewed = humanTranslate(firstExtract)
  const reviewedCatalog = parseCatalog(reviewed, { identity: IDENTITY, fileName: 'de/03-pods.po' })

  const edited = [
    unit('slides:s01:body/1', 'A Pod is a group of one or more containers.'),
    ...BASE.slice(1),
  ]
  const afterEdit = updateCatalog({ identity: IDENTITY, units: edited, previous: reviewedCatalog })
  const afterDelete = updateCatalog({
    identity: IDENTITY,
    units: edited.slice(0, 2),
    previous: afterEdit.catalog,
  })

  it('01 — a first extract lists every unit as missing', () => {
    golden('01-first-extract.po', firstExtract)
  })

  it('02 — a reviewed catalog, as a human left it', () => {
    golden('02-reviewed.po', reviewed)
  })

  it('03 — an English edit marks one entry fuzzy with its previous source', () => {
    golden('03-after-english-edit.po', serializeCatalog(afterEdit.catalog))
    expect(afterEdit.summary.fuzzied).toEqual(['slides:s01:body/1'])
    expect(afterEdit.summary.unchanged).toEqual(['slides:s01:body/2', 'slides:s02:body/1'])
  })

  it('04 — a deleted unit becomes an obsolete entry, keeping its translation', () => {
    golden('04-after-deletion.po', serializeCatalog(afterDelete.catalog))
    expect(afterDelete.summary.obsoleted).toEqual(['slides:s02:body/1'])
    expect(afterDelete.catalog.obsolete[0]?.translation).toBe(
      'Ein Service gibt Pods eine stabile Adresse.',
    )
  })

  it('05 — hostile escaping survives a full extract cycle', () => {
    const hostile = [
      unit('slides:hostile:quotes/1', 'He said "hello" — loudly.', 'fixtures/hostile.md'),
      unit('slides:hostile:backslash/1', 'Windows path: C:\\srv\\data\\', 'fixtures/hostile.md'),
      unit(
        'slides:hostile:controls/1',
        'tab\there, nul\u0000here, del\u007fhere',
        'fixtures/hostile.md',
      ),
      unit('slides:hostile:newlines/1', 'one\ntwo\nthree\n', 'fixtures/hostile.md'),
      unit('slides:hostile:unicode/1', 'Grüße, 日本語, Ελληνικά, עברית, 🎉', 'fixtures/hostile.md'),
      unit(
        'slides:hostile:posyntax/1',
        'msgid "not really"\n#~ msgstr "nor this"',
        'fixtures/hostile.md',
      ),
      unit(
        'slides:hostile:long/1',
        `${'lorem ipsum dolor sit amet '.repeat(40)}end`,
        'fixtures/hostile.md',
      ),
      unit('slides:hostile:empty/1', '', 'fixtures/hostile.md'),
    ]
    const text = serializeCatalog(updateCatalog({ identity: IDENTITY, units: hostile }).catalog)
    golden('05-hostile-escaping.po', text)

    const back = parseCatalog(text, { identity: IDENTITY, fileName: 'de/hostile.po' })
    for (const source of hostile) {
      const entry = back.entries.find((e) => e.id.unitKey === source.id.unitKey)
      expect(entry?.source, source.id.unitKey).toBe(source.source)
    }
  })

  it('every stage re-serializes to itself — the canonical form is a fixed point', () => {
    for (const name of [
      '01-first-extract.po',
      '02-reviewed.po',
      '03-after-english-edit.po',
      '04-after-deletion.po',
      '05-hostile-escaping.po',
    ]) {
      const text = readFileSync(join(FIXTURES, name), 'utf8')
      expect(serializePo(parsePo(text, { fileName: name })), name).toBe(text)
    }
  })
})

describe('golden fixtures — input this tool did not write', () => {
  const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

  it('round-trips a heavily annotated catalog without losing an annotation', () => {
    const text = read('foreign-annotated.po')
    expect(serializePo(parsePo(text, { fileName: 'foreign-annotated.po' }))).toBe(text)
  })

  it('carries every foreign annotation through a no-change update (FR-001, FR-005)', () => {
    const text = read('foreign-annotated.po')
    const previous = parseCatalog(text, { identity: IDENTITY, fileName: 'foreign-annotated.po' })
    const units = [
      unit('slides:s01:body/1', 'A Pod is a group of containers.'),
      unit('slides:s02:body/1', 'A Service gives Pods a stable address.'),
    ]
    const updated = serializeCatalog(updateCatalog({ identity: IDENTITY, units, previous }).catalog)
    expect(updated).toBe(text)
  })

  it('reads the review states expressed through flags', () => {
    const catalog = parseCatalog(read('foreign-annotated.po'), {
      identity: IDENTITY,
      fileName: 'foreign-annotated.po',
    })
    expect(catalog.entries.map((entry) => entry.state)).toEqual(['reviewed', 'needs-review'])
  })

  /**
   * GNU wraps at a column; we wrap only at newlines (ADR 0013). Reading a GNU-wrapped
   * catalog must therefore recover the *unwrapped* value exactly, and writing it back
   * re-flows it onto one line. That re-flow is a real whole-file diff the first time a
   * catalog produced by GNU tools or a TMS is adopted, so it is pinned here rather than
   * discovered by a maintainer staring at a 400-line diff.
   */
  it('reads GNU column wrapping and re-flows it onto one line on write', () => {
    const text = read('gnu-wrapped.po')
    const catalog = parseCatalog(text, { identity: IDENTITY, fileName: 'gnu-wrapped.po' })

    expect(catalog.entries[0]?.source).toBe(
      'A Pod is the smallest deployable unit in Kubernetes, and it wraps one or more ' +
        'containers that share a network namespace and a set of storage volumes.',
    )
    expect(catalog.entries[0]?.source).not.toContain('\n')

    const written = serializeCatalog(catalog)
    expect(written).not.toBe(text)
    expect(written).toContain(
      'msgid "A Pod is the smallest deployable unit in Kubernetes, and it wraps one or ' +
        'more containers that share a network namespace and a set of storage volumes."',
    )
    // ...and the re-flow happens once: the second pass is a fixed point.
    expect(serializePo(parsePo(written, { fileName: 'gnu-wrapped.po' }))).toBe(written)
  })

  it('round-trips plural forms and obsolete entries it will not translate', () => {
    const text = read('plural-forms.po')
    expect(serializePo(parsePo(text, { fileName: 'plural-forms.po' }))).toBe(text)
    expect(() => parseCatalog(text, { identity: IDENTITY, fileName: 'plural-forms.po' })).toThrow(
      UnsupportedPoError,
    )
  })
})

describe('golden fixtures — catalogs that must be refused', () => {
  const read = (name: string) => readFileSync(join(FIXTURES, 'broken', name), 'utf8')

  it('refuses a hand-edited catalog with broken syntax, naming the line', () => {
    const name = 'unterminated-string.po'
    expect(() => parsePo(read(name), { fileName: name })).toThrow(PoSyntaxError)
    try {
      parsePo(read(name), { fileName: name })
    } catch (error) {
      expect((error as PoSyntaxError).line).toBe(5)
      expect((error as PoSyntaxError).message).toContain(`${name}:5`)
    }
  })

  it('refuses a duplicated unit id, naming both entries', () => {
    const name = 'duplicate-msgctxt.po'
    try {
      parseCatalog(read(name), { identity: IDENTITY, fileName: name })
      expect.unreachable('expected a duplicate id to be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateCatalogEntryError)
      expect((error as DuplicateCatalogEntryError).lines).toEqual([4, 8])
    }
  })

  it('refuses an identity that would escape its directory', () => {
    const name = 'unsafe-msgctxt.po'
    expect(() => parseCatalog(read(name), { identity: IDENTITY, fileName: name })).toThrow(
      CatalogError,
    )
  })
})
