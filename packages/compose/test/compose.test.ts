/**
 * `composeLocale` against spec 003 User Story 1 and FR-001/002/004/005/006.
 *
 * Each `describe` names the acceptance scenario or requirement it covers, so the spec can
 * be read against this file (ADR 0010, story-driven tests).
 */

import { catalogStatuses, emptyCatalog } from '@workshop-i18n/catalog-po'
import { evaluatePolicy, statusesForLocale } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { type ComposeLocaleInput, composeLocale, type SourceFile } from '../src/compose.js'
import { ComposeInputError } from '../src/findings.js'
import { FALLBACK_MARKER } from '../src/marker.js'
import { locateFile } from '../src/surface.js'
import { catalog, DECK, type EntrySpec, LAB, MANIFEST, QUIZ } from './helpers.js'

const FILES: readonly SourceFile[] = [
  { path: 'slides/intro.md', surface: 'slides', text: DECK },
  { path: 'labs/one.md', surface: 'labs', text: LAB },
  { path: 'quiz/bank.json', surface: 'quiz', text: QUIZ },
]

const HEADING = 'slides:intro:fm/heading'
const POD = 'slides:intro:body/p-1'
const TITLE = 'slides:second:body/h1-1/title'
const RUN = 'slides:second:body/h1-1/p-1'

const REVIEWED: readonly EntrySpec[] = [
  { id: HEADING, source: 'Welcome to the workshop', translation: 'Willkommen im Workshop' },
  { id: POD, source: 'A Pod is the smallest unit.', translation: 'Ein Pod: kleinste Einheit.' },
  { id: TITLE, source: 'Second slide', translation: 'Zweite Folie' },
  {
    id: RUN,
    source: 'Run `kubectl apply` in <v-click>the lab</v-click>.',
    translation: 'Führe `kubectl apply` im <v-click>Lab</v-click> aus.',
  },
]

function slidesOnly(
  entries: readonly EntrySpec[],
  mode?: 'preview' | 'strict',
): ComposeLocaleInput {
  return {
    manifest: MANIFEST,
    locale: 'de',
    files: [FILES[0] as SourceFile],
    catalogs: [catalog('de', 'slides', entries)],
    ...(mode === undefined ? {} : { mode }),
  }
}

function withEntry(id: string, change: Partial<EntrySpec>): readonly EntrySpec[] {
  return REVIEWED.map((entry) => (entry.id === id ? { ...entry, ...change } : entry))
}

function deckOf(result: ReturnType<typeof composeLocale>): string {
  return result.files.find((file) => file.path === 'slides/intro.md')?.text ?? ''
}

function fences(text: string): readonly string[] {
  return text.match(/```[\s\S]*?```/g) ?? []
}

describe('US1 AS-1: a fully reviewed section', () => {
  const result = composeLocale(slidesOnly(REVIEWED, 'strict'))

  it('renders German prose and is releasable', () => {
    expect(result.releasable).toBe(true)
    expect(result.findings).toEqual([])
    expect(deckOf(result)).toContain('Ein Pod: kleinste Einheit.')
    expect(deckOf(result)).toContain('heading: "Willkommen im Workshop"')
    expect(deckOf(result)).not.toContain(FALLBACK_MARKER)
  })

  it('keeps every code fence and frontmatter machinery line byte-identical to English', () => {
    expect(fences(deckOf(result))).toEqual(fences(DECK))
    for (const line of ['slideId: intro', 'layout: statement', 'slideId: second']) {
      expect(deckOf(result)).toContain(line)
    }
  })

  it('reports every unit as rendering its translation', () => {
    expect(result.units.map((unit) => [unit.id, unit.state, unit.rendering])).toEqual([
      [POD, 'reviewed', 'translation'],
      [HEADING, 'reviewed', 'translation'],
      [RUN, 'reviewed', 'translation'],
      [TITLE, 'reviewed', 'translation'],
    ])
  })
})

describe('US1 AS-2: a fuzzy unit', () => {
  const entries = withEntry(POD, { flags: ['fuzzy'] })

  it('renders the English with a visible fallback marker in preview', () => {
    const result = composeLocale(slidesOnly(entries))
    expect(deckOf(result)).toContain(`${FALLBACK_MARKER}A Pod is the smallest unit.`)
    expect(deckOf(result)).not.toContain('Ein Pod:')
    expect(result.units.find((unit) => unit.id === POD)).toMatchObject({
      state: 'fuzzy',
      rendering: 'fallback',
      marked: true,
    })
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([])
  })

  it('fails strict composition listing that unit, and emits no files', () => {
    const result = composeLocale(slidesOnly(entries, 'strict'))
    expect(result.releasable).toBe(false)
    expect(result.files).toEqual([])
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'policy', unitId: POD, detail: 'fuzzy' }),
    )
  })
})

describe('FR-005: states and modes', () => {
  it('marks missing units in preview, and a missing catalog marks every unit', () => {
    const result = composeLocale({ ...slidesOnly([]), catalogs: [] })
    for (const unit of result.units) expect(unit).toMatchObject({ state: 'missing', marked: true })
    expect(deckOf(result)).toContain(`heading: "${FALLBACK_MARKER}Welcome to the workshop"`)
    expect(deckOf(result)).toContain(`# ${FALLBACK_MARKER}Second slide`)
  })

  it('renders needs-review drafts translated and unmarked in preview, and fails strict on them', () => {
    const entries = withEntry(TITLE, { flags: ['needs-review'] })
    const preview = composeLocale(slidesOnly(entries))
    expect(deckOf(preview)).toContain('# Zweite Folie')
    expect(preview.units.find((unit) => unit.id === TITLE)).toMatchObject({
      state: 'needs-review',
      rendering: 'translation',
      marked: false,
    })
    const strict = composeLocale(slidesOnly(entries, 'strict'))
    expect(strict.files).toEqual([])
    expect(strict.findings).toContainEqual(
      expect.objectContaining({ code: 'policy', unitId: TITLE, detail: 'needs-review' }),
    )
    // Pinned in compose itself, not only through the policy: strict never even plans to
    // render a draft, so the empty file list is not the only thing standing in the way.
    expect(strict.units.find((unit) => unit.id === TITLE)).toMatchObject({
      state: 'needs-review',
      rendering: 'fallback',
    })
    expect(strict.releasable).toBe(false)
  })

  it('gates a needs-review draft like any translation: hostile markup falls back in preview', () => {
    const entries = withEntry(TITLE, {
      flags: ['needs-review'],
      translation: 'Zweite <img src=x onerror=alert(1)> Folie',
    })
    const preview = composeLocale(slidesOnly(entries))
    expect(deckOf(preview)).not.toContain('onerror')
    expect(deckOf(preview)).toContain(`# ${FALLBACK_MARKER}Second slide`)
    expect(preview.units.find((unit) => unit.id === TITLE)).toMatchObject({
      state: 'needs-review',
      rendering: 'fallback',
      marked: true,
      reasons: ['markup-parity'],
    })
    expect(preview.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'markup-parity', unitId: TITLE }),
    )
  })

  it('is deliberately stricter than a state-only catalog read on a stale reviewed entry', () => {
    // The entry is `reviewed` in the catalog, but its msgid is English that no longer
    // exists. A raw `catalogStatuses` read calls it reviewed; compose calls it fuzzy and
    // refuses to ship it. SC-003 holds at the pipeline level because `extract` marks such
    // an entry fuzzy before `status` reads it (see README, "Stale entries and SC-003").
    const slides = catalog('de', 'slides', withEntry(POD, { source: 'A Pod is a small unit.' }))
    expect(catalogStatuses(slides).find((status) => status.id.unitKey === 'body/p-1')?.state).toBe(
      'reviewed',
    )
    const strict = composeLocale({ ...slidesOnly([], 'strict'), catalogs: [slides] })
    expect(strict.units.find((unit) => unit.id === POD)).toMatchObject({
      state: 'fuzzy',
      stale: true,
      rendering: 'fallback',
    })
    expect(strict.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'policy', unitId: POD, detail: 'fuzzy' }),
    )
    expect(strict.files).toEqual([])
  })

  it('treats a translation of different English as fuzzy, not as shippable', () => {
    const entries = withEntry(POD, { source: 'A Pod is a small unit.' })
    const preview = composeLocale(slidesOnly(entries))
    expect(preview.units.find((unit) => unit.id === POD)).toMatchObject({
      state: 'fuzzy',
      stale: true,
      marked: true,
    })
    expect(preview.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'stale-translation', unitId: POD }),
    )
    const strict = composeLocale(slidesOnly(entries, 'strict'))
    expect(strict.releasable).toBe(false)
  })

  it('gates the same units as `status --policy release` (SC-003)', () => {
    // Built the way `status` builds it: English units from extraction, states from the
    // catalog through catalog-po, joined and judged by core.
    const slides = catalog('de', 'slides', withEntry(POD, { flags: ['fuzzy'] }))
    const result = composeLocale({ ...slidesOnly([], 'strict'), catalogs: [slides] })
    const english = locateFile('slides', DECK).holes.map((hole) => ({
      id: hole.id,
      section: 'slides/intro.md',
    }))
    const status = evaluatePolicy(
      statusesForLocale(english, catalogStatuses(slides), 'de'),
      'release',
    )
    expect(result.policy).toEqual(status)
    expect(status.satisfied).toBe(false)
  })
})

describe('FR-004: content gates on untrusted translations', () => {
  const hostile = withEntry(RUN, {
    translation:
      'Führe `kubectl apply` im <v-click>Lab</v-click> aus. <img src=x onerror=alert(1)>',
  })

  it('never emits a translation that adds markup: fallback and a warning in preview', () => {
    const result = composeLocale(slidesOnly(hostile))
    expect(deckOf(result)).not.toContain('onerror')
    expect(deckOf(result)).toContain(`${FALLBACK_MARKER}Run \`kubectl apply\``)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'markup-parity', unitId: RUN }),
    )
    expect(result.units.find((unit) => unit.id === RUN)?.reasons).toEqual(['markup-parity'])
  })

  it('fails strict composition on it', () => {
    const result = composeLocale(slidesOnly(hostile, 'strict'))
    expect(result.files).toEqual([])
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'markup-parity', unitId: RUN }),
    )
  })

  it.each([
    ['a bare domain', 'Zweite Folie auf attacker.io'],
    ['a bare email address', 'Zweite Folie: admin@evil.com'],
  ])('never emits %s, which linkify would make a live link', (_label, translation) => {
    const entries = withEntry(TITLE, { translation })
    const preview = composeLocale(slidesOnly(entries))
    expect(deckOf(preview)).not.toContain('evil')
    expect(deckOf(preview)).not.toContain('attacker')
    expect(preview.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'markup-parity', unitId: TITLE }),
    )
    const strict = composeLocale(slidesOnly(entries, 'strict'))
    expect(strict.releasable).toBe(false)
    expect(strict.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'markup-parity', unitId: TITLE }),
    )
  })

  it('never emits a new mustache expression', () => {
    const entries = withEntry(TITLE, { translation: 'Zweite {{ $slidev.nav.next() }} Folie' })
    expect(deckOf(composeLocale(slidesOnly(entries)))).not.toContain('{{')
    expect(composeLocale(slidesOnly(entries, 'strict')).releasable).toBe(false)
  })

  it('never emits a changed command in a code span', () => {
    const entries = withEntry(RUN, {
      translation: 'Führe `kubectl delete --all` im <v-click>Lab</v-click> aus.',
    })
    expect(deckOf(composeLocale(slidesOnly(entries)))).not.toContain('delete')
  })

  it('never emits a translation missing a protected term', () => {
    const entries = withEntry(POD, { translation: 'Eine Kapsel ist die kleinste Einheit.' })
    const result = composeLocale(slidesOnly(entries))
    expect(deckOf(result)).not.toContain('Kapsel')
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'protected-term', unitId: POD }),
    )
  })

  it('falls back when the extractor refuses the splice', () => {
    const entries = withEntry(POD, { translation: 'Ein Pod\n---\nist klein.' })
    const result = composeLocale(slidesOnly(entries))
    expect(deckOf(result).match(/^---$/gm)?.length).toBe(DECK.match(/^---$/gm)?.length)
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: 'unspliceable', unitId: POD, detail: 'slide-separator' }),
    )
  })

  it('falls back when a translation changes the structure around it', () => {
    const entries = withEntry(POD, { translation: 'Ein Pod.\n\nIst klein.' })
    const result = composeLocale(slidesOnly(entries))
    expect(deckOf(result)).not.toContain('Ist klein')
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'skeleton-mismatch', unitId: POD }),
    )
    expect(composeLocale(slidesOnly(entries, 'strict')).releasable).toBe(false)
  })

  it('warns, without falling back, on a translation over its layout budget', () => {
    const entries = withEntry(HEADING, {
      translation: 'Herzlich willkommen im großen Kubernetes-Workshop',
    })
    const result = composeLocale(slidesOnly(entries, 'strict'))
    expect(result.releasable).toBe(true)
    expect(deckOf(result)).toContain('großen')
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'length-budget', unitId: HEADING }),
    ])
  })
})

describe('FR-001: every surface composes', () => {
  it('composes labs and quiz banks analogously', () => {
    const result = composeLocale({
      manifest: MANIFEST,
      locale: 'de',
      files: FILES,
      catalogs: [
        catalog('de', 'labs', [
          {
            id: 'labs:lab-one:body/h1-1/p-1',
            source: 'Do the thing with kubectl.',
            translation: 'Erledige es mit kubectl.',
          },
        ]),
        catalog('de', 'quiz', [
          {
            id: 'quiz:S01-Q-ONE-01:prompt',
            source: 'What is a Pod?',
            translation: 'Was ist ein "Pod"?',
          },
        ]),
      ],
    })
    const lab = result.files.find((file) => file.path === 'labs/one.md')?.text ?? ''
    const quiz = result.files.find((file) => file.path === 'quiz/bank.json')?.text ?? ''
    expect(lab).toContain('Erledige es mit kubectl.')
    expect(lab).toContain('kubectl apply -f pod.yaml')
    expect(JSON.parse(quiz).questions[0].prompt).toBe('Was ist ein "Pod"?')
    expect(JSON.parse(quiz).questions[0].explanation).toBe(
      `${FALLBACK_MARKER}Pods group containers.`,
    )
    expect(JSON.parse(quiz).questions[0].answer).toBe('a')
    expect(result.files.map((file) => file.path)).toEqual([
      'labs/one.md',
      'quiz/bank.json',
      'slides/intro.md',
    ])
  })

  it('copies a file whose English cannot be extracted, and fails on it', () => {
    const broken = DECK.replace('slideId: second\n', '')
    const input = {
      ...slidesOnly(REVIEWED),
      files: [{ path: 'slides/intro.md', surface: 'slides', text: broken }],
    } as const
    const preview = composeLocale(input)
    expect(deckOf(preview)).toBe(broken)
    expect(preview.findings).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'extraction',
        detail: 'missing-slide-id',
      }),
    )
    expect(composeLocale({ ...input, mode: 'strict' }).files).toEqual([])
  })
})

describe('FR-006: deterministic and pure', () => {
  it('yields a deep-equal result for the same input', () => {
    const input = { ...slidesOnly(withEntry(POD, { flags: ['fuzzy'] })), files: FILES }
    expect(composeLocale(input)).toEqual(composeLocale(input))
  })

  it('does not depend on the order files or catalogs are given in', () => {
    const catalogs = [
      catalog('de', 'a', REVIEWED.slice(0, 2)),
      catalog('de', 'b', REVIEWED.slice(2)),
    ]
    const forward = composeLocale({ ...slidesOnly([]), files: FILES, catalogs })
    const reverse = composeLocale({
      ...slidesOnly([]),
      files: [...FILES].reverse(),
      catalogs: [...catalogs].reverse(),
    })
    expect(reverse).toEqual(forward)
  })
})

describe('input that makes composition ill-defined is refused', () => {
  it.each([
    ['a locale the manifest does not target', { locale: 'fr' }],
    [
      'a catalog of another locale',
      { catalogs: [emptyCatalog({ locale: 'pt-BR', name: 'slides' })] },
    ],
    ['an absolute path', { files: [{ path: '/etc/slides.md', surface: 'slides', text: DECK }] }],
    [
      'a path escaping the tree',
      { files: [{ path: 'slides/../../x.md', surface: 'slides', text: DECK }] },
    ],
    [
      'the same path twice',
      {
        files: [
          { path: 'a.md', surface: 'slides', text: DECK },
          { path: 'a.md', surface: 'slides', text: DECK },
        ],
      },
    ],
    [
      'one unit in two files',
      {
        files: [
          { path: 'a.md', surface: 'slides', text: DECK },
          { path: 'b.md', surface: 'slides', text: DECK },
        ],
      },
    ],
    [
      'one unit in two catalogs',
      { catalogs: [catalog('de', 'a', REVIEWED), catalog('de', 'b', REVIEWED.slice(0, 1))] },
    ],
  ] as const)('%s', (_label, change) => {
    expect(() =>
      composeLocale({ ...slidesOnly(REVIEWED), ...change } as ComposeLocaleInput),
    ).toThrow(ComposeInputError)
  })

  it('a quiz file when the manifest declares no quiz surface', () => {
    const manifest = {
      ...MANIFEST,
      surfaces: MANIFEST.surfaces.filter((spec) => spec.surface !== 'quiz'),
    }
    expect(() =>
      composeLocale({ ...slidesOnly([]), manifest, files: [FILES[2] as SourceFile] }),
    ).toThrow(/surfaces\.quiz/)
  })
})
