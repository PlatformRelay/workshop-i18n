/**
 * Differential test: this package's slide splitter against Slidev's own parser.
 *
 * `deck.ts` states its contract as *agreement with the renderer* — a splitter that
 * disagrees keys prose under a slide the audience never sees, mints identities for slides
 * that do not exist, and lets `init-ids` write into a speaker note, all while `--check`
 * passes. Only running Slidev over the same bytes can show that.
 *
 * ## This evidence is developer-local unless CI is wired for it
 *
 * `@slidev/parser` is deliberately not a dependency here: ~390 transitive packages is a
 * poor supply-chain trade against the four this package needs at runtime. So the parser
 * is resolved from outside and the comparison skips when it is absent:
 *
 * ```sh
 * WORKSHOP_I18N_SLIDEV_PARSER=/path/to/kubernetes-workshop pnpm test
 * ```
 *
 * With nothing set — which today includes CI — **the comparison below asserts nothing**.
 * That is worth saying plainly rather than letting a green run imply it happened. What
 * does run unconditionally is the guard at the bottom: if the variable *is* set and the
 * parser cannot be loaded, that fails, so a typo in the path can never masquerade as a
 * clean skip.
 *
 * ## Two corpora, because fixtures alone were not enough
 *
 * Fixtures only exercise the constructs someone thought to write down, and twice a real
 * divergence hid in a shape none of them contained. So the comparison runs over the
 * vendored corpus *and* over `SCANNER_SHAPES`: one minimal file per branch and boundary
 * of Slidev's scanner, written by reading `dist/core.mjs` rather than by guessing.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findSpeakerNote, parseSlidevDeck } from '../src/deck.js'
import { decodeSource } from '../src/source.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))
const PARSER_HINT = process.env.WORKSHOP_I18N_SLIDEV_PARSER

interface SlidevSlide {
  readonly content?: string
  readonly note?: string
  readonly frontmatter?: Readonly<Record<string, unknown>>
}

type ParseSync = (markdown: string, filepath: string) => { readonly slides: readonly SlidevSlide[] }

/** Resolve Slidev's parser from outside this repo, or return `undefined` to skip. */
async function loadParseSync(): Promise<ParseSync | undefined> {
  const candidates = [
    ...(PARSER_HINT === undefined ? [] : [PARSER_HINT]),
    fileURLToPath(import.meta.url),
  ]
  for (const from of candidates) {
    try {
      const specifier = /\.[cm]?js$/.test(from) ? from : join(from, 'noop.js')
      const resolved = createRequire(specifier).resolve('@slidev/parser')
      const loaded = (await import(resolved)) as { parseSync?: ParseSync }
      if (typeof loaded.parseSync === 'function') return loaded.parseSync
    } catch {
      // Try the next candidate; an unavailable parser is a skip, never a failure.
    }
  }
  return undefined
}

const parseSync = await loadParseSync()

interface Sample {
  readonly name: string
  readonly source: string
}

function loadFixtures(directory: string): readonly Sample[] {
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
 * One minimal file per branch and boundary of Slidev's scanner.
 *
 * Derived from `core.mjs` by reading it: the comment state machine, the `line[3] !== "-"`
 * guard, the `startsWith(level)` fence close, the unclosed-fence fallthrough, the
 * whitespace-inclusive fence level, and the trailing-slice boundary. Fixtures are real
 * content and therefore accidental about which branches they touch; these are not.
 */
const SCANNER_SHAPES: readonly Sample[] = [
  { name: 'separator inside a comment', source: '# A\n\n<!--\nnote\n\n---\n\nmore\n-->\n' },
  { name: 'comment opened and closed on one line', source: 'a <!-- x --> b\n\n---\n\nc\n' },
  { name: 'two comments on one line', source: '<!-- a --> t <!-- b -->\n\n---\n\nc\n' },
  { name: 'comment reopened after closing', source: '<!-- a -->\n\n<!--\n---\n-->\n\n---\n\nc\n' },
  { name: 'comment never closed', source: 'a\n\n<!--\nnote\n\n---\n\nmore\n' },
  { name: 'four dashes open no block', source: '# A\n\n----\nlayout: x\n---\n\nb\n' },
  { name: 'three dashes open a block', source: '# A\n\n---\nlayout: x\n---\n\nb\n' },
  {
    name: 'separator with trailing text opens a block',
    source: '# A\n\n--- x\nlayout: y\n---\n\nb\n',
  },
  { name: 'separator followed by a blank line', source: '# A\n\n---\n\nb\n' },
  { name: 'indented separator is content', source: '# A\n\n ---\n\nb\n' },
  {
    name: 'fence closed by a different info string',
    source: '```md\n```ts\na\n```\n```\n\n---\n\nb\n',
  },
  { name: 'fence never closed', source: '```yaml\nk: v\n\n---\n\nb\n' },
  {
    name: 'fence indented past four spaces',
    source: '    ```yaml\nk: v\n---\n    ```\n\n---\n\nb\n',
  },
  { name: 'four backticks around three', source: '````md\n```ts\n---\n```\n````\n\n---\n\nb\n' },
  { name: 'tilde run is not a fence', source: '~~~yaml\nk: v\n~~~\n\n---\n\nb\n' },
  { name: 'trailing separator with a newline', source: '# A\n\n---\n' },
  { name: 'trailing separator with no newline', source: '# A\n\n---' },
  { name: 'file that is only a separator', source: '---' },
  { name: 'empty file', source: '' },
  { name: 'two separators in a row', source: '---\n---\n\nb\n' },
  { name: 'headmatter then bare slide', source: '---\nlayout: x\n---\n\na\n\n---\n\nb\n' },
  { name: 'CRLF throughout', source: '---\r\nlayout: x\r\n---\r\n\r\na\r\n\r\n---\r\n\r\nb\r\n' },
  { name: 'separator followed by a whitespace-only line', source: '# A\n\n---\n   \nb\n' },
  {
    name: 'block closed by a delimiter with trailing spaces',
    source: '---\nlayout: x\n---  \n\nb\n',
  },
  { name: 'fence closed by a longer backtick run', source: '```yaml\nk: v\n````\n\n---\n\nb\n' },
  {
    name: 'indented fence whose close sits at column zero',
    source: '  ```yaml\nk: v\n```\n---\n\nb\n',
  },
  {
    name: 'separator immediately after a fence close',
    source: '```\na\n```\n---\nlayout: x\n---\n\nb\n',
  },
]

/**
 * Fixtures where this splitter deliberately differs, each with the reason and a
 * normalization that removes *only* the documented cause.
 *
 * The normalized source is then compared in full, so an exemption cannot hide a second,
 * undocumented disagreement behind the first — which is exactly what dropping the fixture
 * from the comparison used to do.
 */
const DOCUMENTED_DIVERGENCES = new Map<
  string,
  { readonly reason: string; readonly normalize: (source: string) => string }
>([
  [
    'adversarial/crlf-and-bom.md',
    {
      reason:
        'Slidev does not strip a byte-order mark, so it never sees the headmatter delimiter; this scan ignores the mark when matching the first line and copies it through untouched (deck.ts).',
      normalize: (source) => source.replace(/^﻿/, ''),
    },
  ],
])

const CORPUS = [...loadFixtures('corpus-k8s'), ...loadFixtures('adversarial')]

/**
 * Line endings are the one text difference that is required rather than tolerated:
 * Slidev rebuilds slide content from `split(/\r?\n/)`, so it reports LF for a CRLF file,
 * while ADR 0012 forbids this package from normalizing a single byte.
 */
function comparableText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

/** Compare one source against Slidev, slide by slide. */
function expectAgreement(parse: ParseSync, name: string, source: string): void {
  const theirs = parse(source, name).slides
  const mine = parseSlidevDeck(source).slides

  expect({ sample: name, slides: mine.length }).toEqual({ sample: name, slides: theirs.length })

  for (const [index, slide] of mine.entries()) {
    const where = `${name} slide ${index}`
    const theirKeys = Object.keys(theirs[index]?.frontmatter ?? {}).length > 0

    // Slidev parses each slide twice: its scanner decides the boundaries, then
    // `parseSlide` re-reads the slice with a gray-matter regex. On a slide whose text
    // does not begin with a `---` line the two disagree with *each other* — gray-matter
    // will read `k: v` out of an indented fence as frontmatter that the scanner never
    // opened. Only the scanner decides where slides break, and that is the contract this
    // package has to meet, so text is compared only where both Slidev layers agree.
    const opensWithSeparator = /^---/.test(source.slice(slide.start === 0 ? 0 : slide.start - 1))
    const secondLayerOnly = theirKeys && slide.frontmatter === undefined && !opensWithSeparator
    if (secondLayerOnly) continue

    const note = findSpeakerNote(source, slide.bodyStart, slide.bodyEnd)
    const body = source.slice(slide.bodyStart, note?.start ?? slide.bodyEnd)
    const noteText = note === undefined ? '' : source.slice(note.innerStart, note.innerEnd)

    expect({ where, body: comparableText(body) }).toEqual({
      where,
      body: comparableText(theirs[index]?.content ?? ''),
    })
    expect({ where, note: comparableText(noteText) }).toEqual({
      where,
      note: comparableText(theirs[index]?.note ?? ''),
    })
    // One-directional on purpose: Slidev reports the *parsed* frontmatter, so an empty
    // `---\n---` block is `{}` to it and a real block to this scan. What must never
    // happen is the reverse — YAML the renderer hides being offered up as prose.
    if (theirKeys) {
      expect({ where, hasFrontmatter: slide.frontmatter !== undefined }).toEqual({
        where,
        hasFrontmatter: true,
      })
    }
  }
}

describe('the differential test says whether it ran', () => {
  it('fails when a parser was named but could not be loaded, rather than skipping quietly', () => {
    if (PARSER_HINT === undefined) {
      expect(parseSync).toBeUndefined()
      return
    }
    expect(
      parseSync,
      `WORKSHOP_I18N_SLIDEV_PARSER=${PARSER_HINT} did not resolve @slidev/parser`,
    ).toBeDefined()
  })
})

describe.skipIf(parseSync === undefined)('slide splitting agrees with @slidev/parser', () => {
  const parse = parseSync as ParseSync

  it.each(SCANNER_SHAPES.map((sample) => [sample.name, sample] as const))(
    'scanner shape: %s',
    (_name, sample) => {
      expectAgreement(parse, sample.name, sample.source)
    },
  )

  it.each(CORPUS.map((sample) => [sample.name, sample] as const))(
    '%s: same slides, same bodies, same notes',
    (_name, sample) => {
      const divergence = DOCUMENTED_DIVERGENCES.get(sample.name)
      expectAgreement(
        parse,
        sample.name,
        divergence === undefined ? sample.source : divergence.normalize(sample.source),
      )
    },
  )

  it.each([...DOCUMENTED_DIVERGENCES.keys()])(
    '%s still diverges on the raw source, so the exemption is not stale',
    (name) => {
      const sample = CORPUS.find((candidate) => candidate.name === name)
      expect(sample).toBeDefined()
      const source = (sample as Sample).source
      expect(parseSlidevDeck(source).slides[0]?.frontmatter).toBeDefined()
      expect(Object.keys(parse(source, name).slides[0]?.frontmatter ?? {})).toEqual([])
    },
  )
})
