import { describe, expect, it } from 'vitest'
import { catalogPathFor } from '../src/catalogs.js'
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
  quiz:
    include: ['quiz/questions.json']
    schema: kubernetes-workshop
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
  'Every container in a Pod shares its network namespace.',
  '',
  '---',
  'slideId: s05-pod-lifecycle',
  '---',
  '',
  '# Pod lifecycle',
  '',
  'Pending, Running, Succeeded.',
  '',
].join('\n')

const POD_LAB = [
  '# Lab 05 — Pod',
  '',
  '<!-- labId: day-1-05-pod -->',
  '',
  'Run a Pod.',
  '',
  '```bash',
  'kubectl run web --image=nginx',
  '```',
  '',
].join('\n')

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

const SLIDES_PO = '/repo/i18n/pt-BR/pages/S05-pod/index.po'
const LAB_PO = '/repo/i18n/pt-BR/labs/day-1/05-pod.po'
const QUIZ_PO = '/repo/i18n/pt-BR/quiz/questions.po'

function corpus(): MemoryFileSystem {
  return new MemoryFileSystem({
    '/repo/.localization/workshop.yaml': MANIFEST,
    '/repo/pages/S05-pod/index.md': POD_SLIDES,
    '/repo/labs/day-1/05-pod.md': POD_LAB,
    '/repo/quiz/questions.json': quiz(['S05-Q-POD-01']),
  })
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Give the (single-line) entry for `id` a reviewed translation. */
function translate(po: string, id: string, translation: string): string {
  const pattern = new RegExp(`(msgctxt "${escapeRegex(id)}"\\nmsgid "[^"\\n]*"\\n)msgstr ""`)
  if (!pattern.test(po)) throw new Error(`no untranslated entry ${id} in catalog`)
  return po.replace(pattern, `$1msgstr ${JSON.stringify(translation)}`)
}

/** The unit id whose msgid is exactly `source`. */
function idOf(po: string, source: string): string {
  const match = new RegExp(
    `msgctxt "([^"]+)"\\nmsgid ${escapeRegex(JSON.stringify(source))}\\n`,
  ).exec(po)
  if (match?.[1] === undefined) throw new Error(`no entry with msgid ${JSON.stringify(source)}`)
  return match[1]
}

/** Every entry block, split on blank lines, header excluded. */
function blocks(po: string): readonly string[] {
  return po.split('\n\n').slice(1)
}

describe('catalogPathFor — catalog layout', () => {
  it('mirrors the source path under i18n/<locale>/, extension replaced by .po', () => {
    expect(catalogPathFor('pt-BR', 'pages/S05-pod/index.md')).toBe(
      'i18n/pt-BR/pages/S05-pod/index.po',
    )
    expect(catalogPathFor('de', 'labs/day-1/05-pod.solution.md')).toBe(
      'i18n/de/labs/day-1/05-pod.solution.po',
    )
    expect(catalogPathFor('de', 'quiz/questions.json')).toBe('i18n/de/quiz/questions.po')
  })
})

describe('extract — first run (spec 002 FR-002)', () => {
  it('writes one catalog per source file for every declared locale', () => {
    const fs = corpus()
    const result = invoke(fs, ['extract'])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(EXIT.OK)
    expect(Object.keys(fs.tree('/repo/i18n')).sort()).toEqual([
      'de/labs/day-1/05-pod.po',
      'de/pages/S05-pod/index.po',
      'de/quiz/questions.po',
      'pt-BR/labs/day-1/05-pod.po',
      'pt-BR/pages/S05-pod/index.po',
      'pt-BR/quiz/questions.po',
    ])
  })

  it('keys every entry by its unit id and records source path and hash', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    expect(po.startsWith('msgid ""\nmsgstr ""\n"Language: pt-BR\\n"\n')).toBe(true)
    const id = idOf(po, 'A Pod wraps one or more containers.')
    expect(id.startsWith('slides:s05-pod-pods:')).toBe(true)
    const block = blocks(po).find((entry) => entry.includes(`msgctxt "${id}"`)) ?? ''
    expect(block).toContain('#. workshop-i18n-source: pages/S05-pod/index.md\n')
    expect(block).toMatch(/#\. workshop-i18n-hash: sha256:[0-9a-f]{16}\n/)
    expect(block.endsWith('msgstr ""')).toBe(true)
  })

  it('never offers protected skeleton as a msgid', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    expect(fs.text(LAB_PO)).not.toContain('kubectl run web')
    expect(fs.text(SLIDES_PO)).not.toContain('slideId')
    expect(fs.text(QUIZ_PO)).not.toContain('S05-Q-POD-01"\n') // ids are msgctxt, never msgid
  })

  it('reports unit counts per surface', () => {
    const fs = corpus()
    const result = invoke(fs, ['extract'])
    expect(result.stdout).toMatch(/slides: 1 file, 2 containers, \d+ units/)
    expect(result.stdout).toMatch(/labs: 1 file, 1 container, \d+ units/)
    expect(result.stdout).toMatch(/quiz: 1 file, 1 container, 6 units/)
  })
})

describe('extract — updating catalogs (spec 002 US-1)', () => {
  it('is byte-identical on a no-change re-run and writes nothing (AS-3, SC-002)', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const before = fs.tree('/repo/i18n')
    const writes = fs.writes.length
    const again = invoke(fs, ['extract'])
    expect(again.code).toBe(EXIT.OK)
    expect(fs.tree('/repo/i18n')).toEqual(before)
    expect(fs.writes.length).toBe(writes)
  })

  it('marks exactly the edited entry fuzzy with its previous source (AS-1, FR-003)', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    let po = fs.text(SLIDES_PO)
    const edited = idOf(po, 'A Pod wraps one or more containers.')
    const untouched = idOf(po, 'Pending, Running, Succeeded.')
    po = translate(po, edited, 'Um Pod envolve contêineres.')
    po = translate(po, untouched, 'Pendente, Em execução, Concluído.')
    fs.put(SLIDES_PO, po)
    const reviewed = blocks(po).find((entry) => entry.includes(`"${untouched}"`))

    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.replace('A Pod wraps one or more containers.', 'A Pod wraps containers.'),
    )
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    const after = fs.text(SLIDES_PO)
    const fuzzy = blocks(after).find((entry) => entry.includes(`"${edited}"`)) ?? ''
    expect(fuzzy).toContain('#, fuzzy\n#| msgid "A Pod wraps one or more containers."\n')
    expect(fuzzy).toContain('msgid "A Pod wraps containers."\nmsgstr "Um Pod envolve contêineres."')
    expect(blocks(after).find((entry) => entry.includes(`"${untouched}"`))).toBe(reviewed)
    expect(after.match(/#, fuzzy/g)?.length).toBe(1)
    expect(result.stdout).toContain('pt-BR: 1 fuzzy')
  })

  it('preserves translator comments and unknown flags on untouched entries (FR-001)', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    const id = idOf(po, 'Pending, Running, Succeeded.')
    const annotated = po.replace(
      `msgctxt "${id}"`,
      `# translator: keep the phase names\n#, no-wrap\nmsgctxt "${id}"`,
    )
    fs.put(SLIDES_PO, annotated)
    invoke(fs, ['extract'])
    expect(fs.text(SLIDES_PO)).toContain('# translator: keep the phase names\n')
    expect(fs.text(SLIDES_PO)).toContain('#, no-wrap\n')
  })

  it('turns a deleted slide into obsolete entries, keeping the translation (AS-2, FR-004)', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    const id = idOf(po, 'Pending, Running, Succeeded.')
    fs.put(SLIDES_PO, translate(po, id, 'Pendente, Em execução, Concluído.'))
    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.split('\n---\nslideId: s05-pod-lifecycle')[0] ?? '',
    )
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    const after = fs.text(SLIDES_PO)
    expect(after).toContain(
      `#~ msgctxt "${id}"\n#~ msgid "Pending, Running, Succeeded."\n#~ msgstr "Pendente, Em execução, Concluído."`,
    )
    expect(result.stdout).toMatch(/pt-BR: .*\d+ obsoleted/)
  })

  it('follows a slide moved to another file without obsoleting or duplicating it', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    const id = idOf(po, 'Pending, Running, Succeeded.')
    fs.put(SLIDES_PO, translate(po, id, 'Pendente, Em execução, Concluído.'))
    const [first, second] = POD_SLIDES.split('\n---\nslideId: s05-pod-lifecycle')
    fs.put('/repo/pages/S05-pod/index.md', first ?? '')
    fs.put('/repo/pages/S06-lifecycle/index.md', `---\nslideId: s05-pod-lifecycle${second}`)
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    expect(fs.text(SLIDES_PO)).not.toContain(id)
    const moved = fs.text('/repo/i18n/pt-BR/pages/S06-lifecycle/index.po')
    expect(moved).toContain(
      `msgctxt "${id}"\nmsgid "Pending, Running, Succeeded."\nmsgstr "Pendente, Em execução, Concluído."`,
    )
    expect(moved).toContain('#. workshop-i18n-source: pages/S06-lifecycle/index.md\n')
    expect(result.stdout).toMatch(/pt-BR: .*\b0 obsoleted/)
  })

  it('carries the header of the catalog entries came from into a new catalog', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put(
      SLIDES_PO,
      fs
        .text(SLIDES_PO)
        .replace(
          '"X-Generator: workshop-i18n\\n"\n',
          '"X-Generator: workshop-i18n\\n"\n"X-Weblate-Component: s05\\n"\n',
        ),
    )
    fs.put('/repo/pages/S05-pods/index.md', POD_SLIDES)
    fs.files.delete('/repo/pages/S05-pod/index.md')
    invoke(fs, ['extract'])
    expect(fs.text('/repo/i18n/pt-BR/pages/S05-pods/index.po')).toContain(
      '"X-Weblate-Component: s05\\n"\n',
    )
  })

  it('counts a resurrected unit whose English changed as fuzzy', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    const id = idOf(po, 'Pending, Running, Succeeded.')
    fs.put(SLIDES_PO, translate(po, id, 'Pendente, Em execução, Concluído.'))
    const [first] = POD_SLIDES.split('\n---\nslideId: s05-pod-lifecycle')
    fs.put('/repo/pages/S05-pod/index.md', first ?? '')
    invoke(fs, ['extract'])
    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.replace('Pending, Running, Succeeded.', 'Pending, Running, Failed.'),
    )
    const result = invoke(fs, ['extract'])
    expect(result.stdout).toContain(
      'pt-BR: 1 fuzzy (1 resurrected), 0 added, 0 obsoleted, 2 resurrected',
    )
  })

  it('removes the catalog of a renamed file once every entry has followed it', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put('/repo/pages/S05-pods/index.md', POD_SLIDES)
    fs.files.delete('/repo/pages/S05-pod/index.md')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    expect(fs.removals).toContain(SLIDES_PO)
    expect(fs.files.has('/repo/i18n/pt-BR/pages/S05-pods/index.po')).toBe(true)
  })

  it('keeps an orphaned catalog as obsolete entries when its source is deleted', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.files.delete('/repo/labs/day-1/05-pod.md')
    fs.put('/repo/labs/day-1/06-other.md', '# Other\n\n<!-- labId: day-1-06-other -->\n\nText.\n')
    invoke(fs, ['extract'])
    expect(fs.text(LAB_PO)).toMatch(/^#~ msgctxt "labs:day-1-05-pod:/m)
    expect(fs.text(LAB_PO)).not.toMatch(/^msgctxt/m)
  })

  it('reports units re-keyed by a structural edit, per container (ADR 0005 amendment)', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.replace('# Pods\n', '# Pods\n\n## Why\n\nBecause.\n'),
    )
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toMatch(
      /pt-BR: re-keyed slides:s05-pod-pods \(\d+ added, \d+ fuzzy, \d+ obsoleted\)/,
    )
  })

  it('reports the common re-key: a paragraph inserted before translated siblings', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    const first = idOf(po, 'A Pod wraps one or more containers.')
    const second = idOf(po, 'Every container in a Pod shares its network namespace.')
    fs.put(SLIDES_PO, translate(translate(po, first, 'Um.'), second, 'Dois.'))
    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.replace('# Pods\n\n', '# Pods\n\nA brand new opening paragraph.\n\n'),
    )
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    // Keys shift down: the first key now holds new English, the second holds the first
    // paragraph's English, and a third key holds the second's. Translations stay on keys.
    expect(result.stdout).toContain(
      'pt-BR: re-keyed slides:s05-pod-pods (1 added, 2 fuzzy, 0 obsoleted)',
    )
    expect(result.stdout).toContain(
      `pt-BR:   ${second} now has the English ${first} was translated from`,
    )
    const third = idOf(fs.text(SLIDES_PO), 'Every container in a Pod shares its network namespace.')
    expect(result.stdout).toContain(
      `pt-BR:   ${third} now has the English ${second} was translated from`,
    )
  })

  it('calls an edit plus an appended paragraph only a possible re-key, with no shift claimed', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put(
      '/repo/pages/S05-pod/index.md',
      `${POD_SLIDES.replace('Pending, Running, Succeeded.', 'Pending, Running.')}\nMore at the end.\n`,
    )
    const result = invoke(fs, ['extract'])
    expect(result.stdout).toContain(
      'pt-BR: possibly re-keyed slides:s05-pod-lifecycle (1 added, 1 fuzzy, 0 obsoleted)',
    )
    expect(result.stdout).not.toContain('now has the English')
  })

  it('stays silent for a plain edit', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put(
      '/repo/pages/S05-pod/index.md',
      POD_SLIDES.replace('Pending, Running, Succeeded.', 'Pending, Running.'),
    )
    expect(invoke(fs, ['extract']).stdout).not.toContain('re-keyed')
  })
})

describe('extract — refusing bad input (spec 002 edge cases)', () => {
  it('exits 65 on broken PO syntax, naming file and line, writing nothing', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put(SLIDES_PO, `${fs.text(SLIDES_PO)}\nmsgctxt "oops\n`)
    const writes = fs.writes.length
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toMatch(/i18n\/pt-BR\/pages\/S05-pod\/index\.po:\d+: /)
    expect(fs.writes.length).toBe(writes)
  })

  it('refuses a catalog left with git conflict markers, pointing at the first one', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    const po = fs.text(SLIDES_PO)
    const conflicted = po.replace(
      'msgstr ""\n',
      'msgstr ""\n<<<<<<< HEAD\nmsgstr "a"\n=======\nmsgstr "b"\n>>>>>>> branch\n',
    )
    const line = conflicted.split('\n').indexOf('<<<<<<< HEAD') + 1
    fs.put(SLIDES_PO, conflicted)
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain(`i18n/pt-BR/pages/S05-pod/index.po:${line}: `)
    expect(fs.text(SLIDES_PO)).toBe(conflicted)
  })

  it('exits 65 when one unit id lives in two catalogs, naming both', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.put('/repo/i18n/pt-BR/pages/copy.po', fs.text(SLIDES_PO))
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toMatch(
      /unit id "slides:[^"]+" is in both i18n\/pt-BR\/pages\/S05-pod\/index\.po:\d+ and i18n\/pt-BR\/pages\/copy\.po:\d+/,
    )
  })

  it('exits 65 listing every extraction error, writing nothing', () => {
    const fs = corpus()
    fs.put('/repo/pages/S07-svc/index.md', '# No id here\n')
    fs.put('/repo/labs/day-1/07-svc.md', '# No marker\n')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('pages/S07-svc/index.md:1:1: error:')
    expect(result.stderr).toContain('labs/day-1/07-svc.md:1:1: error:')
    expect(fs.writes).toEqual([])
  })

  it('exits 65 when two files declare the same container', () => {
    const fs = corpus()
    fs.put('/repo/pages/S06-dup/index.md', '---\nslideId: s05-pod-pods\n---\n\n# Dup\n')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain(
      'slides:s05-pod-pods is declared in both pages/S05-pod/index.md and pages/S06-dup/index.md',
    )
  })

  it('refuses to write through a symlinked i18n directory', () => {
    const fs = corpus()
    fs.link('/repo/i18n', '/etc')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('i18n is a symlink')
    expect(fs.writes).toEqual([])
  })

  it('refuses a symlinked catalog rather than writing through it', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    fs.files.delete(SLIDES_PO)
    fs.link(SLIDES_PO, '/etc/passwd')
    const writes = fs.writes.length
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('index.po is a symlink')
    expect(fs.writes.length).toBe(writes)
  })

  it('refuses two sources that would share one catalog', () => {
    const fs = corpus()
    fs.put(
      '/repo/.localization/workshop.yaml',
      MANIFEST.replace("['quiz/questions.json']", "['labs/day-1/05-pod.json']"),
    )
    fs.put('/repo/labs/day-1/05-pod.json', quiz(['S05-Q-POD-01']))
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain(
      'labs/day-1/05-pod.md and labs/day-1/05-pod.json would share the catalog',
    )
  })
})

describe('extract --check', () => {
  it('exits 1 naming stale catalogs, writing nothing', () => {
    const fs = corpus()
    const result = invoke(fs, ['extract', '--check'])
    expect(result.code).toBe(EXIT.FAILED)
    expect(result.stderr).toContain(catalogPathFor('pt-BR', 'pages/S05-pod/index.md'))
    expect(fs.writes).toEqual([])
  })

  it('exits 0 when the catalogs are current', () => {
    const fs = corpus()
    invoke(fs, ['extract'])
    expect(invoke(fs, ['extract', '--check']).code).toBe(EXIT.OK)
  })
})

describe('extract — warnings', () => {
  it('warns about a catalog directory for an undeclared locale and never touches it', () => {
    const fs = corpus()
    fs.put('/repo/i18n/fr/pages/S05-pod/index.po', 'not even a catalog')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stderr).toBe(
      'warning: i18n/fr/ is for a locale the manifest does not declare; it is ignored and excluded from policy\n',
    )
    expect(fs.text('/repo/i18n/fr/pages/S05-pod/index.po')).toBe('not even a catalog')
  })

  it('passes extractor coverage warnings through with their location, once', () => {
    const fs = corpus()
    fs.put(
      '/repo/pages/S05-pod/index.md',
      `${POD_SLIDES}\n<div class="note">\nProse in a block.\n</div>\n`,
    )
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stderr).toMatch(
      /^pages\/S05-pod\/index\.md:\d+:\d+: warning: .* \[prose-in-html-block\]\n$/,
    )
  })
})
