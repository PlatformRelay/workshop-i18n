import { describe, expect, it } from 'vitest'
import { planLocale, writePlans } from '../src/catalogs.js'
import { CliError, EXIT } from '../src/exit-codes.js'
import { assertNoSymlink, insideRoot } from '../src/paths.js'
import { readSources } from '../src/sources.js'
import { extractCorpus } from '../src/units.js'
import { loadWorkspace } from '../src/workspace.js'
import { invoke, MemoryFileSystem } from './memory-fs.js'

function refusal(action: () => unknown): CliError {
  try {
    action()
  } catch (error) {
    if (error instanceof CliError) return error
    throw error
  }
  throw new Error('expected a CliError')
}

describe('insideRoot', () => {
  it('joins a safe repository path under the root', () => {
    expect(insideRoot('/repo', 'i18n/de/a.po')).toBe('/repo/i18n/de/a.po')
  })

  it.each([
    ['a ".." segment', '../etc/passwd'],
    ['a buried ".." segment', 'i18n/../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'i18n\\..\\x'],
    ['an empty segment', 'i18n//x'],
    ['the empty path', ''],
    ['a control character', 'i18n/\u0000x'],
  ])('refuses %s with exit 65', (_label, path) => {
    const error = refusal(() => insideRoot('/repo', path))
    expect(error.exitCode).toBe(EXIT.DATA)
  })

  it('refuses a ".." segment even when the path it spells stays inside the root', () => {
    // Lexically `labs/../i18n/de/a.po` is `/repo/i18n/de/a.po`, so the containment check
    // alone would pass it; the segment check is what refuses it. Such a path would slip
    // past every rule keyed to a path's leading segments (reserved trees, symlink walk).
    const error = refusal(() => insideRoot('/repo', 'labs/../i18n/de/a.po'))
    expect(error.exitCode).toBe(EXIT.DATA)
    expect(error.message).toContain('refusing unsafe repository path')
  })

  it('refuses the root itself spelled as "." segments, which only the containment check sees', () => {
    for (const path of ['.', './.']) {
      const error = refusal(() => insideRoot('/repo', path))
      expect(error.exitCode).toBe(EXIT.DATA)
      expect(error.message).toContain('is the repository root itself')
    }
  })
})

describe('assertNoSymlink', () => {
  it('refuses a symlink as the final component', () => {
    const fs = new MemoryFileSystem({ '/repo/i18n/de/x.txt': '' })
    fs.link('/repo/i18n/de/a.po', '/etc/passwd')
    expect(refusal(() => assertNoSymlink(fs, '/repo', 'i18n/de/a.po')).message).toContain(
      'i18n/de/a.po is a symlink',
    )
  })

  it('refuses a symlink in the middle of the path', () => {
    const fs = new MemoryFileSystem({ '/repo/README.md': '' })
    fs.link('/repo/i18n', '/etc')
    expect(refusal(() => assertNoSymlink(fs, '/repo', 'i18n/de/a.po')).message).toContain(
      'i18n is a symlink',
    )
  })

  it('accepts a path whose tail does not exist yet', () => {
    const fs = new MemoryFileSystem({ '/repo/i18n/README': '' })
    expect(() => assertNoSymlink(fs, '/repo', 'i18n/de/new/a.po')).not.toThrow()
  })
})

describe('symlink refusals, one by one', () => {
  const MANIFEST = `apiVersion: workshop-i18n/v1
locales:
  targets: [de]
surfaces:
  labs:
    include: ['labs/**/*.md']
`

  it('refuses a manifest that is itself a symlink', () => {
    const fs = new MemoryFileSystem({ '/elsewhere/workshop.yaml': MANIFEST })
    fs.makeDirectory('/repo/.localization')
    fs.link('/repo/.localization/workshop.yaml', '/elsewhere/workshop.yaml')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('.localization/workshop.yaml is a symlink')
  })

  it('refuses a symlinked locale directory', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST,
      '/repo/labs/a.md': '# A\n\n<!-- labId: a -->\n\nText.\n',
    })
    fs.link('/repo/i18n/de', '/elsewhere')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('i18n/de is a symlink')
    expect(fs.writes).toEqual([])
  })

  it('refuses a symlinked directory inside a locale directory', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': MANIFEST,
      '/repo/labs/a.md': '# A\n\n<!-- labId: a -->\n\nText.\n',
      '/repo/i18n/de/README': '',
    })
    fs.link('/repo/i18n/de/labs', '/elsewhere')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.DATA)
    expect(result.stderr).toContain('i18n/de/labs is a symlink')
    expect(fs.writes).toEqual([])
  })

  it('gives a clear error for a symlinked repository root', () => {
    const fs = new MemoryFileSystem({ '/real/.localization/workshop.yaml': MANIFEST })
    fs.link('/repo', '/real')
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.NO_INPUT)
    expect(result.stderr).toContain('/repo is a symlink; pass its real path with --root')
  })
})

describe('writePlans', () => {
  it('re-checks every target for symlinks before the first write', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': `apiVersion: workshop-i18n/v1
locales:
  targets: [de]
surfaces:
  labs:
    include: ['labs/**/*.md']
`,
      '/repo/labs/a.md': '# A\n\n<!-- labId: a -->\n\nText.\n',
    })
    const io = { cwd: '/repo', fs, stdout: () => undefined, stderr: () => undefined }
    const workspace = loadWorkspace(io, '/repo')
    const plan = planLocale(workspace, extractCorpus(workspace, readSources(workspace)), 'de')
    // Planted between planning and writing: the target's directory becomes a link.
    fs.link('/repo/i18n/de/labs', '/elsewhere')
    expect(() => writePlans(workspace, [plan])).toThrow(/i18n\/de\/labs is a symlink/)
    expect(fs.writes).toEqual([])
  })

  it('removes emptied directories up to, never including, i18n/<locale>/', () => {
    const fs = new MemoryFileSystem({
      '/repo/.localization/workshop.yaml': `apiVersion: workshop-i18n/v1
locales:
  targets: [de]
surfaces:
  labs:
    include: ['labs/**/*.md']
`,
      '/repo/labs/day-1/a.md': '# A\n\n<!-- labId: a -->\n\nText.\n',
    })
    const io = { cwd: '/repo', fs, stdout: () => undefined, stderr: () => undefined }
    const workspace = loadWorkspace(io, '/repo')
    const plan = planLocale(workspace, extractCorpus(workspace, readSources(workspace)), 'de')
    writePlans(workspace, [plan])
    const [only] = plan.catalogs
    expect(only?.path).toBe('i18n/de/labs/day-1/a.po')
    if (only === undefined) return
    // The locale's one catalog goes away: everything below the locale empties.
    writePlans(workspace, [
      { locale: 'de', catalogs: [{ ...only, text: undefined, previousText: only.text }] },
    ])
    expect(fs.kind('/repo/i18n/de/labs/day-1')).toBeUndefined()
    expect(fs.kind('/repo/i18n/de/labs')).toBeUndefined()
    expect(fs.kind('/repo/i18n/de')).toBe('directory')
    expect(fs.kind('/repo/i18n')).toBe('directory')
  })
})
