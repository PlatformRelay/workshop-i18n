/**
 * The four round-trip property groups spec 001 SC-003 names, run over **every** lab
 * fixture rather than a curated subset: losslessness, fence/structure identity, identity
 * stability under edit/move/reorder, and determinism.
 *
 * The corpus is real consumer content (`fixtures/PROVENANCE.md`), which is the whole
 * point: a fixture set assembled from labs the locator already handles proves nothing.
 * `describes the corpus it claims to test` below is the guard against that — it fails if
 * the corpus stops containing the constructs these properties exist to survive.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import type { DiagnosticCode } from '../src/diagnostic.js'
import { extractLabFile, LabExtractionError, locateLabFile } from '../src/extract.js'
import { checkLabIds, collectLabIds, type LabIdPlan, planLabId } from '../src/lab-id.js'
import { composeSkeleton } from '../src/skeleton.js'
import { decodeSource } from '../src/source.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))

interface Fixture {
  readonly name: string
  readonly bytes: Buffer
  readonly source: string
  readonly pathStem: string
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
        pathStem: name.replace(/\.md$/, ''),
      }
    })
}

/** Every fixture that must round-trip. */
const CORPUS: readonly Fixture[] = [
  ...load('corpus-k8s-labs'),
  ...load('corpus-opentofu-labs'),
  ...load('adversarial-labs'),
]

/** Fixtures that must be refused, and the diagnostic each must raise. */
const REJECTED: readonly (readonly [string, DiagnosticCode])[] = [
  ['duplicate-lab-id.md', 'duplicate-lab-id'],
  ['missing-lab-id.md', 'missing-lab-id'],
  ['unsafe-lab-id.md', 'unsafe-lab-id'],
]

/** Give every lab an identity, the way an adopting consumer runs `init-ids` once. */
function adopt(fixture: Fixture): string {
  return planLabId(fixture.source, { pathStem: fixture.pathStem }).text
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

/**
 * Lines that carry protected machinery: HTML tags, link reference definitions, and
 * heredoc delimiters.
 *
 * Two exclusions, both because the line carries prose as well as machinery. A
 * `<summary>` label is prose living on a tag line, so it is blanked before comparing —
 * otherwise this would assert that translating a spoiler label does not translate it.
 * And a *footnote* definition (`[^cve]: …`) only looks like a link definition: its
 * marker is skeleton but its body is a unit sitting on the same line, so the line as a
 * whole is expected to change between locales.
 */
function machineryLines(text: string): readonly string[] {
  return text
    .replace(/(<summary(?:\s[^>\n]*)?>)([^\n]*?)(<\/summary\s*>)/g, '$1$3')
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:<\/?[a-zA-Z]|\[[^^\]][^\]]*\]:|EOF\b)/.test(line))
}

/** Section chunks, each starting at its own `##` heading, so they can be moved around. */
function sectionChunks(text: string): readonly string[] {
  const chunks: string[] = []
  let current: string[] = []
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === undefined && opener !== undefined) fence = opener[0]
    else if (fence !== undefined && opener !== undefined && opener[0] === fence) fence = undefined
    if (fence === undefined && /^## /.test(line) && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  chunks.push(current.join('\n'))
  return chunks
}

function idsOf(text: string): readonly string[] {
  return extractLabFile(text).units.map((unit) => formatUnitId(unit.id))
}

/**
 * A stand-in translation for one unit: different from the English in every case, but
 * still keeping the machinery `composeSkeleton` requires a translator to keep.
 *
 * That means **every** reference-definition opener the unit has, not the first one. An
 * earlier version regenerated only the first `[^label]:` and so deleted the second
 * footnote of a two-definition unit outright — satisfying the guard's letter while
 * violating its purpose, and hiding the fact that the guard only enforced the first
 * label. A stand-in that a real translator's output could not match is not a stand-in.
 */
function translationFor(unit: { source: string }, index: number): string {
  const openers = unit.source
    .split(/\r?\n/)
    .map((line) => /^ {0,3}(\[\^?[^\]]*\]:)/.exec(line)?.[1])
    .filter((opener): opener is string => opener !== undefined)
  if (openers.length === 0) return `uebersetzt ${index}`
  return openers.map((opener, at) => `${opener} uebersetzt ${index}-${at}`).join('\n')
}

describe.each(CORPUS.map((fixture) => [fixture.name, fixture] as const))(
  'round-trip properties over %s',
  (_name, fixture) => {
    const adopted = adopt(fixture)
    const extraction = extractLabFile(adopted, fixture.name)

    // Group 1 — losslessness.
    it('decodes and re-encodes without losing a byte', () => {
      expect(decodeSource(fixture.bytes)).toBe(fixture.source)
      expect(Buffer.from(fixture.source, 'utf8')).toEqual(fixture.bytes)
    })

    it('adopts an identity by insertion only', () => {
      const plan = planLabId(fixture.source, { pathStem: fixture.pathStem })
      expect(undoInsertion(plan)).toBe(fixture.source)
    })

    it('adopts idempotently, reading back the marker it wrote (FR-001, AS-2)', () => {
      // Run twice and read back, rather than pinning the first run's bytes. A marker
      // init-ids writes but collectLabIds cannot read is not a cosmetic defect: the
      // codemod stops being idempotent and every re-run leaves a dead comment behind in
      // English source. Pinning first-run output is what let exactly that through.
      const again = planLabId(adopted, { pathStem: fixture.pathStem })
      expect(again.text).toBe(adopted)
      expect(again.insertion).toBeUndefined()
      expect(collectLabIds(adopted).map((record) => record.labId)).toEqual([
        again.labId ?? extraction.labId,
      ])
      expect(checkLabIds([{ path: fixture.name, source: adopted }])).toEqual([])
    })

    it('anchors every hole on the bytes it claims (the offset invariant)', () => {
      // Losslessness cannot see a misplaced hole: an untranslated hole is filled with
      // source.slice(start, end) either way, so a skew round-trips green and only shows
      // up once something is actually translated.
      //
      // Comparing hole.source against a re-slice of its own offsets does not see it
      // either — hole.source *is* fragment.slice(r) and hole.start *is* base + r, the
      // same expression whatever the base is wrong by. That version of this assertion
      // was a tautology and passed with the byte-order-mark payback removed.
      //
      // What a skew actually does is shift a span off the inline content it was measured
      // from, and inline content never begins or ends with whitespace. So a markdown
      // hole's text is exactly its own trimmed self, and that is the invariant with
      // teeth: it goes red the moment locateProse stops paying the mark back.
      for (const hole of extraction.skeleton.holes) {
        if (hole.encoding.kind !== 'markdown') continue
        expect(hole.source).toBe(hole.source.trim())
      }
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
    it('keeps every fenced block and machinery line byte-identical when everything is translated', () => {
      const translations = Object.fromEntries(
        extraction.units.map((unit, index) => [formatUnitId(unit.id), translationFor(unit, index)]),
      )
      const translated = composeSkeleton(extraction.skeleton, translations)
      expect(fenceBlocks(translated)).toEqual(fenceBlocks(adopted))
      expect(machineryLines(translated)).toEqual(machineryLines(adopted))
      if (extraction.units.length > 0) expect(translated).not.toBe(adopted)
    })

    it('never emits a fence delimiter, a thematic break or a heredoc body as translatable text', () => {
      for (const unit of extraction.units) {
        for (const line of unit.source.split('\n')) {
          expect(line).not.toMatch(/^ {0,3}(?:`{3,}|~{3,})/)
          expect(line.trimEnd()).not.toBe('---')
          expect(line).not.toMatch(/^apiVersion: /)
        }
      }
    })

    it('leaves every <summary> and <details> tag outside the units it extracts', () => {
      for (const unit of extraction.units) {
        expect(unit.source).not.toContain('<summary')
        expect(unit.source).not.toContain('</summary')
        expect(unit.source).not.toContain('<details')
      }
    })

    // Group 3 — identity stability.
    it('changes one hash and no identity when one unit of English is edited (AS-2)', () => {
      const hole = extraction.skeleton.holes.find((item) => item.encoding.kind === 'markdown')
      if (hole === undefined) return
      const edited = `${adopted.slice(0, hole.end)} (edited)${adopted.slice(hole.end)}`
      const after = extractLabFile(edited).units
      expect(after.map((unit) => formatUnitId(unit.id))).toEqual(
        extraction.units.map((unit) => formatUnitId(unit.id)),
      )
      const moved = after.filter(
        (unit, index) => unit.sourceHash !== extraction.units[index]?.sourceHash,
      )
      expect(moved.map((unit) => formatUnitId(unit.id))).toEqual([formatUnitId(hole.id)])
    })

    it('keeps every identity when the file moves to another path (AS-3)', () => {
      // The identity lives in the file, not in its path, so re-running init-ids from a
      // different directory changes nothing at all — not the id, not one unit key.
      const moved = planLabId(adopted, { pathStem: `somewhere-else/${fixture.pathStem}` })
      expect(moved.text).toBe(adopted)
      expect(moved.insertion).toBeUndefined()
      expect(idsOf(moved.text)).toEqual(idsOf(adopted))
    })

    it('keeps every existing identity when a section is appended (AS-2)', () => {
      const appended = `${adopted}\n## Angehängter Abschnitt\n\nNeuer Absatz.\n`
      const before = idsOf(adopted)
      const after = new Set(idsOf(appended))
      expect(before.filter((id) => !after.has(id))).toEqual([])
    })

    it('re-keys reordered sections without losing or duplicating a unit', () => {
      // The honest limit of a structural key: a lab is one container, its `##` sections
      // carry no identity of their own, so moving them changes the heading ordinals in
      // the keys beneath them. What must not change is that every unit is still there,
      // exactly once — a re-keyed unit reaches the catalog as a removed id plus an added
      // id and is re-matched by translation memory, never attached to the wrong English.
      const chunks = sectionChunks(adopted)
      if (chunks.length < 3) return
      const reordered = [chunks[0] ?? '', ...chunks.slice(1).reverse()].join('\n')
      const after = idsOf(reordered)
      expect(after.length).toBe(idsOf(adopted).length)
      expect(new Set(after).size).toBe(after.length)
    })

    // Group 4 — determinism.
    it('yields identical output for identical input (FR-006)', () => {
      expect(extractLabFile(adopted)).toEqual(extractLabFile(adopted))
      expect(planLabId(fixture.source, { pathStem: fixture.pathStem })).toEqual(
        planLabId(fixture.source, { pathStem: fixture.pathStem }),
      )
    })

    it('emits units in identity order, with no duplicates', () => {
      const ids = extraction.units.map((unit) => formatUnitId(unit.id))
      expect(ids).toEqual([...ids].sort())
      expect(new Set(ids).size).toBe(ids.length)
    })
  },
)

/**
 * Delete exactly what the plan inserted and expect the original file back — the literal
 * reading of "no other byte changes" (spec 001 AS-1).
 */
function undoInsertion(plan: LabIdPlan): string {
  const insertion = plan.insertion
  if (insertion === undefined) return plan.text
  return (
    plan.text.slice(0, insertion.offset) + plan.text.slice(insertion.offset + insertion.text.length)
  )
}

describe('the hostile corpus describes the corpus it claims to test', () => {
  const all = CORPUS.map((fixture) => fixture.source).join('\n')

  it('carries both consumer corpora, which ADR 0001/0010 require before a release', () => {
    // Not a count: a named check, so dropping one workshop's labs fails loudly instead
    // of quietly shrinking the number the assertion below happens to accept.
    const treeOf = (fixture: Fixture): string => fixture.name.split('/')[0] ?? ''
    const trees = new Set(CORPUS.map(treeOf))
    expect([...trees].sort()).toEqual([
      'adversarial-labs',
      'corpus-k8s-labs',
      'corpus-opentofu-labs',
    ])
    for (const tree of trees) {
      expect(CORPUS.filter((fixture) => treeOf(fixture) === tree).length).toBeGreaterThan(5)
    }
  })

  it('is large enough to be worth running', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(26)
    const units = CORPUS.reduce(
      (total, fixture) => total + extractLabFile(adopt(fixture)).units.length,
      0,
    )
    expect(units).toBeGreaterThan(1800)
  })

  it.each([
    ['a bare document separator inside a fenced block', /```[a-z]*[^\n]*\n(?:[^\n]*\n)*?---\n/],
    [
      'a multi-document YAML manifest inside a quoted heredoc',
      /<<'EOF'\n(?:[^\n]*\n)*?---\napiVersion:/,
    ],
    ['a quoted heredoc that materialises a manifest', /cat > [\w./-]+ <<'EOF'/],
    ['a tilde fence', /^~~~/m],
    ['a four-backtick fence around a three-backtick one', /````\w*\n```/],
    ['a <details> spoiler', /<details>/],
    ['a <summary> holding inline HTML', /<summary>[^\n]*<code>/],
    ['a GFM table alignment row', /^\| :?-+:? \|/m],
    ['the lab metadata table', /^\| \*\*Section\*\* \|/m],
    ['a setext heading', /^=====+$/m],
    ['a hard line break', /\S {2}$/m],
    ['an ordered list', /^\d+\. /m],
    ['a nested blockquote inside a list item', /^ {2}> /m],
    ['a four-space indented code block', /^ {4}\S/m],
    // Anchored on a real footnote, not on /\[\^/: that matched `[^"]` inside a `grep -o`
    // in a fenced shell command, so this row certified a construct the corpus did not
    // contain — a false green for exactly the thing composeSkeleton now guards.
    ['a footnote reference', /\[\^[\w-]+\](?!:)/],
    ['a footnote definition', /^\[\^[\w-]+\]: /m],
    ['a link reference definition with a title', /^\[[\w-]+\]: \S+ "/m],
    ['a reference-style image', /!\[[^\]]+\]\[[\w-]+\]/],
    ['a long kubectl one-liner', /kubectl [^\n]{120,}/],
    ['an astral emoji', /[\u{1f300}-\u{1faff}]/u],
    ['a circled numeral', /[①-⑳]/],
    ['a combining mark', /́/],
    ['a right-to-left script', /[֐-ۿ]/],
    ['an HTML entity', /&(?:lt|gt|amp|quot|nbsp);/],
    ['mustache interpolation', /\{\{ /],
    ['a raw HTML div', /<div/],
  ])('contains %s', (_label, pattern) => {
    expect(all).toMatch(pattern)
  })

  it('contains a CRLF file and a byte-order mark', () => {
    expect(CORPUS.some((fixture) => fixture.source.includes('\r\n'))).toBe(true)
    expect(CORPUS.some((fixture) => fixture.source.startsWith('﻿'))).toBe(true)
  })

  it('contains a file with no trailing newline', () => {
    expect(CORPUS.some((fixture) => !fixture.source.endsWith('\n'))).toBe(true)
  })

  it('contains both a dense lab and a degenerate one', () => {
    const counts = CORPUS.map((fixture) => extractLabFile(adopt(fixture)).units.length)
    expect(Math.max(...counts)).toBeGreaterThanOrEqual(60)
    expect(Math.min(...counts)).toBeLessThanOrEqual(5)
  })

  it('still finds coverage gaps to report, so the warning path is exercised', () => {
    const warnings = CORPUS.flatMap((fixture) =>
      locateLabFile(adopt(fixture)).diagnostics.filter((item) => item.severity === 'warning'),
    )
    expect(warnings.map((item) => item.code)).toContain('prose-in-html-block')
  })
})

describe.each(REJECTED)('fixtures/adversarial-labs-rejected/%s', (name, code) => {
  const source = decodeSource(readFileSync(join(FIXTURE_ROOT, 'adversarial-labs-rejected', name)))

  it(`fails closed with a ${code} diagnostic`, () => {
    expect(() => extractLabFile(source)).toThrow(LabExtractionError)
    const located = locateLabFile(source)
    expect(located.diagnostics.map((item) => item.code)).toContain(code)
    expect(located.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it('still reproduces the file byte-for-byte, because refusing is not mangling', () => {
    expect(composeSkeleton(locateLabFile(source).skeleton, {})).toBe(source)
  })
})
