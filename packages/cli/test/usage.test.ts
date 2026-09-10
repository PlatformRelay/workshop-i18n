import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { invoke, MemoryFileSystem } from './memory-fs.js'

describe('usage', () => {
  it('prints usage to stderr and exits 64 when no command is given', () => {
    const result = invoke(new MemoryFileSystem(), [])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('Usage: workshop-i18n <command>')
    expect(result.stdout).toBe('')
  })

  it('prints usage to stdout and exits 0 for --help', () => {
    const result = invoke(new MemoryFileSystem(), ['--help'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('init-ids')
  })

  it('rejects an unknown command with 64, naming it', () => {
    const result = invoke(new MemoryFileSystem(), ['compose'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('unknown command "compose"')
  })

  it('rejects an unknown option with 64 rather than ignoring it', () => {
    const result = invoke(new MemoryFileSystem(), ['init-ids', '--chekc'])
    expect(result.code).toBe(EXIT.USAGE)
    expect(result.stderr).toContain('--chekc')
  })

  it('rejects stray positional arguments with 64', () => {
    const result = invoke(new MemoryFileSystem(), ['init-ids', 'pages'])
    expect(result.code).toBe(EXIT.USAGE)
  })

  it('prints per-command help for <command> --help', () => {
    const result = invoke(new MemoryFileSystem(), ['init-ids', '--help'])
    expect(result.code).toBe(EXIT.OK)
    expect(result.stdout).toContain('--check')
  })

  it('reports a missing manifest with 66 and the path it looked at', () => {
    const fs = new MemoryFileSystem({ '/repo/README.md': '# hi\n' })
    const result = invoke(fs, ['init-ids'])
    expect(result.code).toBe(EXIT.NO_INPUT)
    expect(result.stderr).toContain('.localization/workshop.yaml')
  })
})
