import { formatUnitId } from '@workshop-i18n/core'
import { extractLabFile } from '@workshop-i18n/extract-markdown'
import { describe, expect, it } from 'vitest'
import { alignLabs } from '../src/labs.js'
import { type SectionAlignment, SeedInputError } from '../src/types.js'

const EN = `# Lab 05 — Pod

<!-- labId: day-1-05-pod -->

Build a Pod and watch it run.

## Task 1 — Write the manifest

Create \`pod.yaml\`:

\`\`\`yaml
# the smallest pod
kind: Pod
\`\`\`

## Task 2 — Apply it

Run the command and wait.

<div class="tip">Watch the events.</div>

<details><summary>Solution</summary>

Apply it with kubectl.

</details>
`

const PT = `# Lab 05 — Pod

Construa um Pod e observe-o rodando.

## Tarefa 1 — Escreva o manifesto

Crie \`pod.yaml\`:

\`\`\`yaml
# o menor pod
kind: Pod
\`\`\`

## Tarefa 2 — Aplique

Execute o comando e aguarde.

<div class="tip">Observe os eventos.</div>

<details><summary>Solução</summary>

Aplique com kubectl.

</details>
`

const file = (path: string, text: string) => ({ path, text })

function only(sections: readonly SectionAlignment[]): SectionAlignment {
  expect(sections).toHaveLength(1)
  return sections[0] as SectionAlignment
}

const englishIds = (text: string) =>
  extractLabFile(text)
    .units.map((unit) => formatUnitId(unit.id))
    .sort()

function accounted(section: SectionAlignment): string[] {
  return [
    ...section.drafts.map((draft) => formatUnitId(draft.id)),
    ...section.misses.flatMap((miss) => miss.unitIds),
  ].sort()
}

describe('alignLabs', () => {
  it('aligns a structurally matching translated lab onto the English labId (AS-1)', () => {
    const section = only(
      alignLabs([file('day-1/05-pod.md', EN)], [file('day-1/05-pod.md', PT)]).sections,
    )
    expect(section.surface).toBe('labs')
    const byId = Object.fromEntries(
      section.drafts.map((draft) => [formatUnitId(draft.id), draft.translation]),
    )
    expect(byId).toMatchObject({
      'labs:day-1-05-pod:body/h1-1/p-1': 'Construa um Pod e observe-o rodando.',
      'labs:day-1-05-pod:body/h1-1/h2-2/title': 'Tarefa 2 — Aplique',
    })
    // The H1 was left in English by the translator: reported, not seeded.
    expect(section.misses.map((miss) => [miss.reason, miss.unitIds])).toEqual([
      ['identical-to-source', ['labs:day-1-05-pod:body/h1-1/title']],
    ])
    expect(accounted(section)).toEqual(englishIds(EN))
  })

  it('reports translated fence comments and HTML-trapped prose as skeleton divergence, never as drafts', () => {
    const section = only(alignLabs([file('a.md', EN)], [file('a.md', PT)]).sections)
    expect(section.skeletonDivergence).toEqual({ fence: 1, html: 1, other: 0 })
    expect(JSON.stringify(section.drafts)).not.toContain('o menor pod')
    expect(JSON.stringify(section.drafts)).not.toContain('Observe os eventos')
    // A spoiler summary *is* prose the extractor locates, so it is aligned like any unit.
    expect(section.drafts.map((draft) => draft.translation)).toContain('Solução')
  })

  it('misses only the heading scope whose blocks diverged', () => {
    const diverged = PT.replace('Execute o comando e aguarde.', 'Execute o comando.\n\nE aguarde.')
    const section = only(alignLabs([file('a.md', EN)], [file('a.md', diverged)]).sections)
    expect(section.misses.find((miss) => miss.reason === 'structure-diverged')?.detail).toContain(
      'body/h1-1/h2-2',
    )
    expect(section.drafts.some((draft) => draft.id.unitKey.startsWith('body/h1-1/h2-1/'))).toBe(
      true,
    )
    expect(accounted(section)).toEqual(englishIds(EN))
  })

  it('misses the whole body when a heading was added — later scopes are re-keyed', () => {
    const diverged = PT.replace('## Tarefa 2', '## Extra\n\nTexto.\n\n## Tarefa 2')
    const section = only(alignLabs([file('a.md', EN)], [file('a.md', diverged)]).sections)
    expect(section.drafts).toEqual([])
    expect(section.misses.map((miss) => miss.reason)).toEqual(['structure-diverged'])
  })

  it('honours an agreeing labId in the translation and misses a conflicting one', () => {
    const agreeing = PT.replace(
      '# Lab 05 — Pod\n',
      '# Lab 05 — Pod\n\n<!-- labId: day-1-05-pod -->\n',
    )
    expect(
      only(alignLabs([file('a.md', EN)], [file('a.md', agreeing)]).sections).drafts,
    ).not.toEqual([])
    const conflicting = PT.replace('# Lab 05 — Pod\n', '# Lab 05 — Pod\n\n<!-- labId: other -->\n')
    const section = only(alignLabs([file('a.md', EN)], [file('a.md', conflicting)]).sections)
    expect(section.drafts).toEqual([])
    expect(section.misses.map((miss) => miss.reason)).toEqual(['container-id-conflict'])
  })

  it('misses a translated lab that declares two identities', () => {
    const broken = PT.replace(
      '# Lab 05 — Pod\n',
      '# Lab 05 — Pod\n\n<!-- labId: a -->\n<!-- labId: b -->\n',
    )
    const section = only(alignLabs([file('a.md', EN)], [file('a.md', broken)]).sections)
    expect(section.misses.map((miss) => miss.reason)).toEqual(['unreadable-translation'])
  })

  it('misses a lab the translated tree does not have, and one that is too large', () => {
    expect(only(alignLabs([file('a.md', EN)], []).sections).misses[0]?.reason).toBe(
      'no-translated-file',
    )
    expect(
      only(
        alignLabs([file('a.md', EN)], [file('a.md', PT)], { limits: { maxFileLength: 5 } })
          .sections,
      ).misses[0]?.reason,
    ).toBe('translated-file-too-large')
  })

  it('throws on an English lab that has not been through init-ids', () => {
    expect(() => alignLabs([file('a.md', PT)], [file('a.md', PT)])).toThrow(SeedInputError)
  })
})
