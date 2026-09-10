import { describe, expect, it } from 'vitest'
import { CliError, EXIT } from '../src/exit-codes.js'
import type { CliIo } from '../src/io.js'
import { type Command, runWith } from '../src/run.js'
import { invoke, MemoryFileSystem } from './memory-fs.js'

/** Exit codes are the contract CI branches on; a failure must never look like success. */

const MANIFEST = `apiVersion: workshop-i18n/v1
locales:
  targets: [de]
surfaces:
  labs:
    include: ['labs/**/*.md']
`

class RefusingFileSystem extends MemoryFileSystem {
  constructor(private readonly failure: () => Error) {
    super({ '/repo/.localization/workshop.yaml': MANIFEST, '/repo/labs/a.md': '# A\n' })
  }

  override readDirectory(path: string): readonly string[] {
    if (path === '/repo/labs') throw this.failure()
    return super.readDirectory(path)
  }
}

function capture(): { io: CliIo; out: () => { stdout: string; stderr: string } } {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    cwd: '/repo',
    fs: new MemoryFileSystem(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return { io, out: () => ({ stdout, stderr }) }
}

function command(execute: () => number): Command {
  return { name: 'probe', summary: 'test probe', help: '', options: {}, execute }
}

describe('runWith — failure exit codes', () => {
  it('maps a file-system errno (EACCES) to 74', () => {
    const fs = new RefusingFileSystem(() =>
      Object.assign(new Error('EACCES: permission denied, scandir /repo/labs'), {
        code: 'EACCES',
      }),
    )
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.IO)
    expect(result.stderr).toContain('file system error: EACCES')
  })

  it('maps an unexpected exception to 70 and says it is a bug', () => {
    const fs = new RefusingFileSystem(() => new TypeError('cannot read properties of undefined'))
    const result = invoke(fs, ['extract'])
    expect(result.code).toBe(EXIT.SOFTWARE)
    expect(result.stderr).toContain('this is a bug in workshop-i18n')
    expect(result.stderr).toContain('cannot read properties of undefined')
  })

  it('never reports success for a thrown non-Error value', () => {
    const { io, out } = capture()
    const code = runWith(
      [
        command(() => {
          throw 'a string'
        }),
      ],
      ['probe'],
      io,
    )
    expect(code).toBe(EXIT.SOFTWARE)
    expect(out().stderr).toContain('a string')
  })

  it('passes a CliError through with its own exit code and message', () => {
    const { io, out } = capture()
    const code = runWith(
      [
        command(() => {
          throw new CliError(EXIT.DATA, 'bad input here')
        }),
      ],
      ['probe'],
      io,
    )
    expect(code).toBe(EXIT.DATA)
    expect(out().stderr).toBe('workshop-i18n probe: bad input here\n')
  })

  it('returns the command’s own exit code otherwise', () => {
    const { io } = capture()
    expect(runWith([command(() => EXIT.FAILED)], ['probe'], io)).toBe(EXIT.FAILED)
  })
})
