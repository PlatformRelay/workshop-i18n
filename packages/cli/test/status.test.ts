import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { invoke, MemoryFileSystem } from './memory-fs.js'

const MANIFEST = `apiVersion: workshop-i18n/v1
locales:
  targets: [pt-BR, de]
surfaces:
  slides:
    include: ['pages/**/index.md']
  labs:
    include: ['labs/**/*.md']
`

const POD_SLIDES = [
  '---',
  'slideId: s05-pod-pods',
  '---',
  '',
  '# Pods',
  '',
  'A Pod wraps one or more containers.',
  '',
  'Pods share a network namespace.',
  '',
].join('\n')

const POD_LAB = ['# Lab 05', '', '<!-- labId: day-1-05-pod -->', '', 'Run a Pod.', ''].join('\n')

const SLIDES_PO = '/repo/i18n/pt-BR/pages/S05-pod/index.po'
const LAB_PO = '/repo/i18n/pt-BR/labs/day-1/05-pod.po'

function extracted(): MemoryFileSystem {
  const fs = new MemoryFileSystem({
    '/repo/.localization/workshop.yaml': MANIFEST,
    '/repo/pages/S05-pod/index.md': POD_SLIDES,
    '/repo/labs/day-1/05-pod.md': POD_LAB,
  })
  const result = invoke(fs, ['extract'])
  if (result.code !== EXIT.OK) throw new Error(`extract failed: ${result.stderr}`)
  return fs
}

/** Fill every untranslated entry of a catalog, optionally flagging it. */
function translateAll(po: string, flag?: 'fuzzy' | 'needs-review'): string {
  return po
    .split('\n\n')
    .map((block, index) => {
      if (index === 0) return block
      // The last block keeps the file's trailing newline, so `$` must allow for it.
      const filled = block.replace(/msgstr ""(\n?)$/, 'msgstr "tradução"$1')
      return flag === undefined ? filled : filled.replace('msgctxt', `#, ${flag}\nmsgctxt`)
    })
    .join('\n\n')
}

function unitIds(po: string): readonly string[] {
  return [...po.matchAll(/^msgctxt "([^"]+)"$/gm)].map((match) => match[1] as string)
}

interface StatusJson {
  readonly schemaVersion: number
  readonly sourceLocale: string
  readonly catalogsCurrent: boolean
  readonly total: number
  readonly totals: Record<string, number>
  readonly locales: readonly {
    readonly locale: string
    readonly total: number
    readonly counts: Record<string, number>
    readonly sections: readonly {
      readonly section: string
      readonly total: number
      readonly counts: Record<string, number>
    }[]
  }[]
  readonly policy: null | {
    readonly name: string
    readonly satisfied: boolean
    readonly violations: readonly {
      readonly locale: string
      readonly state: string
      readonly limit: number
      readonly count: number
      readonly units: readonly { readonly id: string; readonly section: string }[]
    }[]
  }
}

function json(fs: MemoryFileSystem, argv: readonly string[] = []) {
  const result = invoke(fs, ['status', '--json', ...argv])
  return { ...result, report: JSON.parse(result.stdout) as StatusJson }
}

describe('status — the report (spec 002 US-2, FR-006)', () => {
  it('tallies per locale × section × state, joining the English unit set', () => {
    const fs = extracted()
    fs.put(LAB_PO, translateAll(fs.text(LAB_PO)))
    const { code, report } = json(fs)
    expect(code).toBe(EXIT.OK)
    expect(report.locales.map((locale) => locale.locale)).toEqual(['de', 'pt-BR'])
    const ptBR = report.locales[1]
    expect(ptBR?.sections.map((section) => section.section)).toEqual([
      'labs/day-1/05-pod.md',
      'pages/S05-pod/index.md',
    ])
    expect(ptBR?.sections[0]?.counts).toEqual({
      missing: 0,
      fuzzy: 0,
      'needs-review': 0,
      reviewed: 2,
    })
    expect(ptBR?.sections[1]?.counts.missing).toBe(3)
    expect(report.locales[0]?.counts.missing).toBe(report.locales[0]?.total)
    expect(report.policy).toBeNull()
    expect(report.catalogsCurrent).toBe(true)
  })

  it('emits byte-identical, stably ordered JSON on every run (SC-003)', () => {
    const fs = extracted()
    const first = invoke(fs, ['status', '--json']).stdout
    expect(invoke(fs, ['status', '--json']).stdout).toBe(first)
    expect(Object.keys(JSON.parse(first))).toEqual([
      'schemaVersion',
      'sourceLocale',
      'catalogsCurrent',
      'total',
      'totals',
      'locales',
      'policy',
    ])
    expect(Object.keys((JSON.parse(first) as StatusJson).totals)).toEqual([
      'missing',
      'fuzzy',
      'needs-review',
      'reviewed',
    ])
  })

  it('prints a human table with a row per section', () => {
    const fs = extracted()
    const result = invoke(fs, ['status'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toMatch(/pt-BR\s+5 units: missing 5, fuzzy 0, needs-review 0, reviewed 0/)
    expect(result.stdout).toMatch(/pages\/S05-pod\/index\.md\s+3\s+3\s+0\s+0\s+0/)
  })

  it('reports a locale with no catalogs at all as entirely missing', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST,
      '/repo/pages/S05-pod/index.md': POD_SLIDES,
      '/repo/labs/day-1/05-pod.md': POD_LAB,
    })
    const { report } = json(fs, ['--policy', 'release'])
    expect(report.totals.missing).toBe(report.total)
    expect(report.policy?.satisfied).toBe(false)
    expect(report.catalogsCurrent).toBe(false)
  })

  it('reports what extract would produce when the English moved since the last extract', () => {
    const fs = extracted()
    fs.put(SLIDES_PO, translateAll(fs.text(SLIDES_PO)))
    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.replace('Pods share a network namespace.', 'Pods share one network namespace.'),
    )
    const result = json(fs, ['--locale', 'pt-BR'])
    const section = result.report.locales[0]?.sections.find(
      (entry) => entry.section === 'pages/S05-pod/index.md',
    )
    expect(section?.counts).toEqual({ missing: 0, fuzzy: 1, 'needs-review': 0, reviewed: 2 })
    expect(result.report.catalogsCurrent).toBe(false)
    expect(result.stderr).toContain('run workshop-i18n extract')
  })

  it('warns about, and excludes, catalogs for a locale the manifest does not declare', () => {
    const fs = extracted()
    fs.put('/repo/i18n/fr/pages/S05-pod/index.po', 'garbage')
    const result = json(fs, ['--policy', 'release'])
    expect(result.report.locales.map((locale) => locale.locale)).toEqual(['de', 'pt-BR'])
    expect(result.stderr).toContain('i18n/fr/ is for a locale the manifest does not declare')
  })
})

describe('status --policy (spec 002 US-2)', () => {
  it('fails release on 3 fuzzy entries, listing the three ids with sections (AS-1)', () => {
    const fs = extracted()
    const slides = translateAll(fs.text(SLIDES_PO), 'fuzzy')
    fs.put(SLIDES_PO, slides)
    fs.put(LAB_PO, translateAll(fs.text(LAB_PO)))
    const result = json(fs, ['--policy', 'release', '--locale', 'pt-BR'])
    expect(result.code).toBe(EXIT.FAILED)
    const fuzzy = result.report.policy?.violations.find((violation) => violation.state === 'fuzzy')
    expect(fuzzy?.count).toBe(3)
    expect(fuzzy?.units).toEqual(
      unitIds(slides).map((id) => ({ id, section: 'pages/S05-pod/index.md' })),
    )
  })

  it('names the gating ids and sections in the human report too', () => {
    const fs = extracted()
    const slides = translateAll(fs.text(SLIDES_PO), 'fuzzy')
    fs.put(SLIDES_PO, slides)
    fs.put(LAB_PO, translateAll(fs.text(LAB_PO)))
    const result = invoke(fs, ['status', '--policy', 'release', '--locale', 'pt-BR'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.stdout).toContain('policy release: FAILED')
    for (const id of unitIds(slides)) {
      expect(result.stdout).toContain(`${id}  pages/S05-pod/index.md`)
    }
  })

  it('passes release for a fully reviewed locale (AS-2)', () => {
    const fs = extracted()
    fs.put(SLIDES_PO, translateAll(fs.text(SLIDES_PO)))
    fs.put(LAB_PO, translateAll(fs.text(LAB_PO)))
    const result = json(fs, ['--policy', 'release', '--locale', 'pt-BR'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.report.policy).toEqual({ name: 'release', satisfied: true, violations: [] })
  })

  it('gates needs-review under release: drafts are not shipping-grade (constitution V)', () => {
    const fs = extracted()
    fs.put(SLIDES_PO, translateAll(fs.text(SLIDES_PO), 'needs-review'))
    fs.put(LAB_PO, translateAll(fs.text(LAB_PO)))
    const result = json(fs, ['--policy', 'release', '--locale', 'pt-BR'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.report.policy?.violations.map((violation) => violation.state)).toEqual([
      'needs-review',
    ])
  })

  it('passes preview on an untranslated locale', () => {
    const fs = extracted()
    expect(invoke(fs, ['status', '--policy', 'preview']).code).toBe(EXIT.OK)
  })

  it('fails the whole corpus when any declared locale fails', () => {
    const fs = extracted()
    fs.put(SLIDES_PO, translateAll(fs.text(SLIDES_PO)))
    fs.put(LAB_PO, translateAll(fs.text(LAB_PO)))
    const result = json(fs, ['--policy', 'release'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.report.policy?.violations.map((violation) => violation.locale)).toEqual(['de'])
  })
})

describe('status — usage errors', () => {
  it('rejects an unknown policy with 64, listing the known ones', () => {
    const result = invoke(extracted(), ['status', '--policy', 'relase'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('known policies are preview, release')
  })

  it('rejects a locale the manifest does not declare with 64', () => {
    const result = invoke(extracted(), ['status', '--locale', 'fr'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('"fr" is not a target locale')
  })

  it('rejects an unsafe locale tag with 64', () => {
    const result = invoke(extracted(), ['status', '--locale', '../x'])
    expect(result.code).toBe(EXIT.USAGE)
  })

  it('exits 65 on a broken catalog, naming file and line', () => {
    const fs = extracted()
    fs.put(LAB_PO, `${fs.text(LAB_PO)}\nmsgid "unterminated\n`)
    const result = invoke(fs, ['status'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toMatch(/i18n\/pt-BR\/labs\/day-1\/05-pod\.po:\d+:/)
  })
})
