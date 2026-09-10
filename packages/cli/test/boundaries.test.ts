import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Two promises the CLI makes that no behavioural test can prove by absence, so they are
 * checked statically:
 *
 * - **No third-party runtime dependency.** The CLI is the package consumers install; every
 *   dependency it adds is a supply-chain edge in every consumer's CI. Workspace siblings
 *   are the one allowed form.
 * - **No network, no code execution** (spec 001 FR-007, constitution IV). Consumer content
 *   is hostile input; the CLI reads it, parses it and writes text, and none of its modules
 *   may reach for a socket, a subprocess or an evaluator.
 */

const PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url))
const SOURCES = fileURLToPath(new URL('../src', import.meta.url))

const FORBIDDEN = [
  /from 'node:(child_process|net|http|https|http2|dgram|dns|tls|vm|worker_threads|cluster)'/,
  /\beval\s*\(/,
  /\bnew Function\s*\(/,
  /\bimport\s*\(/,
  /\bfetch\s*\(/,
]

describe('cli package boundaries', () => {
  it('depends at runtime on workspace siblings only', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const runtime = {
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }
    const outside = Object.entries(runtime).filter(
      ([name, range]) => !name.startsWith('@workshop-i18n/') || range !== 'workspace:*',
    )
    expect(outside).toEqual([])
    expect(Object.keys(runtime).length).toBeGreaterThan(0)
  })

  it('never imports network, subprocess or evaluation facilities', () => {
    const files = readdirSync(SOURCES).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(5)
    const offenders = files.flatMap((name) => {
      const text = readFileSync(join(SOURCES, name), 'utf8')
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${name}: ${pattern}`,
      )
    })
    expect(offenders).toEqual([])
  })
})
