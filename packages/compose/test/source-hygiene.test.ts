import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Two properties of the package's own source, pinned rather than noticed later:
 *
 * - **Purity** (constitution IV, spec 003 FR-006): nothing under `src/` imports a Node
 *   built-in, so composition cannot read the working tree, touch the network or spawn a
 *   process — the CLI is the only layer that does I/O — and nothing evaluates content.
 * - **Diffability**: no raw control byte in any source or test file, so git keeps
 *   treating them as text (hostile bytes belong in tests as escape sequences).
 */
const SOURCE = fileURLToPath(new URL('../src', import.meta.url))
const TEST = fileURLToPath(new URL('../test', import.meta.url))

function files(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(directory, name))
}

describe('source hygiene', () => {
  it('finds the source files it is meant to be checking', () => {
    expect(files(SOURCE).length).toBeGreaterThanOrEqual(4)
  })

  it('imports no Node built-in and evaluates nothing in src/', () => {
    const offenders = files(SOURCE).filter((file) =>
      /from ['"]node:|require\(|\beval\(|new Function\(|import\(/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('keeps every source and test file free of raw control bytes', () => {
    const offenders: string[] = []
    for (const file of [...files(SOURCE), ...files(TEST)]) {
      for (const [index, byte] of readFileSync(file).entries()) {
        if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
          offenders.push(`${file} byte ${index}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
