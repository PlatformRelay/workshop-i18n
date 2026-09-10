import {
  type Catalog,
  parseCatalog,
  serializeCatalog,
  updateCatalog,
} from '@workshop-i18n/catalog-po'
import { extractLabFile } from '@workshop-i18n/extract-markdown'
import { extractSlidevFile } from '@workshop-i18n/extract-slidev'
import { describe, expect, it } from 'vitest'
import { formatSeedReport } from '../src/report.js'
import { seed } from '../src/seed.js'
import { SeedInputError } from '../src/types.js'

const EN = `---
slideId: s05-title
title: Pods
---

# One Pod

A Pod is small.

---
slideId: s05-yaml
layout: two-cols
---

## The manifest

Apply it.

---
slideId: s05-recap
---

# Recap

- Pods are atoms.
`

const PT = `---
title: Pods (pt)
---

# Um Pod

Um Pod é pequeno.

---
layout: center
---

## O manifesto

Aplique-o.

---

# Recap

- Pods são átomos.
`

const LABEL = 'Kubernetes-Workshop PR #55 by João Brito (@juniorjbn)'
const IDENTITY = { locale: 'pt-BR', name: 'slides' }

function catalog(): Catalog {
  return updateCatalog({ identity: IDENTITY, units: extractSlidevFile(EN).units }).catalog
}

function run(catalogs: readonly Catalog[] = [catalog()]) {
  return seed({
    locale: 'pt-BR',
    provenance: LABEL,
    slides: {
      english: [{ path: 'S05-pod/index.md', text: EN }],
      translated: [{ path: 'S05-pod/index.md', text: PT }],
    },
    catalogs,
  })
}

describe('seed', () => {
  it('seeds matched units as needs-review and reports per-section counts (AS-1)', () => {
    const { catalogs, report } = run()
    const states = (catalogs[0] as Catalog).entries.map((entry) => entry.state)
    expect(states.filter((state) => state === 'needs-review')).toHaveLength(4)
    expect(states).not.toContain('reviewed')

    const section = report.surfaces[0]?.sections[0]
    expect(section).toMatchObject({
      surface: 'slides',
      section: 'S05-pod/index.md',
      englishUnits: 7,
      aligned: 4,
      missed: 3,
      outcomes: { seeded: 4, 'already-seeded': 0, 'kept-human': 0 },
      missReasons: { 'structure-diverged': 2, 'identical-to-source': 1 },
    })
    expect(report.totals).toMatchObject({ englishUnits: 7, aligned: 4, missed: 3 })
    expect(report.locale).toBe('pt-BR')
    expect(report.provenance).toBe(LABEL)
  })

  it('lists the diverged slide in the miss report, by id and reason (AS-2)', () => {
    const { report } = run()
    const misses = report.surfaces[0]?.sections[0]?.misses ?? []
    expect(misses).toContainEqual(
      expect.objectContaining({
        reason: 'structure-diverged',
        containerId: 's05-yaml',
        unitIds: ['slides:s05-yaml:body/h2-1/p-1', 'slides:s05-yaml:body/h2-1/title'],
      }),
    )
    const text = formatSeedReport(report)
    expect(text).toContain('s05-yaml')
    expect(text).toContain('structure-diverged')
    expect(text).toContain('S05-pod/index.md')
    expect(text).toContain(LABEL)
  })

  it('never overwrites a human-touched entry when re-run (AS-3)', () => {
    const first = run()
    // A reviewer accepts one draft with an edit: the flag goes, the text changes.
    const ctxt = 'msgctxt "slides:s05-title:body/h1-1/p-1"'
    const text = serializeCatalog(first.catalogs[0] as Catalog)
      .replace(`#, needs-review\n${ctxt}`, ctxt)
      .replace('Um Pod é pequeno.', 'Um Pod é bem pequeno.')
    const touched = parseCatalog(text, { identity: IDENTITY, fileName: 'slides.po' })
    expect(touched.entries.filter((entry) => entry.state === 'reviewed')).toHaveLength(1)
    const second = run([touched])
    expect(serializeCatalog(second.catalogs[0] as Catalog)).toBe(serializeCatalog(touched))
    expect(second.report.totals.outcomes).toMatchObject({
      'kept-human': 1,
      'already-seeded': 3,
      seeded: 0,
    })
  })

  it('produces a JSON-serialisable report that survives a round trip unchanged', () => {
    const { report } = run()
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('is deterministic', () => {
    const a = run()
    const b = run()
    expect(a.report).toEqual(b.report)
    expect(serializeCatalog(a.catalogs[0] as Catalog)).toBe(
      serializeCatalog(b.catalogs[0] as Catalog),
    )
    expect(formatSeedReport(a.report)).toBe(formatSeedReport(b.report))
  })

  it('lists warned and untranslated units by id, so a reviewer can find them', () => {
    const lab = '# Lab\n\n<!-- labId: l1 -->\n\nRun `kubectl get pods` now.\n\nStay here.\n'
    const translatedLab = '# Laboratório\n\nExecute kubectl get pods agora.\n\nStay here.\n'
    const labs = updateCatalog({
      identity: { locale: 'pt-BR', name: 'labs' },
      units: extractLabFile(lab).units,
    }).catalog
    const { catalogs, report } = seed({
      locale: 'pt-BR',
      provenance: LABEL,
      labs: {
        english: [{ path: 'l1.md', text: lab }],
        translated: [{ path: 'l1.md', text: translatedLab }],
      },
      catalogs: [labs],
    })
    const section = report.surfaces[0]?.sections[0]
    expect(section?.warnedUnits).toEqual([
      { id: 'labs:l1:body/h1-1/p-1', warnings: ['code-span-divergence'] },
    ])
    const text = formatSeedReport(report)
    expect(text).toContain('labs:l1:body/h1-1/p-1')
    expect(text).toContain('code-span-divergence')
    expect(text).toContain('labs:l1:body/h1-1/p-2')
    // The warning also travels with the entry, where a Weblate reviewer sees it.
    const warned = (catalogs[0] as Catalog).entries.find(
      (entry) => entry.id.unitKey === 'body/h1-1/p-1',
    )
    expect(warned?.po.comments).toContainEqual({
      marker: '.',
      text: ' workshop-i18n-seed-warning: code-span-divergence',
    })
  })

  it('renders untrusted paths without their control characters', () => {
    const result = seed({
      locale: 'pt-BR',
      provenance: LABEL,
      slides: {
        english: [{ path: 'S05-pod/index.md', text: EN }],
        translated: [{ path: 'evil\u001b[2J.md', text: PT }],
      },
      catalogs: [catalog()],
    })
    expect(result.report.surfaces[0]?.unpairedTranslated).toEqual(['evil\u001b[2J.md'])
    expect(formatSeedReport(result.report)).not.toContain('\u001b')
  })

  it('refuses a locale that is not a safe tag', () => {
    expect(() => seed({ locale: '../x', provenance: LABEL, catalogs: [] })).toThrow(SeedInputError)
  })
})
