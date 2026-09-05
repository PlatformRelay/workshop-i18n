/**
 * The four round-trip property groups spec 001 SC-003 names, run over **every** fixture
 * in the hostile corpus rather than a curated subset: losslessness, fence identity,
 * identity stability under edit/move/reorder, and determinism.
 *
 * The corpus is real consumer content (see `fixtures/PROVENANCE.md`), which is the whole
 * point: a fixture set assembled from slides the locator already handles proves nothing.
 * `describes the corpus it claims to test` below is the guard against that — it fails if
 * the corpus stops containing the constructs these properties exist to survive.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { parseSlidevDeck } from '../src/deck.js'
import type { DiagnosticCode } from '../src/diagnostic.js'
import { extractSlidevFile, locateSlidevFile, SlidevExtractionError } from '../src/extract.js'
import { planSlideIds, type SlideIdPlan } from '../src/init-ids.js'
import { composeSkeleton } from '../src/skeleton.js'
import { decodeSource } from '../src/source.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))

interface Fixture {
  readonly name: string
  readonly bytes: Buffer
  readonly source: string
  readonly sectionId: string
}

function load(directory: string): readonly Fixture[] {
  const base = join(FIXTURE_ROOT, directory)
  return readdirSync(base)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(base, name))
      return {
        name: `${directory}/${name}`,
        bytes,
        source: decodeSource(bytes, name),
        sectionId: name.replace(/\.md$/, ''),
      }
    })
}

/** Every fixture that must round-trip. */
const CORPUS: readonly Fixture[] = [...load('corpus-k8s'), ...load('adversarial')]

/** Fixtures that must be refused, and the diagnostic each must raise. */
const REJECTED: readonly (readonly [string, DiagnosticCode])[] = [
  ['duplicate-slide-id.md', 'duplicate-slide-id'],
  ['malformed-frontmatter.md', 'malformed-frontmatter'],
  ['missing-slide-id.md', 'missing-slide-id'],
  ['separator-in-tilde-fence.md', 'separator-in-tilde-fence'],
  ['unclosed-frontmatter.md', 'unclosed-frontmatter'],
  ['unsafe-slide-id.md', 'unsafe-slide-id'],
]

/** Give every slide an identity, the way an adopting consumer runs `init-ids` once. */
function adopt(fixture: Fixture): string {
  return planSlideIds(fixture.source, { sectionId: fixture.sectionId }).text
}

/**
 * An independent fenced-code scanner, deliberately *not* the one under test: if the
 * locator's own fence tracking were wrong, asking it to check itself would agree.
 */
function fenceBlocks(text: string): readonly string[] {
  const blocks: string[] = []
  let open: { marker: string; length: number; lines: string[] } | undefined
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    const run = match?.[1]
    if (open === undefined) {
      if (run !== undefined && (run[0] !== '`' || !(match?.[2] ?? '').includes('`'))) {
        open = { marker: run[0] as string, length: run.length, lines: [line] }
      }
      continue
    }
    open.lines.push(line)
    const closes =
      run !== undefined &&
      run[0] === open.marker &&
      run.length >= open.length &&
      (match?.[2] ?? '').trim() === ''
    if (closes) {
      blocks.push(open.lines.join('\n'))
      open = undefined
    }
  }
  if (open !== undefined) blocks.push(open.lines.join('\n'))
  return blocks
}

/** Frontmatter machinery lines, which must be identical in every locale. */
function machineryLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .filter((line) =>
      /^(layout|src|image|lab|class|clicks|section|tier|track|compact|columns|zoom|slideId):/.test(
        line,
      ),
    )
}

/** Slide chunks, each starting at its own separator, so they can be moved around. */
function slideChunks(text: string): readonly string[] {
  const deck = parseSlidevDeck(text)
  return deck.slides.map((slide, index) => {
    const from = index === 0 ? 0 : (deck.slides[index - 1]?.end ?? 0)
    const chunk = text.slice(from, slide.end)
    return chunk.endsWith('\n') ? chunk : `${chunk}\n`
  })
}

/**
 * Delete exactly what the plan inserted and expect the original file back — the literal
 * reading of "no other byte changes" (spec 001 AS-1).
 *
 * Removing the insertions in ascending order needs no offset arithmetic: each removal
 * cancels the shift its own insertion introduced, so insertion `i` is back at the offset
 * the plan recorded by the time its turn comes.
 */
function withoutInsertions(plan: SlideIdPlan): string {
  let text = plan.text
  for (const insertion of plan.insertions) {
    text = text.slice(0, insertion.offset) + text.slice(insertion.offset + insertion.text.length)
  }
  return text
}

function idsOf(text: string): readonly string[] {
  return extractSlidevFile(text).units.map((unit) => formatUnitId(unit.id))
}

describe.each(CORPUS.map((fixture) => [fixture.name, fixture] as const))(
  'round-trip properties over %s',
  (_name, fixture) => {
    const adopted = adopt(fixture)
    const extraction = extractSlidevFile(adopted)

    // Group 1 — losslessness.
    it('decodes and re-encodes without losing a byte', () => {
      expect(decodeSource(fixture.bytes)).toBe(fixture.source)
      expect(Buffer.from(fixture.source, 'utf8')).toEqual(fixture.bytes)
    })

    it('adopts identities by insertion only', () => {
      const plan = planSlideIds(fixture.source, { sectionId: fixture.sectionId })
      expect(withoutInsertions(plan)).toBe(fixture.source)
    })

    it('reproduces the source byte-for-byte from an empty catalog (SC-002)', () => {
      const composed = composeSkeleton(extraction.skeleton, {})
      expect(composed).toBe(adopted)
      expect(Buffer.from(composed, 'utf8')).toEqual(Buffer.from(adopted, 'utf8'))
    })

    it('treats translating every unit to its own English as a no-op', () => {
      const identity = Object.fromEntries(
        extraction.units.map((unit) => [formatUnitId(unit.id), unit.source]),
      )
      expect(composeSkeleton(extraction.skeleton, identity)).toBe(adopted)
    })

    it('raises no error diagnostic', () => {
      expect(extraction.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    })

    // Group 2 — fence identity and protected skeleton.
    it('keeps every fenced block and machinery key byte-identical when everything is translated', () => {
      const translations = Object.fromEntries(
        extraction.units.map((unit, index) => [formatUnitId(unit.id), `de-${index}`]),
      )
      const translated = composeSkeleton(extraction.skeleton, translations)
      expect(fenceBlocks(translated)).toEqual(fenceBlocks(adopted))
      expect(machineryLines(translated)).toEqual(machineryLines(adopted))
      expect(translated).not.toBe(adopted)
    })

    it('never emits a fence delimiter or a slide separator as translatable text', () => {
      for (const unit of extraction.units) {
        for (const line of unit.source.split('\n')) {
          expect(line).not.toMatch(/^ {0,3}(?:`{3,}|~{3,})/)
          expect(line.trimEnd()).not.toBe('---')
        }
      }
    })

    // Group 3 — identity stability.
    it('changes one hash and no identity when one unit of English is edited (AS-2)', () => {
      const hole = extraction.skeleton.holes.find((item) => item.encoding.kind === 'markdown')
      if (hole === undefined) return
      const edited = `${adopted.slice(0, hole.end)} (edited)${adopted.slice(hole.end)}`
      const after = extractSlidevFile(edited).units
      expect(after.map((unit) => formatUnitId(unit.id))).toEqual(
        extraction.units.map((unit) => formatUnitId(unit.id)),
      )
      const moved = after.filter(
        (unit, index) => unit.sourceHash !== extraction.units[index]?.sourceHash,
      )
      expect(moved.map((unit) => formatUnitId(unit.id))).toEqual([formatUnitId(hole.id)])
    })

    it('keeps every identity when the deck is reordered (AS-3)', () => {
      const chunks = slideChunks(adopted)
      if (chunks.length < 3) return
      const reordered = [chunks[0] ?? '', ...chunks.slice(1).reverse()].join('')
      expect([...idsOf(reordered)].sort()).toEqual([...idsOf(adopted)].sort())
    })

    it('keeps every identity when slides move to another file (AS-3)', () => {
      const chunks = slideChunks(adopted)
      if (chunks.length < 2) return
      const middle = Math.ceil(chunks.length / 2)
      const head = chunks.slice(0, middle).join('')
      const tail = chunks.slice(middle).join('')
      expect([...idsOf(head), ...idsOf(tail)].sort()).toEqual([...idsOf(adopted)].sort())
    })

    // Group 4 — determinism.
    it('yields identical output for identical input (FR-006)', () => {
      expect(extractSlidevFile(adopted)).toEqual(extractSlidevFile(adopted))
      expect(planSlideIds(fixture.source, { sectionId: fixture.sectionId })).toEqual(
        planSlideIds(fixture.source, { sectionId: fixture.sectionId }),
      )
    })

    it('emits units in identity order', () => {
      const ids = extraction.units.map((unit) => formatUnitId(unit.id))
      expect(ids).toEqual([...ids].sort())
      expect(new Set(ids).size).toBe(ids.length)
    })
  },
)

describe('the hostile corpus describes the corpus it claims to test', () => {
  const all = CORPUS.map((fixture) => fixture.source).join('\n')

  it('is large enough to be worth running', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20)
    const units = CORPUS.reduce(
      (total, fixture) => total + extractSlidevFile(adopt(fixture)).units.length,
      0,
    )
    expect(units).toBeGreaterThan(500)
  })

  it.each([
    ['a magic-move fence nesting three backticks in four', /````md magic-move\n```/],
    ['a bare document separator inside a fence', /```yaml[^\n]*\n(?:[^\n]*\n)*?---\n/],
    ['a tilde fence', /^~~~/m],
    ['a line-highlight info string', /```\w+ \{[^}]*\|/],
    ['a src: include', /^src: /m],
    ['a GFM table alignment row', /^\| :?-+:? \|/m],
    ['a setext heading', /^=====+$/m],
    ['a hard line break', / {2}$/m],
    ['an HTML-comment speaker note', /<!--\nSpeaker:/],
    ['a Vue island', /<v-clicks?[ >]/],
    ['a custom component', /<KwCard /],
    ['mustache interpolation', /\{\{ /],
    ['an astral emoji', /[\u{1f300}-\u{1faff}]/u],
    ['box drawing', /[─│└┬┼├]/],
    ['a YAML doubled-quote escape', /: '[^'\n]*''/],
    ['a YAML block scalar', /^\w+: \|$/m],
  ])('contains %s', (_label, pattern) => {
    expect(all).toMatch(pattern)
  })

  it('contains a CRLF file and a byte-order mark', () => {
    expect(CORPUS.some((fixture) => fixture.source.includes('\r\n'))).toBe(true)
    expect(CORPUS.some((fixture) => fixture.source.startsWith('﻿'))).toBe(true)
  })

  it('contains files with many frontmatter blocks and a file with almost none', () => {
    const blocks = CORPUS.map(
      (fixture) =>
        parseSlidevDeck(fixture.source).slides.filter((slide) => slide.frontmatter !== undefined)
          .length,
    )
    expect(Math.max(...blocks)).toBeGreaterThanOrEqual(8)
    expect(Math.min(...blocks)).toBeLessThanOrEqual(2)
  })
})

describe.each(REJECTED)('fixtures/adversarial-rejected/%s', (name, code) => {
  const source = decodeSource(readFileSync(join(FIXTURE_ROOT, 'adversarial-rejected', name)))

  it(`fails closed with a ${code} diagnostic`, () => {
    expect(() => extractSlidevFile(source)).toThrow(SlidevExtractionError)
    const located = locateSlidevFile(source)
    expect(located.diagnostics.map((item) => item.code)).toContain(code)
    expect(located.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it('still reproduces the file byte-for-byte, because refusing is not mangling', () => {
    const located = locateSlidevFile(source)
    expect(composeSkeleton(located.skeleton, {})).toBe(source)
  })
})
