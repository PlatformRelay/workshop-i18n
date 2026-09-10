/**
 * Golden counts over the vendored slice of Kubernetes-Workshop PR #55 (see
 * `fixtures/PROVENANCE.md`, `corpus-k8s-pt-BR/`), seeded against the English fixtures
 * of the same files. Spec 004's independent test: "seed against a fixture snapshot of
 * the pt-BR tree; alignment report matches golden counts; no entry enters as reviewed".
 *
 * The slice is chosen for what it makes seeding do, not for volume:
 *
 * - `S12-statefulset` — a speaker note translating the tag-shaped placeholder
 *   `web-<newhash>` to `web-<novohash>`, which a renderer reads as a new element
 *   (`markup-divergence`), next to translated `<KwCard>` prose that is HTML skeleton and
 *   must not be imported;
 * - `S20-helm` — one speaker note whose re-wrapped translation starts a line with `+ `,
 *   which Markdown reads as a list item: an accidental structure change that must miss
 *   that note (`structure-diverged`, AS-2) and nothing else; and a slide whose code span
 *   the translator translated inside the backticks, so its fingerprint cannot prove it is
 *   the English slide at that position and it misses whole (ADR 0016);
 * - `S19-rbac` — translated comments inside multi-document YAML fences;
 * - `S24-kubebuilder` and `day-3-24-kubebuilder` — the degenerate small files, where most
 *   units were left in English (`identical-to-source`, reported and never seeded);
 * - `day-1-08-ingress` — in-fence `---` document separators with translated comments;
 * - `labs-README` — a file in the labs tree that is not a lab;
 * - `S09-gateway-api` — deliberately *absent* from the pt-BR slice (`no-translated-file`);
 * - `quiz/questions.json` — six of the 54 questions, so 48 are `question-missing`.
 *
 * The counts were cross-checked against the full corpus run (every deck, lab and question
 * of PR #55), where the same rules align 84.4% of the English units.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Catalog,
  NEEDS_REVIEW_FLAG,
  serializeCatalog,
  updateCatalog,
} from '@workshop-i18n/catalog-po'
import { formatUnitId } from '@workshop-i18n/core'
import { extractLabFile, planLabId } from '@workshop-i18n/extract-markdown'
import { extractQuizFile } from '@workshop-i18n/extract-quiz'
import { extractSlidevFile, planSlideIds } from '@workshop-i18n/extract-slidev'
import { describe, expect, it } from 'vitest'
import { SEED_COMMENT_KEY } from '../src/apply.js'
import { formatSeedReport, type SeedCounts } from '../src/report.js'
import { type SeedInput, seed } from '../src/seed.js'
import type { SeedFile } from '../src/types.js'

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url))
const read = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8')
const PROVENANCE = 'Kubernetes-Workshop PR #55 by João Brito (@juniorjbn)'

const DECKS = ['S09-gateway-api', 'S12-statefulset', 'S19-rbac', 'S20-helm', 'S24-kubebuilder']
const TRANSLATED_DECKS = DECKS.filter((name) => name !== 'S09-gateway-api')
const LABS = [
  'day-1-08-ingress',
  'day-2-12-statefulset.solution',
  'day-3-24-kubebuilder',
  'labs-README',
]

/** The English fixtures are verbatim and pre-`init-ids`; adopt them in memory. */
const englishSlides: readonly SeedFile[] = DECKS.map((name) => {
  const plan = planSlideIds(read(`corpus-k8s/${name}.md`), { sectionId: name.toLowerCase() })
  return { path: `${name}.md`, text: plan.text }
})
const englishLabs: readonly SeedFile[] = LABS.map((name) => {
  const plan = planLabId(read(`corpus-k8s-labs/${name}.md`), { pathStem: name })
  return { path: `${name}.md`, text: plan.text }
})
const englishQuiz: readonly SeedFile[] = [
  { path: 'questions.json', text: read('corpus-quiz/kubernetes-workshop.questions.json') },
]

const translated = {
  slides: TRANSLATED_DECKS.map((name) => ({
    path: `${name}.md`,
    text: read(`corpus-k8s-pt-BR/slides/${name}.md`),
  })),
  labs: LABS.map((name) => ({
    path: `${name}.md`,
    text: read(`corpus-k8s-pt-BR/labs/${name}.md`),
  })),
  quiz: [{ path: 'questions.json', text: read('corpus-k8s-pt-BR/quiz/questions.json') }],
}

function freshCatalogs(): Catalog[] {
  const catalog = (name: string, units: Parameters<typeof updateCatalog>[0]['units']) =>
    updateCatalog({ identity: { locale: 'pt-BR', name }, units }).catalog
  return [
    catalog(
      'slides',
      englishSlides.flatMap((file) => extractSlidevFile(file.text).units),
    ),
    catalog(
      'labs',
      englishLabs.flatMap((file) => extractLabFile(file.text).units),
    ),
    catalog(
      'quiz',
      extractQuizFile(englishQuiz[0]?.text ?? '', { schema: 'kubernetes-workshop' }).units,
    ),
  ]
}

function input(catalogs: readonly Catalog[]): SeedInput {
  return {
    locale: 'pt-BR',
    provenance: PROVENANCE,
    slides: { english: englishSlides, translated: translated.slides },
    labs: { english: englishLabs, translated: translated.labs },
    quiz: { english: englishQuiz, translated: translated.quiz, schema: 'kubernetes-workshop' },
    catalogs,
  }
}

const first = seed(input(freshCatalogs()))

/** The counters that matter for a golden, without the all-zero noise. */
function golden(counts: SeedCounts) {
  const nonZero = (record: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(record).filter(([, count]) => count > 0))
  return {
    englishUnits: counts.englishUnits,
    aligned: counts.aligned,
    missReasons: nonZero(counts.missReasons),
  }
}

describe('seeding the PR #55 fixture slice', () => {
  it('matches the golden per-section counts', () => {
    const sections = Object.fromEntries(
      first.report.surfaces.flatMap((surface) =>
        surface.sections.map((section) => [
          `${surface.surface}/${section.section}`,
          golden(section),
        ]),
      ),
    )
    expect(sections).toMatchInlineSnapshot(`
      {
        "labs/day-1-08-ingress.md": {
          "aligned": 58,
          "englishUnits": 72,
          "missReasons": {
            "identical-to-source": 14,
          },
        },
        "labs/day-2-12-statefulset.solution.md": {
          "aligned": 64,
          "englishUnits": 73,
          "missReasons": {
            "identical-to-source": 9,
          },
        },
        "labs/day-3-24-kubebuilder.md": {
          "aligned": 3,
          "englishUnits": 10,
          "missReasons": {
            "identical-to-source": 7,
          },
        },
        "labs/labs-README.md": {
          "aligned": 77,
          "englishUnits": 97,
          "missReasons": {
            "identical-to-source": 20,
          },
        },
        "quiz/questions.json": {
          "aligned": 48,
          "englishUnits": 432,
          "missReasons": {
            "question-missing": 384,
          },
        },
        "slides/S09-gateway-api.md": {
          "aligned": 0,
          "englishUnits": 67,
          "missReasons": {
            "no-translated-file": 67,
          },
        },
        "slides/S12-statefulset.md": {
          "aligned": 40,
          "englishUnits": 46,
          "missReasons": {
            "identical-to-source": 5,
            "markup-divergence": 1,
          },
        },
        "slides/S19-rbac.md": {
          "aligned": 50,
          "englishUnits": 60,
          "missReasons": {
            "identical-to-source": 10,
          },
        },
        "slides/S20-helm.md": {
          "aligned": 54,
          "englishUnits": 70,
          "missReasons": {
            "identical-to-source": 11,
            "structure-diverged": 5,
          },
        },
        "slides/S24-kubebuilder.md": {
          "aligned": 6,
          "englishUnits": 10,
          "missReasons": {
            "identical-to-source": 4,
          },
        },
      }
    `)
  })

  it('matches the golden totals', () => {
    expect(golden(first.report.totals)).toMatchInlineSnapshot(`
      {
        "aligned": 400,
        "englishUnits": 937,
        "missReasons": {
          "identical-to-source": 80,
          "markup-divergence": 1,
          "no-translated-file": 67,
          "question-missing": 384,
          "structure-diverged": 5,
        },
      }
    `)
    expect(first.report.totals.outcomes.seeded).toBe(first.report.totals.aligned)
  })

  it('lands every seeded unit as needs-review with provenance naming PR #55 (AS-1)', () => {
    let seeded = 0
    for (const catalog of first.catalogs) {
      for (const entry of catalog.entries) {
        expect(entry.state).not.toBe('reviewed')
        if (entry.state === 'missing') continue
        seeded += 1
        expect(entry.state).toBe('needs-review')
        expect(entry.po.flags).toContain(NEEDS_REVIEW_FLAG)
        expect(entry.po.comments).toContainEqual({
          marker: '.',
          text: ` ${SEED_COMMENT_KEY}: ${PROVENANCE}`,
        })
      }
    }
    expect(seeded).toBe(first.report.totals.aligned)
  })

  it('leaves the restructured S20 speaker note missing and lists its slide (AS-2)', () => {
    const helm = first.report.surfaces[0]?.sections.find(
      (section) => section.section === 'S20-helm.md',
    )
    const miss = helm?.misses.find(
      (item) =>
        item.reason === 'structure-diverged' &&
        item.containerId === 's20-helm-two-ways-to-ship-a-chart',
    )
    expect(miss?.unitIds).toEqual(['slides:s20-helm-two-ways-to-ship-a-chart:note/p-1'])
    expect(miss?.containerId).toBe('s20-helm-two-ways-to-ship-a-chart')
    expect(formatSeedReport(first.report)).toContain('s20-helm-two-ways-to-ship-a-chart')
    const slides = first.catalogs[0] as Catalog
    for (const id of miss?.unitIds ?? []) {
      expect(slides.entries.find((entry) => formatUnitId(entry.id) === id)?.state).toBe('missing')
    }
  })

  it('refuses the S12 translation that adds markup, and imports no fence or HTML skeleton', () => {
    const statefulset = first.report.surfaces[0]?.sections.find(
      (section) => section.section === 'S12-statefulset.md',
    )
    expect(statefulset?.missReasons['markup-divergence']).toBe(1)
    expect(first.report.totals.skeletonDivergence.fence).toBeGreaterThan(0)
    expect(first.report.totals.skeletonDivergence.html).toBeGreaterThan(0)
    for (const catalog of first.catalogs) {
      for (const entry of catalog.entries) {
        expect(entry.translation).not.toContain('```')
        expect(entry.translation).not.toMatch(/<KwCard/)
      }
    }
  })

  it('never overwrites a human-touched entry on a re-run, and is otherwise a zero-byte change (AS-3)', () => {
    const catalogs = first.catalogs.map((catalog) => ({
      ...catalog,
      entries: catalog.entries.map((entry) =>
        entry.state === 'needs-review' && entry.id.unitKey === 'prompt'
          ? {
              ...entry,
              state: 'reviewed' as const,
              translation: `${entry.translation} (revisado)`,
              po: {
                ...entry.po,
                flags: [],
                msgstr: [`${entry.translation} (revisado)`],
              },
            }
          : entry,
      ),
    }))
    const again = seed(input(catalogs))
    expect(again.report.totals.outcomes.seeded).toBe(0)
    expect(again.report.totals.outcomes['kept-human']).toBe(6)
    again.catalogs.forEach((catalog, index) => {
      expect(serializeCatalog(catalog)).toBe(serializeCatalog(catalogs[index] as Catalog))
    })
  })
})
