import { describe, expect, it } from 'vitest'
import { discoverSurfaceFiles } from '../src/discover.js'
import { CliError, EXIT } from '../src/exit-codes.js'
import { loadWorkspace } from '../src/workspace.js'
import { invoke, MemoryFileSystem } from './memory-fs.js'

const MANIFEST = `apiVersion: workshop-i18n/v1
locales:
  targets: [pt-BR]
surfaces:
  slides:
    include: ['pages/**/index.md']
  labs:
    include: ['labs/**/*.md']
    exclude: ['labs/README.md']
  quiz:
    include: ['quiz/questions.json']
    schema: kubernetes-workshop
`

function workspaceOf(fs: MemoryFileSystem) {
  return loadWorkspace(
    { cwd: '/repo', fs, stdout: () => undefined, stderr: () => undefined },
    '/repo',
  )
}

describe('discoverSurfaceFiles', () => {
  it('finds the files each surface declares, sorted, honouring exclude', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST,
      '/repo/pages/S05-pod/index.md': '',
      '/repo/pages/S01-containers/index.md': '',
      '/repo/pages/S01-containers/notes.md': '',
      '/repo/labs/day-1/05-pod.md': '',
      '/repo/labs/README.md': '',
      '/repo/quiz/questions.json': '{}',
      '/repo/slides-day-1.md': '',
    })
    const found = discoverSurfaceFiles(workspaceOf(fs))
    expect(found.files.map((file) => `${file.surface}:${file.path}`)).toEqual([
      'slides:pages/S01-containers/index.md',
      'slides:pages/S05-pod/index.md',
      'labs:labs/day-1/05-pod.md',
      'quiz:quiz/questions.json',
    ])
    expect(found.files[2]?.base).toBe('labs')
    expect(found.warnings).toEqual([])
  })

  it('never walks node_modules, .git, or the i18n output tree', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/**/*.md'", "'**/*.md'").replace(
        "'labs/README.md'",
        "'pages/**'",
      ),
      '/repo/labs/a.md': '',
      '/repo/node_modules/pkg/readme.md': '',
      '/repo/labs/node_modules/x.md': '',
      '/repo/.git/x.md': '',
      '/repo/i18n/pt-BR/overrides/s.md': '',
      '/repo/pages/S01/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const found = discoverSurfaceFiles(workspaceOf(fs))
    expect(found.files.filter((file) => file.surface === 'labs').map((file) => file.path)).toEqual([
      'labs/a.md',
    ])
  })

  it('warns about a glob that matches nothing, naming the manifest entry', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST,
      '/repo/pages/S05-pod/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const found = discoverSurfaceFiles(workspaceOf(fs))
    expect(found.warnings).toEqual(['surfaces.labs.include[0] "labs/**/*.md" matches no files'])
  })

  it('skips a symlinked source with a warning, never following it', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST,
      '/repo/pages/S05-pod/index.md': '',
      '/repo/labs/a.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    fs.link('/repo/labs/evil.md', '/etc/passwd')
    fs.link('/repo/labs/day-9', '/elsewhere')
    const found = discoverSurfaceFiles(workspaceOf(fs))
    expect(found.files.map((file) => file.path)).not.toContain('labs/evil.md')
    expect(found.warnings).toEqual([
      'labs/day-9 is a symlink and was not followed',
      'labs/evil.md is a symlink and was not followed',
    ])
  })

  it('refuses a glob base that is itself a symlink', () => {
    const fs = new MemoryFileSystem({ '/repo/.localization/workshop.yaml': MANIFEST })
    fs.link('/repo/pages', '/etc')
    expect(() => discoverSurfaceFiles(workspaceOf(fs))).toThrow(CliError)
  })

  it('refuses a file two surfaces both claim', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace(
        "'pages/**/index.md'",
        "'labs/day-1/*.md'",
      ),
      '/repo/labs/day-1/05-pod.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    expect(() => discoverSurfaceFiles(workspaceOf(fs))).toThrow(
      /labs\/day-1\/05-pod\.md is claimed by both surfaces\.slides and surfaces\.labs/,
    )
  })
})

describe('discoverSurfaceFiles — hostile globs', () => {
  it('survives a pathological star run in the manifest (no ReDoS)', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace(
        "'labs/**/*.md'",
        "'labs/*a*a*a*a*a*a*a*a*b.md'",
      ),
      [`/repo/labs/${'a'.repeat(60)}.md`]: '',
      '/repo/pages/S05-pod/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const started = performance.now()
    const found = discoverSurfaceFiles(workspaceOf(fs))
    expect(performance.now() - started).toBeLessThan(500)
    expect(found.files.some((file) => file.surface === 'labs')).toBe(false)
  })

  it.each([
    ["'i18n/**/*.md'", 'i18n'],
    ["'{labs,i18n}/**/*.md'", 'i18n'],
    ["'.localization/*.md'", '.localization'],
  ])('refuses an include glob %s that reaches into the tool’s own tree', (glob, reserved) => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/**/*.md'", glob),
      '/repo/i18n/pt-BR/overrides/x.md': '# Tradução\n',
      '/repo/labs/a.md': '',
      '/repo/pages/S05-pod/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain(
      `surfaces.labs.include[0] reaches into ${reserved}/, which belongs to workshop-i18n`,
    )
    expect(fs.writes).toEqual([])
  })

  it.each([
    ["'I18N/**/*.md'", 'I18N', 'which belongs to workshop-i18n'],
    ["'{labs,I18n}/pt-BR/**/*.md'", 'I18n', 'which belongs to workshop-i18n'],
    ["'.Localization/*.md'", '.Localization', 'which belongs to workshop-i18n'],
    ["'.GIT/config'", '.GIT', 'which holds version-control or dependency files'],
    [
      "'labs/Node_Modules/**/*.md'",
      'Node_Modules',
      'which holds version-control or dependency files',
    ],
    ["'node_moduleſ/x.md'", 'node_moduleſ', 'which holds version-control or dependency files'],
  ])(
    'refuses %s in any letter case, since a case-insensitive file system resolves it to the real tree',
    (glob, written, reason) => {
      const fs = new MemoryFileSystem({
        '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/**/*.md'", glob),
        '/repo/labs/a.md': '',
        '/repo/pages/S05-pod/index.md': '',
        '/repo/quiz/questions.json': '{}',
      })
      const result = invoke(fs, ['extract'])
      expect(result.code).toBe(EXIT.DATA)
      expect(result.stderr).toContain(
        `surfaces.labs.include[0] reaches into ${written}/, ${reason}`,
      )
      expect(fs.writes).toEqual([])
    },
  )

  it('skips the reserved and dependency trees in any letter case during the walk', () => {
    // On a case-insensitive file system an existing `I18n/` is where catalogs and
    // overrides land, and a directory listing reports it as `I18n`, not `i18n`.
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/**/*.md'", "'**/*.md'").replace(
        "'labs/README.md'",
        "'pages/**'",
      ),
      '/repo/labs/a.md': '',
      '/repo/I18n/pt-BR/overrides/s.md': '# Sobrescrita\n',
      '/repo/.Localization/notes.md': '',
      '/repo/labs/Node_Modules/x.md': '',
      '/repo/.GIT/x.md': '',
      '/repo/pages/S01/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const found = discoverSurfaceFiles(workspaceOf(fs))
    expect(found.files.filter((file) => file.surface === 'labs').map((file) => file.path)).toEqual([
      'labs/a.md',
    ])
  })

  it('refuses a glob over the size bounds before walking anything, naming the entry', () => {
    const hostile = `{${Array(64).fill('*').join(',')}}/${'*/'.repeat(500)}x.md`
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/**/*.md'", `'${hostile}'`),
      '/repo/labs/a.md': '',
      '/repo/pages/S05-pod/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const result = invoke(fs, ['extract', '--check'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('surfaces.labs.include[0]: ')
    expect(result.stderr).toContain('longer than 512 bytes')
    expect(fs.writes).toEqual([])
  })

  it.each([
    ["'.git/config'", '.git'],
    ["'{labs,.git}/**/*'", '.git'],
    ["'vendor/theme/.git/config'", '.git'],
    ["'node_modules/pkg/README.md'", 'node_modules'],
    ["'labs/node_modules/**/*.md'", 'node_modules'],
  ])(
    'refuses an include glob %s that starts inside a tree the walk never enters',
    (glob, skipped) => {
      const gitConfig = '[core]\n\tbare = false\n'
      const fs = new MemoryFileSystem({
        '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/**/*.md'", glob),
        '/repo/.git/config': gitConfig,
        '/repo/vendor/theme/.git/config': gitConfig,
        '/repo/node_modules/pkg/README.md': '# Package\n',
        '/repo/labs/node_modules/dep/x.md': '# Dep\n',
        '/repo/labs/a.md': '# Lab\n',
        '/repo/pages/S05-pod/index.md': '',
        '/repo/quiz/questions.json': '{}',
      })
      const result = invoke(fs, ['init-ids'])
      expect(result.code).toBe(EXIT.DATA)
      expect(result.stderr).toContain(`surfaces.labs.include[0] reaches into ${skipped}/`)
      expect(fs.writes).toEqual([])
      expect(fs.text('/repo/.git/config')).toBe(gitConfig)
    },
  )

  it('names the manifest entry of a glob it refuses', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace("'labs/README.md'", "'labs/{a'"),
    })
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('surfaces.labs.exclude[0]: "labs/{a" has an unbalanced')
  })

  it('walks every base of a brace glob and records the base that holds each file', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST.replace(
        "'labs/**/*.md'",
        "'{labs,extra/labs}/**/*.md'",
      ),
      '/repo/labs/a.md': '',
      '/repo/extra/labs/b.md': '',
      '/repo/pages/S05-pod/index.md': '',
      '/repo/quiz/questions.json': '{}',
    })
    const labs = discoverSurfaceFiles(workspaceOf(fs)).files.filter(
      (file) => file.surface === 'labs',
    )
    expect(labs.map((file) => [file.path, file.base])).toEqual([
      ['extra/labs/b.md', 'extra/labs'],
      ['labs/a.md', 'labs'],
    ])
  })
})

describe('loadWorkspace', () => {
  it('reports every manifest issue with 65', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': 'apiVersion: workshop-i18n/v1\nlocales: {}\n',
    })
    const result = invoke(fs, ['init-ids'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('locales.targets: is required')
    expect(result.stderr).toContain('surfaces: is required')
  })

  it('refuses a symlinked manifest directory', () => {
    const fs = new MemoryFileSystem({ '/elsewhere/workshop.yaml': MANIFEST })
    fs.directories.add('/repo')
    fs.link('/repo/.localization', '/elsewhere')
    const result = invoke(fs, ['init-ids'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('.localization is a symlink')
  })

  it('honours --root relative to the working directory', () => {
    const fs = new MemoryFileSystem({ '/work/README.md': '' })
    const result = invoke(fs, ['init-ids', '--root', '../repo'], '/work')
    expect(result.code).toBe(EXIT.NO_INPUT)
    expect(result.stderr).toContain('/repo')
  })
})
