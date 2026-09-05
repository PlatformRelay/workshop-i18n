import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The same guard `packages/core` carries, for the same reason: a raw control byte makes
 * git classify a file as binary, `git diff` degrades to "Binary files differ", and a
 * review UI renders nothing. It bites harder here than anywhere else — this package's
 * whole job is escaping control characters, so its tests are full of them, and every one
 * belongs in the source as an escape sequence (`'\\u0000'`) rather than as the byte.
 *
 * The fixtures are covered too: a golden nobody can read a diff of is not a golden.
 */
const DIRECTORIES = ['../src', '../test', '../../../fixtures/catalogs'].map((relative) =>
  fileURLToPath(new URL(relative, import.meta.url)),
)

function scannedFiles(): readonly string[] {
  return DIRECTORIES.flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|po)$/.test(entry.name))
      .map((entry) => join(directory, entry.name)),
  )
}

describe('source hygiene', () => {
  it('finds the files it is meant to be checking', () => {
    expect(scannedFiles().length).toBeGreaterThan(8)
  })

  it('keeps every source, test and fixture file free of raw control bytes', () => {
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      const bytes = readFileSync(file)
      for (const [index, byte] of bytes.entries()) {
        // Tab, line feed and carriage return are the only control bytes text needs.
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
          offenders.push(`${file} byte ${index} = 0x${byte.toString(16).padStart(2, '0')}`)
        } else if (byte === 0x7f) {
          offenders.push(`${file} byte ${index} = 0x7f`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
