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
import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { findSpeakerNote, parseSlidevDeck } from '../src/deck.js'
import { extractSlidevFile } from '../src/extract.js'
import { planSlideIds } from '../src/init-ids.js'
import { CompositionError, composeSkeleton, type Hole, type Skeleton } from '../src/skeleton.js'
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
  {
    name: 'leading separator with a dash run hidden in a note',
    source: '---\n\n# A\n\nprose\n\n<!--\nSpeaker: note\n---\n-->\n',
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
 * Translator text that would restructure a deck if composition let it through.
 *
 * Each one must either be refused by `composeSkeleton` or leave Slidev's view of the deck
 * identical. Which of the two does not matter; silently changing the deck does.
 */
const HOSTILE_TRANSLATIONS: readonly (readonly [string, string])[] = [
  ['a bare separator line', 'eins\n---\nzwei'],
  ['a separator with trailing text', 'eins\n--- und mehr\nzwei'],
  ['a longer dash run', 'eins\n-----x\nzwei'],
  ['a separator with a no-break space', 'eins\n---\u00a0\nzwei'],
  ['an indented fence', 'eins\n    \u0060\u0060\u0060yaml\nzwei'],
  ['a tab-indented fence', 'eins\n\t\u0060\u0060\u0060yaml\nzwei'],
  ['a bare fence', 'eins\n\u0060\u0060\u0060\nzwei'],
  ['a tilde fence', 'eins\n~~~yaml\nzwei'],
  ['an em dash typed as three hyphens', 'Erste --- Zweite'],
  ['an HTML comment opener', 'eins <!-- zwei'],
  ['an HTML comment terminator', 'eins --> zwei'],
  ['a yaml code block opener', 'eins\n\u0060\u0060\u0060yaml\nlayout: cover\nzwei'],
  ['a bare fence with nothing else', '\u0060\u0060\u0060'],
  ['a trailing double hyphen', '--'],
  ['a bare pipe', 'eins | zwei'],
  ['plain words that carry nothing across', 'schlicht'],
]

/**
 * True when replacing this hole's whole text with `payload` *must* be refused.
 *
 * The sweeps assert that composition either refuses or changes nothing Slidev can see,
 * which by construction cannot host a payload whose whole point is to be refused — so the
 * guards against dropping a comment delimiter and against adding a table column were held
 * by one hand-written test each. This says which pairs have no second option.
 */
function mustBeRefused(hole: Hole, payload: string): boolean {
  if (hole.encoding.kind !== 'markdown') return false
  const count = (text: string, token: string): number => text.split(token).length - 1
  for (const token of ['<!--', '-->']) {
    if (count(payload, token) !== count(hole.source, token)) return true
  }
  const barePipes = (text: string): number => count(text.replace(/\\\|/g, ''), '|')
  return hole.encoding.cell && barePipes(payload) > barePipes(hole.source)
}

/**
 * A hole's splice context — what sits before it on its line — bucketed, so the sweep
 * reaches one hole of each kind rather than only the first one that refuses.
 */
function representativeHoles(skeleton: Skeleton, source: string): readonly Hole[] {
  const byBucket = new Map<string, Hole>()
  for (const hole of skeleton.holes) {
    const prefix = source.slice(source.lastIndexOf('\n', hole.start - 1) + 1, hole.start)
    const shape = prefix === '' ? 'start' : prefix.trim() === '' ? 'blank' : 'text'
    const kind = hole.encoding.kind === 'markdown' ? hole.encoding.context : hole.encoding.kind
    const bucket = `${kind}/${shape}`
    if (!byBucket.has(bucket)) byBucket.set(bucket, hole)
  }
  return [...byBucket.values()]
}

/**
 * A marker translation that keeps whatever comment delimiters the English unit carried.
 *
 * A unit spans a whole paragraph, so an inline `<!-- aside -->` is part of the msgid.
 * Dropping a delimiter is refused — correctly, since the comment would swallow the slides
 * after it — so a sweep that replaces a unit wholesale has to carry them across, exactly
 * as a translator must.
 */
function markerFor(source: string, index: number): string {
  const count = (token: string): number => source.split(token).length - 1
  return [
    `de-${index}`,
    ...Array.from({ length: count('<!--') }, () => '<!--'),
    ...Array.from({ length: count('-->') }, () => '-->'),
  ].join(' ')
}

/** What Slidev sees: the slides, their frontmatter keys, and their identities. */
function structureOf(parse: ParseSync, source: string): unknown {
  return parse(source, 'structure.md').slides.map((slide) => ({
    keys: Object.keys(slide.frontmatter ?? {}).sort(),
    slideId: (slide.frontmatter as { slideId?: unknown } | undefined)?.slideId ?? null,
  }))
}

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
    // `matter()` re-reads the slice with two hand-rolled regexes. Where the scanner opened
    // no `---` block, `matter()` still tries `RE_YAML_CODEBLOCK` and can call a leading
    // ```yaml fence the frontmatter — so the two Slidev layers disagree with each other.
    // Only the scanner decides where slides break, which is this package's contract, so
    // text is compared only where both layers agree — and the exemption asserts *why* it
    // applies rather than trusting the shape of the disagreement.
    if (theirKeys && slide.frontmatter === undefined) {
      // Both ways `matter()` can find a block the scanner never opened. Each is refused by
      // extraction, so the exemption names which one applies rather than waving the slide
      // through on the shape of the disagreement alone.
      const raw = source.slice(slide.separator?.start ?? slide.start, slide.end)
      expect({ where, secondLayerFrontmatter: true }).toEqual({
        where,
        secondLayerFrontmatter:
          /^\s*```ya?ml/.test(source.slice(slide.bodyStart, slide.end)) ||
          /^---.*\r?\n[\s\S]*?---/.test(raw),
      })
      continue
    }

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

  it.each(CORPUS.map((sample) => [sample.name, sample] as const))(
    '%s: translating it changes no slide, no identity and no frontmatter key',
    (_name, sample) => {
      // The differential ran Slidev over what goes *in* and never over what comes out,
      // while `skeleton.ts` claimed composition fails closed on render-time hazards. Every
      // guard that claim rests on was CommonMark's rather than Slidev's, and three of them
      // were wrong. This is the check that decides it mechanically.
      const divergence = DOCUMENTED_DIVERGENCES.get(sample.name)
      const adopted = planSlideIds(
        divergence === undefined ? sample.source : divergence.normalize(sample.source),
        { sectionId: sample.name },
      ).text
      const extraction = extractSlidevFile(adopted)
      const translations = Object.fromEntries(
        extraction.units.map((unit, index) => [
          formatUnitId(unit.id),
          `${markerFor(unit.source, index)} — Ü "3" ✓ 🧑‍🚀 <b>x</b>: y`,
        ]),
      )
      expect(structureOf(parse, composeSkeleton(extraction.skeleton, translations))).toEqual(
        structureOf(parse, adopted),
      )
    },
  )

  it.each(HOSTILE_TRANSLATIONS)(
    'a translation containing %s is refused, or changes nothing Slidev can see',
    (_label, text) => {
      for (const sample of CORPUS) {
        const divergence = DOCUMENTED_DIVERGENCES.get(sample.name)
        const adopted = planSlideIds(
          divergence === undefined ? sample.source : divergence.normalize(sample.source),
          { sectionId: sample.name },
        ).text
        const extraction = extractSlidevFile(adopted)
        if (extraction.units.length === 0) continue
        const baseline = structureOf(parse, adopted)
        // One hole at a time, one per splice context. Translating everything at once let a
        // single refusal — always the frontmatter `---` guard — stand in for every hole,
        // so five of these strings never reached the markdown guards they were written for.
        for (const hole of representativeHoles(extraction.skeleton, adopted)) {
          const where = `${sample.name} ${formatUnitId(hole.id)} <- ${JSON.stringify(text)}`
          let composed: string
          try {
            composed = composeSkeleton(extraction.skeleton, { [formatUnitId(hole.id)]: text })
          } catch (error) {
            expect(error).toBeInstanceOf(CompositionError)
            continue
          }
          expect(mustBeRefused(hole, text), `${where} was accepted`).toBe(false)
          expect(structureOf(parse, composed), where).toEqual(baseline)
        }
      }
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
