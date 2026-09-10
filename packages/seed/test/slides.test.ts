import { formatUnitId } from '@workshop-i18n/core'
import { extractSlidevFile } from '@workshop-i18n/extract-slidev'
import { describe, expect, it } from 'vitest'
import { alignSlides } from '../src/slides.js'
import { type SectionAlignment, SeedInputError } from '../src/types.js'

const EN = `---
slideId: s05-title
title: Pods
---

# One Pod

A Pod is small.

<!--
Speaker: say it slowly.
-->

---
slideId: s05-yaml
layout: two-cols
---

## The manifest

\`\`\`yaml
# the smallest pod
kind: Pod
\`\`\`

Apply it.

---
slideId: s05-recap
---

# Recap

- Pods are atoms.
- Deployments make Pods.
`

/** The same deck translated in place, without ids — the shape of PR #55. */
const PT = `---
title: Pods (pt)
---

# Um Pod

Um Pod é pequeno.

<!--
Speaker: fale devagar.
-->

---
layout: two-cols
---

## O manifesto

\`\`\`yaml
# o menor pod
kind: Pod
\`\`\`

Aplique-o.

---

# Recapitulação

- Pods são átomos.
- Deployments criam Pods.
`

const file = (path: string, text: string) => ({ path, text })

function only(sections: readonly SectionAlignment[]): SectionAlignment {
  expect(sections).toHaveLength(1)
  return sections[0] as SectionAlignment
}

function englishIds(text: string): string[] {
  return extractSlidevFile(text)
    .units.map((unit) => formatUnitId(unit.id))
    .sort()
}

function accounted(section: SectionAlignment): string[] {
  return [
    ...section.drafts.map((draft) => formatUnitId(draft.id)),
    ...section.misses.flatMap((miss) => miss.unitIds),
  ].sort()
}

describe('alignSlides', () => {
  it('aligns a structurally matching translated deck onto the English slide ids (AS-1)', () => {
    const result = alignSlides([file('S05.md', EN)], [file('S05.md', PT)])
    const section = only(result.sections)
    expect(section.surface).toBe('slides')
    expect(section.section).toBe('S05.md')
    expect(section.misses).toEqual([])
    expect(section.englishUnits).toBe(englishIds(EN).length)
    const byId = Object.fromEntries(
      section.drafts.map((draft) => [formatUnitId(draft.id), draft.translation]),
    )
    expect(byId).toMatchObject({
      'slides:s05-title:fm/title': 'Pods (pt)',
      'slides:s05-title:body/h1-1/title': 'Um Pod',
      'slides:s05-title:note/p-1': 'Speaker: fale devagar.',
      'slides:s05-yaml:body/h2-1/p-1': 'Aplique-o.',
      'slides:s05-recap:body/h1-1/l-1/li-2/p-1': 'Deployments criam Pods.',
    })
    expect(result.unpairedTranslated).toEqual([])
  })

  it('reports a translated fence comment as skeleton divergence and never imports it', () => {
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', PT)]).sections)
    expect(section.skeletonDivergence).toEqual({ fence: 1, html: 0, other: 0 })
    expect(JSON.stringify(section.drafts)).not.toContain('o menor pod')
  })

  it('misses a slide whose frontmatter machinery diverged, and lists it (AS-2)', () => {
    const diverged = PT.replace('layout: two-cols', 'layout: center')
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', diverged)]).sections)
    expect(section.misses).toEqual([
      {
        reason: 'structure-diverged',
        containerId: 's05-yaml',
        unitIds: ['slides:s05-yaml:body/h2-1/p-1', 'slides:s05-yaml:body/h2-1/title'],
        detail: expect.stringContaining('frontmatter'),
      },
    ])
    expect(section.drafts.some((draft) => draft.id.containerId === 's05-yaml')).toBe(false)
    expect(section.drafts.some((draft) => draft.id.containerId === 's05-recap')).toBe(true)
  })

  it('misses a slide whose fenced-block count diverged', () => {
    const diverged = PT.replace('Aplique-o.', 'Aplique-o.\n\n```sh\nkubectl apply\n```')
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', diverged)]).sections)
    expect(section.misses.map((miss) => [miss.reason, miss.containerId])).toEqual([
      ['structure-diverged', 's05-yaml'],
    ])
  })

  it('misses a slide whose body structure diverged, and keeps the rest', () => {
    const diverged = PT.replace(
      '- Deployments criam Pods.\n',
      '- Deployments criam Pods.\n- Extra.\n',
    )
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', diverged)]).sections)
    expect(section.misses.map((miss) => [miss.reason, miss.containerId])).toEqual([
      ['structure-diverged', 's05-recap'],
    ])
    expect(section.drafts.length).toBeGreaterThan(0)
  })

  it('misses the whole file when the slide counts differ — ordinal pairing is never attempted', () => {
    const extra = `${PT}\n---\n\n# Slide extra\n`
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', extra)]).sections)
    expect(section.drafts).toEqual([])
    expect(section.misses).toEqual([
      {
        reason: 'slide-count-mismatch',
        containerId: undefined,
        unitIds: englishIds(EN),
        detail: expect.stringMatching(/3 slides.*4/),
      },
    ])
  })

  it('misses a file the translated tree does not have', () => {
    const result = alignSlides([file('S05.md', EN)], [])
    const section = only(result.sections)
    expect(section.misses.map((miss) => miss.reason)).toEqual(['no-translated-file'])
    expect(accounted(section)).toEqual(englishIds(EN))
  })

  it('accepts translated slide ids that agree with the English, and misses one that conflicts', () => {
    const agreeing = PT.replace('title: Pods (pt)', 'slideId: s05-title\ntitle: Pods (pt)')
    expect(
      only(alignSlides([file('S05.md', EN)], [file('S05.md', agreeing)]).sections).misses,
    ).toEqual([])

    const conflicting = PT.replace('title: Pods (pt)', 'slideId: s05-other\ntitle: Pods (pt)')
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', conflicting)]).sections)
    expect(section.misses.map((miss) => [miss.reason, miss.containerId])).toEqual([
      ['container-id-conflict', 's05-title'],
    ])
    expect(accounted(section)).toEqual(englishIds(EN))
  })

  it('misses a translated file whose unclosed frontmatter swallowed a slide', () => {
    const broken = PT.replace('layout: two-cols\n---', 'layout: two-cols')
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', broken)]).sections)
    expect(section.drafts).toEqual([])
    expect(section.misses.map((miss) => miss.reason)).toEqual(['slide-count-mismatch'])
  })

  it('misses a translated file with a Slidev error diagnostic', () => {
    const broken = PT.replace('layout: two-cols\n---', 'layout: two-cols\n-----x\n---')
    const section = only(alignSlides([file('S05.md', EN)], [file('S05.md', broken)]).sections)
    expect(section.misses.map((miss) => miss.reason)).toEqual(['unreadable-translation'])
    expect(accounted(section)).toEqual(englishIds(EN))
  })

  it('refuses an oversized translated file without reading it', () => {
    const section = only(
      alignSlides([file('S05.md', EN)], [file('S05.md', PT)], {
        limits: { maxFileLength: 10 },
      }).sections,
    )
    expect(section.misses.map((miss) => miss.reason)).toEqual(['translated-file-too-large'])
  })

  it('lists translated files with no English counterpart and never reads them', () => {
    const result = alignSlides([file('S05.md', EN)], [file('S05.md', PT), file('extra.md', '---')])
    expect(result.unpairedTranslated).toEqual(['extra.md'])
  })

  it('throws on English that has not been through init-ids', () => {
    expect(() => alignSlides([file('S05.md', PT)], [file('S05.md', PT)])).toThrow(SeedInputError)
  })

  it('throws on duplicate paths in either tree', () => {
    expect(() => alignSlides([file('a.md', EN), file('a.md', EN)], [])).toThrow(SeedInputError)
    expect(() => alignSlides([file('a.md', EN)], [file('a.md', PT), file('a.md', PT)])).toThrow(
      SeedInputError,
    )
  })

  it('refuses more translated files than the limit allows', () => {
    expect(() =>
      alignSlides([file('a.md', EN)], [file('a.md', PT), file('b.md', PT)], {
        limits: { maxFiles: 1 },
      }),
    ).toThrow(SeedInputError)
  })

  describe('position pairing must be provable, never assumed', () => {
    /** Four slides of identical shape: nothing but prose tells them apart. */
    const lookalikes = (titles: readonly string[], ids?: readonly string[]) =>
      titles
        .map(
          (title, index) =>
            `---\n${ids === undefined ? '' : `slideId: ${ids[index]}\n`}layout: default\n---\n\n# ${title}\n\n${title} body.\n`,
        )
        .join('\n')
    const IDS = ['s-a', 's-b', 's-c', 's-d']
    const englishDeck = lookalikes(['Alpha', 'Beta', 'Gamma', 'Delta'], IDS)

    it('misses indistinguishable slides when one is dropped and another appended', () => {
      const translated = lookalikes(['Alfa', 'Gama', 'Delta pt', 'Novo'])
      const section = only(
        alignSlides([file('d.md', englishDeck)], [file('d.md', translated)]).sections,
      )
      expect(section.drafts).toEqual([])
      expect(section.misses.map((miss) => [miss.reason, miss.containerId])).toEqual(
        IDS.map((id) => ['ambiguous-position', id]),
      )
    })

    it('misses indistinguishable slides when two are swapped', () => {
      const translated = lookalikes(['Beta pt', 'Alfa', 'Gama', 'Delta pt'])
      const section = only(
        alignSlides([file('d.md', englishDeck)], [file('d.md', translated)]).sections,
      )
      expect(section.drafts).toEqual([])
    })

    /** Four slides a translator cannot change the fingerprint of: each has its own command. */
    const distinct = (commands: readonly string[], ids?: readonly string[]) =>
      commands
        .map(
          (command, index) =>
            `---\n${ids === undefined ? '' : `slideId: ${ids[index]}\n`}---\n\n# Step\n\nRun \`${command}\`.\n`,
        )
        .join('\n')
    const englishSteps = distinct(
      ['kubectl get', 'kubectl apply', 'kubectl delete', 'kubectl logs'],
      IDS,
    )

    it('pairs distinguishable slides, and misses the ones a drop-and-add shifted', () => {
      const translated = distinct(['kubectl get', 'kubectl delete', 'kubectl logs', 'kubectl exec'])
        .replaceAll('# Step', '# Passo')
        .replaceAll('Run', 'Execute')
      const section = only(
        alignSlides([file('d.md', englishSteps)], [file('d.md', translated)]).sections,
      )
      expect(section.drafts.map((draft) => draft.id.containerId)).toEqual(['s-a', 's-a'])
      expect(section.misses.map((miss) => [miss.reason, miss.containerId])).toEqual([
        ['structure-diverged', 's-b'],
        ['structure-diverged', 's-c'],
        ['structure-diverged', 's-d'],
      ])
      expect(section.misses[0]?.detail).toContain('code')
    })

    it('misses a swapped pair of distinguishable slides and keeps the rest', () => {
      const translated = distinct([
        'kubectl apply',
        'kubectl get',
        'kubectl delete',
        'kubectl logs',
      ])
        .replaceAll('# Step', '# Passo')
        .replaceAll('Run', 'Execute')
      const section = only(
        alignSlides([file('d.md', englishSteps)], [file('d.md', translated)]).sections,
      )
      expect([...new Set(section.drafts.map((draft) => draft.id.containerId))]).toEqual([
        's-c',
        's-d',
      ])
    })
  })

  it('aligns a CRLF translation of an LF deck without carrying carriage returns into drafts', () => {
    const multiline = EN.replace('A Pod is small.', 'A Pod is\nsmall.')
    const crlf = PT.replace('Um Pod é pequeno.', 'Um Pod é\npequeno.').replaceAll('\n', '\r\n')
    const section = only(alignSlides([file('S05.md', multiline)], [file('S05.md', crlf)]).sections)
    expect(section.misses).toEqual([])
    expect(section.drafts.map((draft) => draft.translation)).toContain('Um Pod é\npequeno.')
    expect(section.drafts.some((draft) => draft.translation.includes('\r'))).toBe(false)
  })

  it('is deterministic and independent of input order', () => {
    const second = EN.replaceAll('s05-', 's06-')
    const a = alignSlides(
      [file('S05.md', EN), file('S06.md', second)],
      [file('S06.md', PT), file('S05.md', PT)],
    )
    const b = alignSlides(
      [file('S06.md', second), file('S05.md', EN)],
      [file('S05.md', PT), file('S06.md', PT)],
    )
    expect(a).toEqual(b)
    expect(a.sections.map((section) => section.section)).toEqual(['S05.md', 'S06.md'])
  })
})
