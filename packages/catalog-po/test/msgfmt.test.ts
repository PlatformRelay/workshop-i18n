import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Interoperability, not novelty, is ADR 0013's acceptance bar: owning the codec is only
 * defensible if what it writes is ordinary gettext. `msgfmt` is the reference reader, so
 * where it exists the goldens are compiled with it.
 *
 * Where it does not exist the suite says so out loud — a skipped, named test rather than
 * a silent pass — because "we did not check" and "it passed" must not look the same in a
 * CI log. The GitHub runner has gettext preinstalled, so this runs in CI.
 */
const FIXTURES = fileURLToPath(new URL('../../../fixtures/catalogs/', import.meta.url))

function msgfmtVersion(): string | undefined {
  const probe = spawnSync('msgfmt', ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) return undefined
  return (probe.stdout.split('\n')[0] ?? '').trim()
}

const version = msgfmtVersion()

describe('gettext interoperability', () => {
  it.runIf(version !== undefined)(`compiles every golden with ${version ?? 'msgfmt'}`, () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workshop-i18n-msgfmt-'))
    const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.po'))
    expect(names.length).toBeGreaterThan(4)

    for (const name of names) {
      const source = join(workspace, name)
      writeFileSync(source, readFileSync(join(FIXTURES, name), 'utf8'))
      const result = spawnSync('msgfmt', ['--output-file', join(workspace, `${name}.mo`), source], {
        encoding: 'utf8',
      })
      expect(result.status, `${name}: ${result.stderr}`).toBe(0)
    }
  })

  it.skipIf(version !== undefined)('SKIPPED: msgfmt is not installed on this machine', () => {
    expect(version).toBeUndefined()
  })
})
