import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A stray control byte in a source file makes git classify it as binary: `git diff`
 * degrades to "Binary files differ" and the review UI renders nothing. This package is
 * full of literal delimiters and escape sequences, which is exactly where such a byte
 * gets typed by accident, so the property is pinned rather than noticed later.
 *
 * Hostile bytes belong in tests as escape sequences (`'a\\u0000b'`), which this allows:
 * it is the raw byte in the file that breaks review, not the value under test.
 */
const DIRECTORIES = ['../src', '../test'].map((relative) =>
  fileURLToPath(new URL(relative, import.meta.url)),
)

function sourceFiles(): readonly string[] {
  return DIRECTORIES.flatMap((directory) =>
    readdirSync(directory)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(directory, name)),
  )
}

describe('source hygiene', () => {
  it('finds the source files it is meant to be checking', () => {
    expect(sourceFiles().length).toBeGreaterThan(8)
  })

  it('keeps every source and test file free of raw control bytes, so git diffs them as text', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
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
