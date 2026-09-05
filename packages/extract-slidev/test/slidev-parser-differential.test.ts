/**
 * Differential test: this package's slide splitter against Slidev's own parser.
 *
 * `deck.ts` states its contract as *agreement with the renderer* — a splitter that
 * disagrees with Slidev keys prose under a slide the audience never sees, and
 * `init-ids --check` still passes. "Zero diagnostics over the corpus" cannot prove that;
 * only running both parsers over the same bytes can.
 *
 * `@slidev/parser` is deliberately **not** a dependency of this repo. It pulls ~390
 * packages, which is a poor supply-chain trade for a test — but that reasoning does not
 * apply when a consumer workshop already has it installed next door. So the test
 * resolves it from outside and skips itself when it cannot:
 *
 * ```sh
 * WORKSHOP_I18N_SLIDEV_PARSER=/path/to/kubernetes-workshop pnpm test
 * ```
 *
 * The variable takes the directory to resolve `@slidev/parser` from (a consumer repo
 * root), or the path to the module itself. With nothing set — CI, a fresh clone — the
 * suite skips rather than failing, and the corpus properties still run.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findSpeakerNote, parseSlidevDeck } from '../src/deck.js'
import { decodeSource } from '../src/source.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))

interface SlidevSlide {
  readonly content?: string
  readonly note?: string
  readonly frontmatter?: Readonly<Record<string, unknown>>
}

type ParseSync = (markdown: string, filepath: string) => { readonly slides: readonly SlidevSlide[] }

/** Resolve Slidev's parser from outside this repo, or return `undefined` to skip. */
async function loadParseSync(): Promise<ParseSync | undefined> {
  const hint = process.env.WORKSHOP_I18N_SLIDEV_PARSER
  const candidates = [
    ...(hint === undefined ? [] : [hint, join(hint, 'noop.js')]),
    fileURLToPath(import.meta.url),
  ]
  for (const from of candidates) {
    try {
      const specifier = from.endsWith('.mjs') || from.endsWith('.js') ? from : join(from, 'noop.js')
      const resolved = createRequire(specifier).resolve('@slidev/parser')
      const module = (await import(resolved)) as { parseSync?: ParseSync }
      if (typeof module.parseSync === 'function') return module.parseSync
    } catch {
      // Try the next candidate; an unavailable parser is a skip, never a failure.
    }
  }
  return undefined
}

const parseSync = await loadParseSync()

interface Fixture {
  readonly name: string
  readonly source: string
}

function load(directory: string): readonly Fixture[] {
  const base = join(FIXTURE_ROOT, directory)
  return readdirSync(base)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      name: `${directory}/${name}`,
      source: decodeSource(readFileSync(join(base, name)), name),
    }))
}

/**
 * Fixtures where this splitter deliberately differs from Slidev, with the reason. Each is
 * still compared for everything *except* the documented divergence, so a fixture cannot
 * hide a second, undocumented disagreement behind the first.
 */
const DOCUMENTED_DIVERGENCES = new Map<string, string>([
  [
    'adversarial/crlf-and-bom.md',
    'Slidev does not strip a byte-order mark, so it does not see the headmatter delimiter; this splitter ignores the mark when matching the first line and copies it through untouched (deck.ts).',
  ],
])

const CORPUS = [...load('corpus-k8s'), ...load('adversarial')]

describe.skipIf(parseSync === undefined)('slide splitting agrees with @slidev/parser', () => {
  const parse = parseSync as ParseSync

  it('found a parser to compare against', () => {
    expect(typeof parse).toBe('function')
  })

  it.each(
    CORPUS.filter((fixture) => !DOCUMENTED_DIVERGENCES.has(fixture.name)).map(
      (fixture) => [fixture.name, fixture] as const,
    ),
  )('%s: same slides, same bodies, same notes', (_name, fixture) => {
    const theirs = parse(fixture.source, fixture.name).slides
    const mine = parseSlidevDeck(fixture.source).slides

    expect(mine).toHaveLength(theirs.length)

    for (const [index, slide] of mine.entries()) {
      const note = findSpeakerNote(fixture.source, slide.bodyStart, slide.bodyEnd)
      const body = fixture.source.slice(slide.bodyStart, note?.start ?? slide.bodyEnd).trim()
      const noteText =
        note === undefined ? '' : fixture.source.slice(note.innerStart, note.innerEnd)

      expect({ slide: index, body }).toEqual({
        slide: index,
        body: (theirs[index]?.content ?? '').trim(),
      })
      expect({ slide: index, note: noteText.trim() }).toEqual({
        slide: index,
        note: (theirs[index]?.note ?? '').trim(),
      })
      expect({ slide: index, hasFrontmatter: slide.frontmatter !== undefined }).toEqual({
        slide: index,
        hasFrontmatter: Object.keys(theirs[index]?.frontmatter ?? {}).length > 0,
      })
    }
  })

  it.each([...DOCUMENTED_DIVERGENCES])('%s diverges only where it is documented to', (name) => {
    const fixture = CORPUS.find((candidate) => candidate.name === name)
    expect(fixture).toBeDefined()
    const source = (fixture as Fixture).source
    // The divergence is real, so this must actually differ — a fixture listed here that
    // has quietly started agreeing is a stale exemption, not a passing test.
    expect(parseSlidevDeck(source).slides[0]?.frontmatter).toBeDefined()
    expect(Object.keys(parse(source, name).slides[0]?.frontmatter ?? {})).toEqual([])
  })
})
