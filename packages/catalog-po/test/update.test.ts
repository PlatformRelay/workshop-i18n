import {
  createTranslationUnit,
  formatUnitId,
  parseUnitId,
  type UnitState,
} from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import type { Catalog, CatalogIdentity, ExtractedUnit } from '../src/index.js'
import {
  applyDraftTranslation,
  catalogStatuses,
  isDraftable,
  parseCatalog,
  serializeCatalog,
  updateCatalog,
} from '../src/index.js'

const IDENTITY: CatalogIdentity = { locale: 'de', name: '03-pods' }
const FILE = 'i18n/de/03-pods.po'

function unit(id: string, source: string, reference = 'sections/03-pods.md'): ExtractedUnit {
  return { ...createTranslationUnit(parseUnitId(id), source), reference }
}

const BASE: readonly ExtractedUnit[] = [
  unit('slides:s01:body/1', 'A Pod is a group of containers.'),
  unit('slides:s01:body/2', 'Pods are ephemeral.'),
  unit('slides:s02:body/1', 'A Service gives Pods a stable address.'),
]

/** Round-trip through bytes, the way `extract` actually runs twice. */
function reread(catalog: Catalog): Catalog {
  return parseCatalog(serializeCatalog(catalog), { identity: IDENTITY, fileName: FILE })
}

function statesOf(catalog: Catalog): Record<string, UnitState> {
  return Object.fromEntries(catalog.entries.map((e) => [formatUnitId(e.id), e.state]))
}

/** A catalog where every unit is human-accepted, i.e. the state an English edit invalidates. */
function reviewedCatalog(): Catalog {
  const fresh = updateCatalog({ identity: IDENTITY, units: BASE }).catalog
  const text = serializeCatalog(fresh).replace(
    /(msgid "[^"]+"\n)msgstr ""/g,
    '$1msgstr "übersetzt"',
  )
  const translated = parseCatalog(text, { identity: IDENTITY, fileName: FILE })
  expect(new Set(Object.values(statesOf(translated)))).toEqual(new Set(['reviewed']))
  return translated
}

describe('updateCatalog — a catalog that does not exist yet', () => {
  const result = updateCatalog({ identity: IDENTITY, units: BASE })

  it('creates every unit as missing', () => {
    expect(statesOf(result.catalog)).toEqual({
      'slides:s01:body/1': 'missing',
      'slides:s01:body/2': 'missing',
      'slides:s02:body/1': 'missing',
    })
    expect(result.summary.added).toEqual([
      'slides:s01:body/1',
      'slides:s01:body/2',
      'slides:s02:body/1',
    ])
  })

  it('puts the unit id in msgctxt and the reference and hash in extracted comments (FR-002)', () => {
    const text = serializeCatalog(result.catalog)
    expect(text).toContain('msgctxt "slides:s01:body/1"')
    expect(text).toContain('#. workshop-i18n-source: sections/03-pods.md')
    expect(text).toContain(`#. workshop-i18n-hash: ${BASE[0]?.sourceHash ?? ''}`)
  })

  it('writes a header naming the locale and no timestamp', () => {
    const text = serializeCatalog(result.catalog)
    expect(text).toContain('"Language: de\\n"')
    expect(text).toContain('"Content-Type: text/plain; charset=UTF-8\\n"')
    expect(text).not.toMatch(/POT-Creation-Date|PO-Revision-Date/)
  })
})

describe('updateCatalog — no English change (FR-005, SC-002)', () => {
  it('produces byte-identical output on a re-run', () => {
    const first = serializeCatalog(updateCatalog({ identity: IDENTITY, units: BASE }).catalog)
    const previous = parseCatalog(first, { identity: IDENTITY, fileName: FILE })
    const second = serializeCatalog(
      updateCatalog({ identity: IDENTITY, units: BASE, previous }).catalog,
    )
    expect(second).toBe(first)
  })

  it('is a zero-byte diff even with translations, flags and translator comments present', () => {
    const text = [
      'msgid ""',
      'msgstr ""',
      '"Language: de\\n"',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '"X-Weblate-Project: workshop\\n"',
      '',
      '# a translator note the TMS wrote',
      '#. workshop-i18n-source: sections/03-pods.md',
      `#. workshop-i18n-hash: ${BASE[0]?.sourceHash ?? ''}`,
      '#: legacy/ref.md:4',
      '#, c-format',
      'msgctxt "slides:s01:body/1"',
      'msgid "A Pod is a group of containers."',
      'msgstr "Ein Pod ist eine Gruppe von Containern."',
      '',
      '#. workshop-i18n-source: sections/03-pods.md',
      `#. workshop-i18n-hash: ${BASE[1]?.sourceHash ?? ''}`,
      'msgctxt "slides:s01:body/2"',
      'msgid "Pods are ephemeral."',
      'msgstr ""',
      '',
      '#. workshop-i18n-source: sections/03-pods.md',
      `#. workshop-i18n-hash: ${BASE[2]?.sourceHash ?? ''}`,
      'msgctxt "slides:s02:body/1"',
      'msgid "A Service gives Pods a stable address."',
      'msgstr ""',
      '',
    ].join('\n')
    const previous = parseCatalog(text, { identity: IDENTITY, fileName: FILE })
    const canonical = serializeCatalog(previous)
    const updated = serializeCatalog(
      updateCatalog({ identity: IDENTITY, units: BASE, previous }).catalog,
    )
    expect(updated).toBe(canonical)
    expect(updated).toContain('# a translator note the TMS wrote')
    expect(updated).toContain('#: legacy/ref.md:4')
    expect(updated).toContain('#, c-format')
    expect(updated).toContain('"X-Weblate-Project: workshop\\n"')
  })
})

describe('updateCatalog — an English edit (FR-003, SC-001)', () => {
  const previous = reviewedCatalog()
  const edited = BASE.map((u, index) =>
    index === 0 ? unit('slides:s01:body/1', 'A Pod is a group of one or more containers.') : u,
  )
  const result = updateCatalog({ identity: IDENTITY, units: edited, previous })
  const text = serializeCatalog(result.catalog)

  it('invalidates exactly the affected approval and nothing else', () => {
    expect(statesOf(result.catalog)).toEqual({
      'slides:s01:body/1': 'fuzzy',
      'slides:s01:body/2': 'reviewed',
      'slides:s02:body/1': 'reviewed',
    })
    expect(result.summary.fuzzied).toEqual(['slides:s01:body/1'])
    expect(result.summary.unchanged).toEqual(['slides:s01:body/2', 'slides:s02:body/1'])
  })

  it('records the previous source so the translator can see what moved', () => {
    expect(text).toContain('#| msgid "A Pod is a group of containers."')
    expect(text).toContain('msgid "A Pod is a group of one or more containers."')
  })

  it('keeps the translation rather than discarding it', () => {
    expect(result.catalog.entries[0]?.translation).toBe('übersetzt')
  })

  it('refreshes the recorded hash, so the next run is a no-op', () => {
    const second = updateCatalog({
      identity: IDENTITY,
      units: edited,
      previous: reread(result.catalog),
    })
    expect(second.summary.fuzzied).toEqual([])
    expect(serializeCatalog(second.catalog)).toBe(text)
  })

  it('marks a unit fuzzy when the recorded hash disagrees with the msgid in the file', () => {
    const tampered = serializeCatalog(previous).replace(
      'msgid "Pods are ephemeral."',
      'msgid "Pods are ephemeral!"',
    )
    const hand = parseCatalog(tampered, { identity: IDENTITY, fileName: FILE })
    const units = BASE.map((u, index) =>
      index === 1 ? unit('slides:s01:body/2', 'Pods are ephemeral!') : u,
    )
    const after = updateCatalog({ identity: IDENTITY, units, previous: hand })
    expect(after.summary.fuzzied).toEqual(['slides:s01:body/2'])
  })
})

describe('updateCatalog — a deleted unit (FR-004)', () => {
  const previous = reviewedCatalog()
  const result = updateCatalog({ identity: IDENTITY, units: BASE.slice(0, 2), previous })

  it('turns it into an obsolete entry instead of deleting it', () => {
    expect(result.catalog.entries.map((e) => formatUnitId(e.id))).toEqual([
      'slides:s01:body/1',
      'slides:s01:body/2',
    ])
    expect(result.catalog.obsolete.map((e) => formatUnitId(e.id))).toEqual(['slides:s02:body/1'])
    expect(result.summary.obsoleted).toEqual(['slides:s02:body/1'])
  })

  it('preserves the translation work in the obsolete entry', () => {
    expect(result.catalog.obsolete[0]?.translation).toBe('übersetzt')
    expect(serializeCatalog(result.catalog)).toContain('#~ msgctxt "slides:s02:body/1"')
  })

  it('does not change the state of any surviving unit', () => {
    expect(statesOf(result.catalog)).toEqual({
      'slides:s01:body/1': 'reviewed',
      'slides:s01:body/2': 'reviewed',
    })
  })

  it('brings the entry back with its work when the English returns unchanged', () => {
    const back = updateCatalog({
      identity: IDENTITY,
      units: BASE,
      previous: reread(result.catalog),
    })
    expect(back.summary.resurrected).toEqual(['slides:s02:body/1'])
    expect(back.catalog.obsolete).toEqual([])
    expect(back.catalog.entries[2]?.translation).toBe('übersetzt')
    // The recorded hash proves the English is byte-identical to what was approved, so
    // there is nothing to revalidate. gettext's msgmerge revives fuzzy because it matches
    // on string similarity; we match on identity, which is stronger evidence.
    expect(back.catalog.entries[2]?.state).toBe('reviewed')
  })

  it('brings a resurrected entry back fuzzy when the English moved while it was gone', () => {
    const units = [
      ...BASE.slice(0, 2),
      unit('slides:s02:body/1', 'A Service gives Pods one stable address.'),
    ]
    const back = updateCatalog({ identity: IDENTITY, units, previous: reread(result.catalog) })
    expect(back.summary.resurrected).toEqual(['slides:s02:body/1'])
    expect(back.catalog.entries[2]?.state).toBe('fuzzy')
    expect(serializeCatalog(back.catalog)).toContain(
      '#| msgid "A Service gives Pods a stable address."',
    )
  })

  it('keeps obsoleting idempotent — a second run does not churn the file', () => {
    const once = serializeCatalog(result.catalog)
    const twice = serializeCatalog(
      updateCatalog({
        identity: IDENTITY,
        units: BASE.slice(0, 2),
        previous: reread(result.catalog),
      }).catalog,
    )
    expect(twice).toBe(once)
  })
})

describe('updateCatalog — new units alongside existing ones', () => {
  it('adds the new unit as missing and leaves the rest alone', () => {
    const previous = reviewedCatalog()
    const units = [...BASE, unit('slides:s02:body/2', 'Services are cheap.')]
    const result = updateCatalog({ identity: IDENTITY, units, previous })
    expect(result.summary.added).toEqual(['slides:s02:body/2'])
    expect(statesOf(result.catalog)['slides:s02:body/2']).toBe('missing')
    expect(result.summary.fuzzied).toEqual([])
  })
})

describe('drafted translations (FR-007, constitution V)', () => {
  it('enters a draft as needs-review, distinguishable from a human-accepted entry', () => {
    const fresh = updateCatalog({ identity: IDENTITY, units: BASE }).catalog
    const drafted = applyDraftTranslation(
      fresh,
      parseUnitId('slides:s01:body/1'),
      'Maschinelle Fassung.',
    )
    const entry = drafted.entries.find((e) => e.id.unitKey === 'body/1')
    expect(entry?.state).toBe('needs-review')
    expect(serializeCatalog(drafted)).toContain('#, needs-review')
  })

  it('refuses to overwrite a human-accepted translation (spec 004 FR-001)', () => {
    const previous = reviewedCatalog()
    expect(previous.entries[0]?.state).toBe('reviewed')
    expect(() =>
      applyDraftTranslation(previous, parseUnitId('slides:s01:body/1'), 'MASCHINE'),
    ).toThrow(/human-authored|reviewed/)
    // and leaves the catalog untouched
    expect(previous.entries[0]?.translation).toBe('übersetzt')
  })

  it('refuses to overwrite the human translation sitting under a fuzzy marker', () => {
    const previous = reviewedCatalog()
    const edited = BASE.map((u, index) =>
      index === 0 ? unit('slides:s01:body/1', 'A Pod holds containers.') : u,
    )
    const stale = updateCatalog({ identity: IDENTITY, units: edited, previous }).catalog
    expect(stale.entries[0]?.state).toBe('fuzzy')
    expect(() =>
      applyDraftTranslation(stale, parseUnitId('slides:s01:body/1'), 'MASCHINE'),
    ).toThrow(/human-authored|fuzzy/)
    expect(stale.entries[0]?.translation).toBe('übersetzt')
  })

  it('re-drafts over an earlier machine draft, which is not human work', () => {
    const fresh = updateCatalog({ identity: IDENTITY, units: BASE }).catalog
    const once = applyDraftTranslation(fresh, parseUnitId('slides:s01:body/1'), 'Erste Fassung.')
    const twice = applyDraftTranslation(once, parseUnitId('slides:s01:body/1'), 'Zweite Fassung.')
    expect(twice.entries[0]?.translation).toBe('Zweite Fassung.')
    expect(twice.entries[0]?.state).toBe('needs-review')
  })

  it('exposes the predicate a bulk seeding pass filters on', () => {
    const fresh = updateCatalog({ identity: IDENTITY, units: BASE }).catalog
    expect(fresh.entries.every((entry) => isDraftable(entry))).toBe(true)
    expect(reviewedCatalog().entries.some((entry) => isDraftable(entry))).toBe(false)
  })

  it('refuses an empty draft, which would flag a unit that has nothing to review', () => {
    const fresh = updateCatalog({ identity: IDENTITY, units: BASE }).catalog
    expect(() => applyDraftTranslation(fresh, parseUnitId('slides:s01:body/1'), '')).toThrow(
      /empty draft/,
    )
  })

  it('clears a stale fuzzy marker on an entry that had no human translation under it', () => {
    // A fuzzy flag over an empty msgstr reads as `missing`, so there is no human work to
    // destroy — this is the one case where drafting legitimately clears the marker.
    const fresh = updateCatalog({ identity: IDENTITY, units: BASE }).catalog
    const stale = parseCatalog(
      serializeCatalog(fresh).replace(
        'msgctxt "slides:s01:body/1"',
        '#, fuzzy\nmsgctxt "slides:s01:body/1"',
      ),
      { identity: IDENTITY, fileName: FILE },
    )
    expect(stale.entries[0]?.state).toBe('missing')

    const drafted = applyDraftTranslation(stale, parseUnitId('slides:s01:body/1'), 'Neu gedraftet.')
    const entry = drafted.entries.find((e) => e.id.unitKey === 'body/1')
    expect(entry?.state).toBe('needs-review')
    expect(entry?.po.flags).not.toContain('fuzzy')
  })
})

describe('catalogStatuses', () => {
  it('reports state per unit and never speaks to requiredness', () => {
    const catalog = reviewedCatalog()
    const statuses = catalogStatuses(catalog)
    expect(statuses).toHaveLength(3)
    expect(statuses[0]).toEqual({
      id: parseUnitId('slides:s01:body/1'),
      locale: 'de',
      section: '03-pods',
      state: 'reviewed',
    })
    for (const status of statuses) {
      expect(Object.hasOwn(status, 'required')).toBe(false)
    }
  })

  it('excludes obsolete entries — they describe content that no longer exists', () => {
    const previous = reviewedCatalog()
    const result = updateCatalog({ identity: IDENTITY, units: BASE.slice(0, 2), previous })
    expect(catalogStatuses(result.catalog).map((s) => s.id.containerId)).toEqual(['s01', 's01'])
  })
})
