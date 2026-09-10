import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'
import { EXIT } from '../src/exit-codes.js'
import { nodeFileSystem } from '../src/io.js'

/**
 * The real adapter, against a real temporary directory: the in-memory tree proves the
 * logic, this proves `nodeFileSystem` keeps the same contract — `lstat` semantics,
 * recursive mkdir, and a symlink reported rather than followed.
 */

let root: string

function write(relative: string, text: string): void {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function cli(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const code = run(argv, {
    cwd: root,
    fs: nodeFileSystem(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workshop-i18n-cli-'))
  write(
    '.localization/workshop.yaml',
    "apiVersion: workshop-i18n/v1\nlocales:\n  targets: [de]\nsurfaces:\n  slides:\n    include: ['pages/**/index.md']\n",
  )
  write('pages/S01-intro/index.md', '# Welcome\n\nHello, workshop.\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the CLI on the real file system', () => {
  it('adopts ids, extracts, and is a fixed point on the second run', () => {
    expect(cli(['init-ids']).code).toBe(EXIT.OK)
    expect(readFileSync(join(root, 'pages/S01-intro/index.md'), 'utf8')).toBe(
      '---\nslideId: s01-intro-welcome\n---\n# Welcome\n\nHello, workshop.\n',
    )
    expect(cli(['extract']).code).toBe(EXIT.OK)
    const catalog = readFileSync(join(root, 'i18n/de/pages/S01-intro/index.po'), 'utf8')
    expect(catalog).toContain('msgid "Hello, workshop."')
    expect(cli(['extract', '--check']).code).toBe(EXIT.OK)
    expect(readFileSync(join(root, 'i18n/de/pages/S01-intro/index.po'), 'utf8')).toBe(catalog)
  })

  it('removes the directory a moved section’s catalog leaves empty', () => {
    expect(cli(['init-ids']).code).toBe(EXIT.OK)
    expect(cli(['extract']).code).toBe(EXIT.OK)
    const source = readFileSync(join(root, 'pages/S01-intro/index.md'), 'utf8')
    rmSync(join(root, 'pages/S01-intro'), { recursive: true })
    write('pages/S01-welcome/index.md', source)
    expect(cli(['extract']).code).toBe(EXIT.OK)
    expect(existsSync(join(root, 'i18n/de/pages/S01-welcome/index.po'))).toBe(true)
    expect(existsSync(join(root, 'i18n/de/pages/S01-intro'))).toBe(false)
    expect(existsSync(join(root, 'i18n/de/pages'))).toBe(true)
  })

  it('refuses to write through a symlinked i18n directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'workshop-i18n-outside-'))
    try {
      symlinkSync(outside, join(root, 'i18n'))
      cli(['init-ids'])
      const result = cli(['extract'])
      expect(result.code).toBe(EXIT.DATA)
      expect(result.stderr).toContain('i18n is a symlink')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
