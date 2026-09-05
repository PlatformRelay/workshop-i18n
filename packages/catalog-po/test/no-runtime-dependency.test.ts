import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ADR 0013's decision is "implement PO reading and writing inside `packages/catalog-po`,
 * with **no third-party runtime dependency**". That is the whole justification for the
 * ~1000 lines of codec in this package: one less supply-chain edge in a repo that runs
 * Scorecard and CodeQL, and no upstream lag when we need a comment class a dependency
 * does not model.
 *
 * Nothing enforced it. Adding `"gettext-parser": "^8"` to `dependencies` would have
 * passed lint, typecheck, tests and build — and quietly spent the reason this package
 * exists. Workspace siblings are not third parties, so they are the one allowed form.
 */
const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly bundledDependencies?: readonly string[]
  readonly bundleDependencies?: readonly string[]
}

function manifest(): PackageManifest {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as PackageManifest
}

describe('ADR 0013 — no third-party runtime dependency', () => {
  it('declares only workspace siblings as runtime dependencies', () => {
    // Both halves are checked: a `workspace:` range on a name that is not one of ours
    // would still be a foreign package, and a real name with a fabricated range is caught
    // downstream by `pnpm install --frozen-lockfile`.
    const foreign = Object.entries(manifest().dependencies ?? {}).filter(
      ([name, range]) => !range.startsWith('workspace:') || !name.startsWith('@workshop-i18n/'),
    )
    expect(foreign, 'ADR 0013 forbids a third-party runtime dependency in this package').toEqual([])
  })

  it('declares no peer, optional or bundled dependencies — the same edge by other names', () => {
    const found = manifest()
    expect(Object.keys(found.peerDependencies ?? {})).toEqual([])
    expect(Object.keys(found.optionalDependencies ?? {})).toEqual([])
    expect(found.bundledDependencies ?? []).toEqual([])
    expect(found.bundleDependencies ?? []).toEqual([])
  })

  it('is actually reading the manifest it thinks it is', () => {
    expect(Object.keys(manifest().dependencies ?? {})).toContain('@workshop-i18n/core')
  })
})
