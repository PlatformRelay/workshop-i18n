/**
 * End-to-end smoke: a `<<< @/.env` snippet-import line in a translation must never reach
 * a real `slidev build`'s output (re-review 4, P0). Off by default — a Slidev build is
 * slow and needs the consumer's toolchain — and gated on `WI18N_SLIDEV_SMOKE`, a
 * directory holding an installed Slidev (`node_modules/.bin/slidev`) and a `.env` with a
 * secret canary. The reviewer's harness dir works as-is:
 *
 *   WI18N_SLIDEV_SMOKE=/home/koni/.claude/jobs/b26ec76e/tmp/rev4-deck pnpm vitest run slidev-smoke
 *
 * It proves two things: composition refuses the payload (so the deck it would build
 * carries only marked English), and — as a belt-and-braces check on the whole claim —
 * that had the payload been emitted, the build *would* have leaked, by building the raw
 * payload deck and finding the canary in `dist`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeLocale } from '../src/compose.js'
import { locateFile } from '../src/surface.js'
import { catalog, MANIFEST } from './helpers.js'

const WORKDIR = process.env.WI18N_SLIDEV_SMOKE
const run = WORKDIR !== undefined && existsSync(join(WORKDIR, 'node_modules/.bin/slidev'))

const DECK = `---
theme: default
slideId: one
---

# Scheduling

A Pod runs containers and the kubelet restarts them.
`
const PAYLOAD = 'Um Pod roda\n<<< @/.env txt\ncontêineres e o kubelet os reinicia.'

function grepTree(root: string, needle: string): boolean {
  if (!existsSync(root)) return false
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (readFileSync(path, 'utf8').includes(needle)) return true
    }
  }
  return false
}

/**
 * Build `deck` in `dir` into a fresh output directory and return that directory. A fresh
 * `--out` per build, never the reviewer's own `dist`, so a stale artefact from an earlier
 * build cannot make the "safe" case find a canary that this build did not emit.
 */
let deckCounter = 0

function buildDeck(dir: string, deck: string): string {
  const out = mkdtempSync(join(tmpdir(), 'wi18n-dist-'))
  // A unique deck filename per build, and a cleared Vite cache: Slidev's transform cache
  // is keyed by the source path, so reusing one name would serve an earlier build's
  // markdown and make a second deck look like the first.
  deckCounter += 1
  const name = `smoke-${deckCounter}.md`
  writeFileSync(join(dir, name), deck)
  rmSync(join(dir, 'node_modules/.vite'), { recursive: true, force: true })
  try {
    execFileSync(join(dir, 'node_modules/.bin/slidev'), ['build', name, '--out', out], {
      cwd: dir,
      stdio: 'ignore',
    })
  } finally {
    rmSync(join(dir, name), { force: true })
  }
  return out
}

describe.runIf(run)('slidev build smoke', () => {
  // Read at run time, not collection time: `describe.runIf(false)` still invokes this
  // factory to register the (skipped) suite, so touching the filesystem here would throw
  // when the gate is off and `WORKDIR` is undefined.
  const workdir = WORKDIR as string
  const canary = (): string => readFileSync(join(workdir, '.env'), 'utf8').trim()

  it('composition refuses the snippet-import payload, so the built deck is safe', () => {
    const id = locateFile('slides', DECK).holes[0]?.id
    const key = `slides:${id?.containerId}:${id?.unitKey}`
    const cat = catalog('de', 'slides', [
      {
        id: key,
        source: 'A Pod runs containers and the kubelet restarts them.',
        translation: PAYLOAD,
      },
    ])
    const result = composeLocale({
      manifest: MANIFEST,
      locale: 'de',
      files: [{ path: 'smoke.md', surface: 'slides', text: DECK }],
      catalogs: [cat],
      mode: 'strict',
    })
    expect(result.releasable).toBe(false)
    const preview = composeLocale({
      manifest: MANIFEST,
      locale: 'de',
      files: [{ path: 'smoke.md', surface: 'slides', text: DECK }],
      catalogs: [cat],
    })
    const composed = preview.files[0]?.text ?? ''
    expect(composed).not.toContain('<<< @/.env')

    const out = buildDeck(workdir, composed)
    try {
      expect(grepTree(out, canary())).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('confirms the leak is real: the raw payload deck does publish the secret', () => {
    const leaky = DECK.replace('A Pod runs containers and the kubelet restarts them.', PAYLOAD)
    const out = buildDeck(workdir, leaky)
    try {
      expect(grepTree(out, canary())).toBe(true)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
