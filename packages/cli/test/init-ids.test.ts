import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { labPathStem, slideSectionId } from '../src/init-ids.js'
import { invoke, MemoryFileSystem } from './memory-fs.js'

const MANIFEST = `apiVersion: workshop-i18n/v1
locales:
  targets: [pt-BR]
surfaces:
  slides:
    include: ['pages/**/index.md']
  labs:
    include: ['labs/**/*.md']
  quiz:
    include: ['quiz/questions.json']
    schema: kubernetes-workshop
`

const POD_SLIDES = [
  '---',
  'layout: section-cover',
  'heading: What runs your container?',
  '---',
  '',
  '# Pods',
  '',
  'A Pod wraps one or more containers.',
  '',
  '---',
  '',
  '# Pod lifecycle',
  '',
  'Pending, Running, Succeeded.',
  '',
].join('\n')

const POD_LAB = ['# Lab 05 — Pod (S05)', '', 'Run a Pod.', ''].join('\n')

function quiz(ids: readonly string[]): string {
  const questions = ids.map((id) => ({
    id,
    section: id.slice(0, 3),
    prompt: `Question ${id}?`,
    options: [
      { id: 'a', text: 'A', rationale: 'Because A.' },
      { id: 'b', text: 'B', rationale: 'Because B.' },
    ],
    answer: 'a',
    explanation: 'A is right.',
    difficulty: 'easy',
    references: ['https://kubernetes.io/'],
    learningObjective: 'Know A.',
  }))
  return `${JSON.stringify({ schemaVersion: 1, questions }, null, 2)}\n`
}

function corpus(): MemoryFileSystem {
  return new MemoryFileSystem({
    '/repo/.localization/workshop.yaml': MANIFEST,
    '/repo/pages/S05-pod/index.md': POD_SLIDES,
    '/repo/labs/day-1/05-pod.md': POD_LAB,
    '/repo/quiz/questions.json': quiz(['S05-Q-POD-01', 'S05-Q-POD-02']),
  })
}

/** Remove every line the codemod may add; what remains must be the original bytes. */
function withoutIdLines(text: string): string {
  return text
    .replace(/^slideId: .*\n/gm, '')
    .replace(/\n<!-- labId: .* -->\n/g, '')
    .replace(/^---\n---\n/gm, '---\n')
}

describe('slideSectionId / labPathStem', () => {
  it('names a slide section after its directory when the file is an index', () => {
    expect(
      slideSectionId({ surface: 'slides', path: 'pages/S05-pod/index.md', base: 'pages' }),
    ).toBe('S05-pod')
    expect(slideSectionId({ surface: 'slides', path: 'decks/intro.md', base: 'decks' })).toBe(
      'intro',
    )
  })

  it('stems a lab by its path below the glob base, without the extension', () => {
    expect(labPathStem({ surface: 'labs', path: 'labs/day-1/05-pod.md', base: 'labs' })).toBe(
      'day-1/05-pod',
    )
    expect(
      labPathStem({ surface: 'labs', path: 'labs/day-1/05-pod.solution.md', base: 'labs' }),
    ).toBe('day-1/05-pod.solution')
  })
})

describe('init-ids (spec 001 US-1)', () => {
  it('inserts a slideId per slide and a labId per lab, changing no other byte (AS-1)', () => {
    const fs = corpus()
    const result = invoke(fs, ['init-ids'])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(EXIT.OK)

    const slides = fs.text('/repo/pages/S05-pod/index.md')
    expect(slides).toContain('slideId: s05-pod-what-runs-your-container\n')
    expect(slides).toContain('---\nslideId: s05-pod-pod-lifecycle\n---\n')
    expect(withoutIdLines(slides)).toBe(POD_SLIDES)

    const lab = fs.text('/repo/labs/day-1/05-pod.md')
    expect(lab).toBe(
      ['# Lab 05 — Pod (S05)', '', '<!-- labId: day-1-05-pod -->', '', 'Run a Pod.', ''].join('\n'),
    )

    expect(result.stdout).toContain('slides: 1 file, 2 slides, 2 ids added')
    expect(result.stdout).toContain('labs: 1 file, 1 lab, 1 id added')
    expect(result.stdout).toContain('quiz: 1 file, 2 questions (ids are authored, checked only)')
  })

  it('never writes the quiz: question ids are the consumer schema’s, not ours', () => {
    const fs = corpus()
    invoke(fs, ['init-ids'])
    expect(fs.writes).not.toContain('/repo/quiz/questions.json')
  })

  it('is idempotent: a second run writes nothing (AS-2)', () => {
    const fs = corpus()
    invoke(fs, ['init-ids'])
    const before = fs.writes.length
    const again = invoke(fs, ['init-ids'])
    expect(again.code).toBe(EXIT.OK)
    expect(fs.writes.length).toBe(before)
    expect(again.stdout).toContain('slides: 1 file, 2 slides, 0 ids added')
  })

  it('keeps proposed ids unique across files', () => {
    const fs = corpus()
    fs.put('/repo/pages/S05-pod/index.md', '---\nslideId: s05-pod-pods\n---\n\n# Pods\n')
    fs.put('/repo/pages/S06-pod/index.md', '# Pods\n')
    // Section differs, so this only collides if both sections slugify alike:
    fs.put('/repo/pages/s05-POD/index.md', '# Pods\n')
    invoke(fs, ['init-ids'])
    expect(fs.text('/repo/pages/s05-POD/index.md')).toContain('slideId: s05-pod-pods-2\n')
  })

  it('leaves a file it cannot read safely untouched, adopts the rest, and exits 1', () => {
    const fs = corpus()
    const broken = '---\nlayout: cover\n\n# Unclosed frontmatter\n'
    fs.put('/repo/pages/S06-broken/index.md', broken)
    const result = invoke(fs, ['init-ids'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(fs.text('/repo/pages/S06-broken/index.md')).toBe(broken)
    expect(fs.text('/repo/pages/S05-pod/index.md')).toContain('slideId:')
    expect(result.stderr).toContain('pages/S06-broken/index.md:1:1: error:')
  })

  it('exits 65 without writing anything when a source is not UTF-8', () => {
    const fs = corpus()
    fs.put('/repo/labs/day-1/06-bad.md', new Uint8Array([0x23, 0x20, 0xff, 0x0a]))
    const result = invoke(fs, ['init-ids'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('labs/day-1/06-bad.md: is not valid UTF-8')
    expect(fs.writes).toEqual([])
  })
})

describe('init-ids --check (spec 001 FR-002)', () => {
  it('exits 1 naming every file and line that lacks an identity, writing nothing', () => {
    const fs = corpus()
    const result = invoke(fs, ['init-ids', '--check'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(fs.writes).toEqual([])
    expect(result.stderr).toContain('pages/S05-pod/index.md:1: slide has no slideId')
    expect(result.stderr).toContain('pages/S05-pod/index.md:11: slide has no slideId')
    expect(result.stderr).toContain('labs/day-1/05-pod.md: file declares no labId')
    expect(result.stdout).toContain('3 identity problems')
  })

  it('passes with 0 once init-ids has run', () => {
    const fs = corpus()
    invoke(fs, ['init-ids'])
    const result = invoke(fs, ['init-ids', '--check'])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain(
      'every slide, lab and quiz question carries an explicit identity',
    )
  })

  it('names both locations of a slideId duplicated across files (AS-3)', () => {
    const fs = corpus()
    invoke(fs, ['init-ids'])
    fs.put('/repo/pages/S06-copy/index.md', '---\nslideId: s05-pod-pod-lifecycle\n---\n\n# Copy\n')
    const result = invoke(fs, ['init-ids', '--check'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.stderr).toMatch(
      /slideId "s05-pod-pod-lifecycle" is declared in pages\/S05-pod\/index\.md:\d+ and pages\/S06-copy\/index\.md:1/,
    )
  })

  it('names both locations of a labId duplicated across files', () => {
    const fs = corpus()
    invoke(fs, ['init-ids'])
    fs.put('/repo/labs/day-2/copy.md', '# Copy\n\n<!-- labId: day-1-05-pod -->\n')
    const result = invoke(fs, ['init-ids', '--check'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.stderr).toContain(
      'labId "day-1-05-pod" is declared in labs/day-1/05-pod.md:3 and labs/day-2/copy.md:3',
    )
  })

  it('reports a duplicated quiz question id with its line', () => {
    const fs = corpus()
    invoke(fs, ['init-ids'])
    fs.put('/repo/quiz/questions.json', quiz(['S05-Q-POD-01', 'S05-Q-POD-01']))
    const result = invoke(fs, ['init-ids', '--check'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.stderr).toMatch(
      /quiz\/questions\.json:\d+:\d+: error: question id "S05-Q-POD-01" is already used/,
    )
  })

  it('reports a quiz question id duplicated across two banks', () => {
    const fs = corpus()
    fs.put(
      '/repo/.localization/workshop.yaml',
      MANIFEST.replace("['quiz/questions.json']", "['quiz/*.json']"),
    )
    fs.put('/repo/quiz/more.json', quiz(['S05-Q-POD-02']))
    invoke(fs, ['init-ids'])
    const result = invoke(fs, ['init-ids', '--check'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.stderr).toMatch(
      /question id "S05-Q-POD-02" is declared in quiz\/more\.json:\d+ and quiz\/questions\.json:\d+/,
    )
  })
})
