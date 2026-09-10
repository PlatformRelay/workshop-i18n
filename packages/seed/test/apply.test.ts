import {
  type Catalog,
  type CatalogIdentity,
  NEEDS_REVIEW_FLAG,
  parseCatalog,
  serializeCatalog,
  updateCatalog,
} from '@workshop-i18n/catalog-po'
import { createTranslationUnit, formatUnitId, parseUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { applySeedDrafts, SEED_COMMENT_KEY } from '../src/apply.js'
import { type SeedDraft, SeedInputError } from '../src/types.js'

const IDENTITY: CatalogIdentity = { locale: 'pt-BR', name: 'slides' }
const FILE = 'i18n/pt-BR/slides.po'
const LABEL = 'Kubernetes-Workshop PR #55 by João Brito (@juniorjbn)'
const OPTIONS = { locale: 'pt-BR', provenance: LABEL }

const SOURCES: Record<string, string> = {
  'slides:s1:body/p-1': 'A Pod is small.',
  'slides:s1:body/p-2': 'Pods are atoms.',
  'slides:s2:body/p-1': 'A Service is stable.',
}

function fresh(): Catalog {
  const units = Object.entries(SOURCES).map(([id, source]) =>
    createTranslationUnit(parseUnitId(id), source),
  )
  return updateCatalog({ identity: IDENTITY, units }).catalog
}

const reread = (catalog: Catalog): Catalog =>
  parseCatalog(serializeCatalog(catalog), { identity: IDENTITY, fileName: FILE })

/** Rewrite one entry's PO text by hand, the way a translator or a TMS would. */
function edit(catalog: Catalog, id: string, replace: (block: string) => string): Catalog {
  const text = serializeCatalog(catalog)
  const start = text.indexOf(`msgctxt "${id}"`)
  const blockStart = text.lastIndexOf('\n\n', start) + 2
  const blockEnd = text.indexOf('\n\n', start)
  const block = text.slice(blockStart, blockEnd === -1 ? undefined : blockEnd)
  return parseCatalog(text.replace(block, replace(block)), { identity: IDENTITY, fileName: FILE })
}

const draft = (id: string, translation: string, source = SOURCES[id] as string): SeedDraft => ({
  id: parseUnitId(id),
  source,
  translation,
  warnings: [],
})

const entry = (catalog: Catalog, id: string) =>
  catalog.entries.find((item) => formatUnitId(item.id) === id)

describe('applySeedDrafts', () => {
  it('lands a draft on a missing entry as needs-review, with provenance naming the seed source (AS-1)', () => {
    const result = applySeedDrafts(
      [fresh()],
      [draft('slides:s1:body/p-1', 'Um Pod é pequeno.')],
      OPTIONS,
    )
    const seeded = entry(reread(result.catalogs[0] as Catalog), 'slides:s1:body/p-1')
    expect(seeded?.state).toBe('needs-review')
    expect(seeded?.translation).toBe('Um Pod é pequeno.')
    expect(seeded?.po.comments).toContainEqual({
      marker: '.',
      text: ` ${SEED_COMMENT_KEY}: ${LABEL}`,
    })
    expect(result.outcomes).toEqual([{ id: 'slides:s1:body/p-1', outcome: 'seeded' }])
  })

  it('never writes a reviewed entry', () => {
    const result = applySeedDrafts(
      [fresh()],
      Object.keys(SOURCES).map((id) => draft(id, `pt ${id}`)),
      OPTIONS,
    )
    for (const item of (result.catalogs[0] as Catalog).entries) {
      expect(item.state).toBe('needs-review')
      expect(item.po.flags).toContain(NEEDS_REVIEW_FLAG)
    }
  })

  it('never overwrites a human-touched entry on a re-run (AS-3)', () => {
    const first = applySeedDrafts(
      [fresh()],
      [draft('slides:s1:body/p-1', 'Um Pod é pequeno.')],
      OPTIONS,
    )
    // A reviewer accepts the draft with an edit: the flag goes, the text changes.
    const accepted = edit(first.catalogs[0] as Catalog, 'slides:s1:body/p-1', (block) =>
      block.replace('#, needs-review\n', '').replace('Um Pod é pequeno.', 'Um Pod é pequenino.'),
    )
    expect(entry(accepted, 'slides:s1:body/p-1')?.state).toBe('reviewed')

    const second = applySeedDrafts(
      [accepted],
      [draft('slides:s1:body/p-1', 'Um Pod é pequeno.')],
      OPTIONS,
    )
    expect(serializeCatalog(second.catalogs[0] as Catalog)).toBe(serializeCatalog(accepted))
    expect(second.outcomes).toEqual([{ id: 'slides:s1:body/p-1', outcome: 'kept-human' }])
  })

  it('treats a fuzzy entry without the draft marker as human work', () => {
    const fuzzy = edit(
      fresh(),
      'slides:s1:body/p-2',
      (block) => `#, fuzzy\n${block.replace('msgstr ""', 'msgstr "Pods são átomos."')}`,
    )
    expect(entry(fuzzy, 'slides:s1:body/p-2')?.state).toBe('fuzzy')
    const result = applySeedDrafts([fuzzy], [draft('slides:s1:body/p-2', 'Outra coisa.')], OPTIONS)
    expect(result.outcomes[0]?.outcome).toBe('kept-human')
    expect(serializeCatalog(result.catalogs[0] as Catalog)).toBe(serializeCatalog(fuzzy))
  })

  it('keeps an existing draft that differs — a reviewer may be mid-edit — and reports it', () => {
    const first = applySeedDrafts([fresh()], [draft('slides:s1:body/p-1', 'Primeira.')], OPTIONS)
    const second = applySeedDrafts(
      first.catalogs,
      [draft('slides:s1:body/p-1', 'Segunda.')],
      OPTIONS,
    )
    expect(second.outcomes[0]?.outcome).toBe('kept-draft')
    expect(entry(second.catalogs[0] as Catalog, 'slides:s1:body/p-1')?.translation).toBe(
      'Primeira.',
    )
  })

  it('is idempotent: a re-run with the same drafts is a zero-byte change', () => {
    const drafts = Object.keys(SOURCES).map((id) => draft(id, `pt ${id}`))
    const first = applySeedDrafts([fresh()], drafts, OPTIONS)
    const second = applySeedDrafts([reread(first.catalogs[0] as Catalog)], drafts, OPTIONS)
    expect(serializeCatalog(second.catalogs[0] as Catalog)).toBe(
      serializeCatalog(first.catalogs[0] as Catalog),
    )
    expect(second.outcomes.map((item) => item.outcome)).toEqual([
      'already-seeded',
      'already-seeded',
      'already-seeded',
    ])
  })

  it('refuses a draft made against English the catalog no longer holds', () => {
    const result = applySeedDrafts(
      [fresh()],
      [draft('slides:s1:body/p-1', 'Um Pod.', 'A Pod was small.')],
      OPTIONS,
    )
    expect(result.outcomes[0]?.outcome).toBe('source-changed')
    expect(entry(result.catalogs[0] as Catalog, 'slides:s1:body/p-1')?.state).toBe('missing')
  })

  it('reports a draft no catalog has an entry for', () => {
    const result = applySeedDrafts([fresh()], [draft('slides:s9:body/p-1', 'x', 'y')], OPTIONS)
    expect(result.outcomes).toEqual([{ id: 'slides:s9:body/p-1', outcome: 'not-in-catalog' }])
  })

  it('finds each draft in whichever catalog holds its unit, and leaves the others alone', () => {
    const other = updateCatalog({
      identity: { locale: 'pt-BR', name: 'labs' },
      units: [createTranslationUnit(parseUnitId('labs:l1:body/p-1'), 'Run it.')],
    }).catalog
    const result = applySeedDrafts(
      [fresh(), other],
      [draft('labs:l1:body/p-1', 'Execute.', 'Run it.')],
      OPTIONS,
    )
    expect(serializeCatalog(result.catalogs[0] as Catalog)).toBe(serializeCatalog(fresh()))
    expect((result.catalogs[1] as Catalog).entries[0]?.state).toBe('needs-review')
  })

  it('refuses a unit id that two catalogs both claim', () => {
    expect(() => applySeedDrafts([fresh(), fresh()], [], OPTIONS)).toThrow(SeedInputError)
  })

  it('refuses a catalog for another locale', () => {
    expect(() => applySeedDrafts([fresh()], [], { ...OPTIONS, locale: 'de' })).toThrow(
      SeedInputError,
    )
  })

  it.each([
    ['empty', ''],
    ['multi-line', 'PR #55\nmsgstr "x"'],
    ['control characters', 'PR\u0007#55'],
    ['overlong', 'x'.repeat(201)],
  ])('refuses a provenance label that is %s', (_label, provenance) => {
    expect(() => applySeedDrafts([fresh()], [], { ...OPTIONS, provenance })).toThrow(SeedInputError)
  })

  it('refuses a draft id that is not safe', () => {
    const unsafe = {
      ...draft('slides:s1:body/p-1', 'x'),
      id: { surface: 'slides', containerId: '../x', unitKey: 'p-1' },
    } as SeedDraft
    expect(() => applySeedDrafts([fresh()], [unsafe], OPTIONS)).toThrow()
  })

  it('refuses two drafts for one unit — the English corpus declared an id twice', () => {
    expect(() =>
      applySeedDrafts(
        [fresh()],
        [draft('slides:s1:body/p-1', 'um'), draft('slides:s1:body/p-1', 'dois')],
        OPTIONS,
      ),
    ).toThrow(SeedInputError)
  })
})
