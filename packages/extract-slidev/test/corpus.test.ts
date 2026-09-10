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
import { parse as parseYaml } from 'yaml'
import { parseSlidevDeck } from '../src/deck.js'
import type { DiagnosticCode } from '../src/diagnostic.js'
import {
  extractSlidevFile,
  locateSlidevFile,
  SlidevExtractionError,
  type SlidevExtractOptions,
} from '../src/extract.js'
import { locateFrontmatter } from '../src/frontmatter.js'
import { planSlideIds, type SlideIdPlan } from '../src/init-ids.js'
import { CompositionError, composeSkeleton, type Hole, type Skeleton } from '../src/skeleton.js'
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

/**
 * The component text props the Kubernetes-Workshop deck would declare (ADR 0015), so the
 * properties below run over prop holes too, not only over what the default extracts.
 */
const CORPUS_OPTIONS: SlidevExtractOptions = {
  componentTextProps: { KwCard: ['heading'], CodeNote: ['label'] },
}

/** Fixtures that must be refused, and the diagnostic each must raise. */
const REJECTED: readonly (readonly [string, DiagnosticCode])[] = [
  ['duplicate-slide-id.md', 'duplicate-slide-id'],
  ['malformed-frontmatter.md', 'malformed-frontmatter'],
  ['dash-run-opens-no-block.md', 'missing-slide-id'],
  ['missing-slide-id.md', 'missing-slide-id'],
  ['phantom-frontmatter.md', 'phantom-frontmatter'],
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

/**
 * Translator text that would restructure a deck if composition let it through. Each must
 * either be refused or leave the deck's shape identical; silently reshaping it is the
 * failure. Kept in step with the list in `slidev-parser-differential.test.ts`.
 */
const HOSTILE_TRANSLATIONS: readonly string[] = [
  'eins\n---\nzwei',
  'eins\n--- und mehr\nzwei',
  'eins\n-----x\nzwei',
  'eins\n---\u00a0\nzwei',
  'eins\n    \u0060\u0060\u0060yaml\nzwei',
  'eins\n\t\u0060\u0060\u0060yaml\nzwei',
  'eins\n\u0060\u0060\u0060\nzwei',
  'eins\n~~~yaml\nzwei',
  'Erste --- Zweite',
  'eins <!-- zwei',
  'eins --> zwei',
  'eins | zwei',
  'eins\n::right::\nzwei',
  'eins <img src=x onerror=alert(1)> zwei',
  'eins {{ $slidev.nav.next() }} zwei',
  'eins <b class="x',
  'eins\n\nzwei',
  'eins "zwei" \'drei\'',
  'schlicht',
  'eins\n\u0060\u0060\u0060yaml\nlayout: cover\nzwei',
  '\u0060\u0060\u0060',
  '--',
]

/**
 * The HTML tags and `{{ }}` interpolations in `text`, sorted — an independent reading of
 * what composition requires a translation to keep (ADR 0015), deliberately not the
 * package's own scanner, so weakening that scanner cannot move the oracle with it.
 */
function markupOf(text: string): readonly string[] {
  const pattern =
    /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|\{\{[\s\S]*?\}\}/g
  return [...text.matchAll(pattern)].map((match) => match[0]).sort()
}

/** The same markup in document order — what a translator carries across, tags still nested. */
function markupInOrder(text: string): readonly string[] {
  const pattern =
    /<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|\{\{[\s\S]*?\}\}/g
  return [...text.matchAll(pattern)].map((match) => match[0])
}

/**
 * True when replacing this hole's whole text with `payload` *must* be refused.
 *
 * The sweeps assert that composition either refuses or changes nothing Slidev can see,
 * which by construction cannot host a payload whose whole point is to be refused — so the
 * guards against dropping a comment delimiter and against adding a table column were held
 * by one hand-written test each. This says which pairs have no second option.
 */
function mustBeRefused(hole: Hole, payload: string): boolean {
  if (hole.encoding.kind === 'yaml-scalar') return false
  const count = (text: string, token: string): number => text.split(token).length - 1
  for (const token of ['<!--', '-->']) {
    if (count(payload, token) !== count(hole.source, token)) return true
  }
  if (hole.encoding.kind === 'html-attribute') return /[\r\n]/.test(payload)
  if (markupOf(payload).join('\n') !== markupOf(hole.source).join('\n')) return true
  if (hole.encoding.kind === 'html-text') {
    return payload.split(/\r?\n/).some((line) => line.trim() === '')
  }
  const barePipes = (text: string): number => count(text.replace(/\\\|/g, ''), '|')
  return hole.encoding.cell && barePipes(payload) > barePipes(hole.source)
}

/** Standard HTML phrasing elements — the only tags an HTML run may carry (ADR 0015). */
const PHRASING_TAG =
  /^<\/?(?:a|abbr|b|bdi|bdo|br|cite|code|data|del|dfn|em|i|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)(?=[\s/>])/

/**
 * A hole's splice context, which is what decides how its first and last lines are judged.
 * Bucketing by it is what makes the hostile sweep reach the interesting holes: a bare
 * fence is harmless spliced after `# ` and a fence opener spliced after two spaces.
 */
function contextBucket(source: string, hole: Hole): string {
  const prefix = source.slice(source.lastIndexOf('\n', hole.start - 1) + 1, hole.start)
  const shape = prefix === '' ? 'start' : prefix.trim() === '' ? 'blank' : 'text'
  const kind = hole.encoding.kind === 'markdown' ? hole.encoding.context : hole.encoding.kind
  return `${kind}/${shape}`
}

/**
 * One hole per distinct splice context.
 *
 * Translating *every* unit at once looked like a stronger sweep and was a weaker one:
 * every fixture has a frontmatter hole, whose `---` guard threw before a single markdown
 * hole was ever composed, so five of the hostile strings never reached the code they
 * were written to test. Stubbing out the separator check left this file entirely green.
 */
function representativeHoles(skeleton: Skeleton, source: string): readonly Hole[] {
  const byBucket = new Map<string, Hole>()
  for (const hole of skeleton.holes) {
    const bucket = contextBucket(source, hole)
    if (!byBucket.has(bucket)) byBucket.set(bucket, hole)
  }
  return [...byBucket.values()]
}

/**
 * An independent transcription of Slidev's `RE_FRONTMATTER` — lazy, and with a close that
 * is not line-anchored — applied to each slide the way `matter()` applies it.
 *
 * The comparison is on the *keys* the capture yields, not its text: translating a value
 * changes the text legitimately, while a `---` inside a value truncates the block and
 * drops every key after it. This is the only oracle that can see that — every line-based
 * reading, this package's included, still sees a well-formed block — so without it the
 * guard could be deleted with the suite staying green.
 */
function slidevFrontmatterKeys(text: string): readonly (readonly string[] | null)[] {
  return parseSlidevDeck(text).slides.map((slide) => {
    const raw = text.slice(slide.frontmatter?.start ?? slide.bodyStart, slide.end)
    const captured = /^---.*\r?\n([\s\S]*?)---/.exec(raw)?.[1]
    if (captured === undefined) return null
    try {
      const parsed: unknown = parseYaml(captured)
      return typeof parsed === 'object' && parsed !== null
        ? Object.keys(parsed as Record<string, unknown>).sort()
        : []
    } catch {
      // A truncated block usually stops parsing; either way the extent changed.
      return null
    }
  })
}

/**
 * An independent reading of Slidev's line rules, deliberately *not* the package's own
 * predicates: the shared definition is the subject here, so using it as the oracle too
 * would move both together when it is weakened.
 */
function structuralLines(text: string): { separators: number; fences: number; slots: number } {
  let separators = 0
  let fences = 0
  let slots = 0
  for (const line of text.split(/\r?\n/)) {
    const trimmedEnd = line.replace(/\s+$/u, '')
    if (trimmedEnd.startsWith('---')) separators += 1
    if (/^[ \t]*(?:`{3,}|~{3,})/.test(trimmedEnd)) fences += 1
    // Slidev's slot sugar reads `::name::` at column 0 only.
    if (/^::\s*[\w.:-]+\s*::$/.test(trimmedEnd)) slots += 1
  }
  return { separators, fences, slots }
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
    ...markupInOrder(source),
    ...Array.from({ length: count('<!--') }, () => '<!--'),
    ...Array.from({ length: count('-->') }, () => '-->'),
  ].join(' ')
}

/** The deck's shape: how many slides, and which identity each one declares. */
function structureOf(text: string): unknown {
  return parseSlidevDeck(text).slides.map((slide) => {
    const block = slide.frontmatter
    return {
      hasFrontmatter: block !== undefined,
      slideId:
        block === undefined
          ? null
          : (locateFrontmatter(text, block, new Set<string>()).slideId ?? null),
    }
  })
}

function idsOf(text: string): readonly string[] {
  return extractSlidevFile(text, CORPUS_OPTIONS).units.map((unit) => formatUnitId(unit.id))
}

describe.each(CORPUS.map((fixture) => [fixture.name, fixture] as const))(
  'round-trip properties over %s',
  (_name, fixture) => {
    const adopted = adopt(fixture)
    const extraction = extractSlidevFile(adopted, CORPUS_OPTIONS)

    // Group 1 — losslessness.
    it('decodes and re-encodes without losing a byte', () => {
      expect(decodeSource(fixture.bytes)).toBe(fixture.source)
      expect(Buffer.from(fixture.source, 'utf8')).toEqual(fixture.bytes)
    })

    it('adopts identities by insertion only', () => {
      const plan = planSlideIds(fixture.source, { sectionId: fixture.sectionId })
      expect(withoutInsertions(plan)).toBe(fixture.source)
    })

    it('adopts identities idempotently, however many runs (AS-2)', () => {
      const once = planSlideIds(fixture.source, { sectionId: fixture.sectionId })
      const twice = planSlideIds(once.text, { sectionId: fixture.sectionId })
      expect(twice.insertions).toEqual([])
      expect(twice.text).toBe(once.text)
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
        extraction.units.map((unit, index) => [
          formatUnitId(unit.id),
          markerFor(unit.source, index),
        ]),
      )
      const translated = composeSkeleton(extraction.skeleton, translations)
      expect(fenceBlocks(translated)).toEqual(fenceBlocks(adopted))
      expect(machineryLines(translated)).toEqual(machineryLines(adopted))
      expect(translated).not.toBe(adopted)
    })

    it('leaves the deck structure untouched when every unit is translated', () => {
      // The render-time half of fence identity: composition may change words, never the
      // number of slides or which identity each one carries. Asserted against this
      // package's own parse, which shares the line predicates with the code under test,
      // so the sweep below adds an independent reading of those rules; the differential
      // re-asserts everything against Slidev itself when a parser is available.
      const translations = Object.fromEntries(
        extraction.units.map((unit, index) => [
          formatUnitId(unit.id),
          `${markerFor(unit.source, index)} — Ü "3" ✓`,
        ]),
      )
      const composed = composeSkeleton(extraction.skeleton, translations)
      expect(structureOf(composed)).toEqual(structureOf(adopted))
    })

    it('keys the translated deck exactly as the English one', () => {
      // Structure inside a slide — slot scopes, HTML element paths, prop keys — must not
      // move either: re-extracting a fully translated locale gives back every identity.
      // A quote in every translation reaches prop holes, where it must be escaped.
      const translations = Object.fromEntries(
        extraction.units.map((unit, index) => [
          formatUnitId(unit.id),
          `${markerFor(unit.source, index)} "quoted" 'too'`,
        ]),
      )
      const composed = composeSkeleton(extraction.skeleton, translations)
      expect(idsOf(composed)).toEqual(idsOf(adopted))
    })

    it('either refuses hostile translator text or leaves the structure untouched', () => {
      const baseline = structureOf(adopted)
      const baselineLines = structuralLines(adopted)
      const baselineFrontmatter = slidevFrontmatterKeys(adopted)
      for (const text of HOSTILE_TRANSLATIONS) {
        // One hole at a time: a single refusal anywhere would otherwise stand in for
        // every hole, and the guard under test would never be reached.
        for (const hole of representativeHoles(extraction.skeleton, adopted)) {
          const where = `${formatUnitId(hole.id)} <- ${JSON.stringify(text)}`
          let composed: string
          try {
            composed = composeSkeleton(extraction.skeleton, { [formatUnitId(hole.id)]: text })
          } catch (error) {
            expect(error).toBeInstanceOf(CompositionError)
            continue
          }
          expect(mustBeRefused(hole, text), `${where} was accepted`).toBe(false)
          expect(structureOf(composed), where).toEqual(baseline)
          // Checked against independent readings of Slidev's rules, so weakening the
          // package's own predicate cannot move the subject and the oracle together.
          expect(structuralLines(composed), where).toEqual(baselineLines)
          expect(slidevFrontmatterKeys(composed), where).toEqual(baselineFrontmatter)
        }
      }
    })

    it('never emits a fence delimiter or a slide separator as translatable text', () => {
      for (const unit of extraction.units) {
        for (const line of unit.source.split('\n')) {
          expect(line).not.toMatch(/^ {0,3}(?:`{3,}|~{3,})/)
          expect(line.trimEnd()).not.toBe('---')
        }
      }
    })

    it('hands a translator prose from an HTML block, never its machinery (ADR 0015)', () => {
      for (const hole of extraction.skeleton.holes) {
        const where = formatUnitId(hole.id)
        if (hole.encoding.kind === 'html-attribute') {
          // Only a declared prop, and only one that holds words.
          expect(hole.id.unitKey, where).toMatch(
            /\/(?:kw-card\.\d+\/prop:heading|code-note\.\d+\/prop:label)$/,
          )
          expect(hole.source, where).toMatch(/\p{L}/u)
          continue
        }
        if (hole.encoding.kind !== 'html-text') continue
        for (const tag of markupOf(hole.source).filter((token) => token.startsWith('<'))) {
          expect(tag, where).toMatch(PHRASING_TAG)
          expect(tag, where).not.toMatch(/\s(?:v-[\w-]+|:[\w-]+|@[\w-]+|#[\w-]+)(?:=|[\s/>])/)
        }
        const words = hole.source.replace(/<[^>]*>/g, '').replace(/\{\{[\s\S]*?\}\}/g, '')
        expect(words, where).toMatch(/\p{L}/u)
      }
    })

    it('never emits a Slidev slot marker as translatable text', () => {
      for (const unit of extraction.units) {
        for (const line of unit.source.split('\n')) {
          expect(line, formatUnitId(unit.id)).not.toMatch(/^\s*::\s*[\w.\-:]+\s*::\s*$/)
        }
      }
    })

    // Group 3 — identity stability.
    it('changes one hash and no identity when one unit of English is edited (AS-2)', () => {
      const hole = extraction.skeleton.holes.find((item) => item.encoding.kind === 'markdown')
      if (hole === undefined) return
      const edited = `${adopted.slice(0, hole.end)} (edited)${adopted.slice(hole.end)}`
      const after = extractSlidevFile(edited, CORPUS_OPTIONS).units
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
      expect(extractSlidevFile(adopted, CORPUS_OPTIONS)).toEqual(
        extractSlidevFile(adopted, CORPUS_OPTIONS),
      )
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
      (total, fixture) => total + extractSlidevFile(adopt(fixture), CORPUS_OPTIONS).units.length,
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
    ['a Slidev slot marker', /^::right::$/m],
    ['a slot marker interrupting a paragraph', /^\w[^\n]*\n::right::\n\w/m],
    ['an astral emoji', /[\u{1f300}-\u{1faff}]/u],
    ['box drawing', /[─│└┬┼├]/],
    ['a YAML doubled-quote escape', /: '[^'\n]*''/],
    ['a YAML block scalar', /^\w+: \|$/m],
  ])('contains %s', (_label, pattern) => {
    expect(all).toMatch(pattern)
  })

  it.each([
    ['a component grid inside a div', /<div[^>]*>\n\s+<KwCard /],
    ['a CodeNote overlay with a click index', /<CodeNote at="\d+"/],
    ['components nested in v-click', /<v-click[^>]*>\n\s+<KwCard/],
    ['a self-closing component', /<K8sIcon [^>]*\/>/],
    ['an inline component inside a paragraph', /^\w[^\n<]* <KwChip [^>]*>/m],
    ['a multi-line opening tag', /^<KwCard\n\s+\w+=/m],
    ['markdown children set off by blank lines', /^<KwCard[^>\n]*>\r?\n\r?\n/m],
    ['a single-quoted prop holding a double quote', /heading='[^'\n]*"/],
    ['an entity inside a prop', /heading=(?:"[^"\n]*|'[^'\n]*)&\w+;/],
    ['an unquoted prop', /heading=[A-Za-z]/],
  ])('contains %s', (_label, pattern) => {
    expect(all).toMatch(pattern)
  })

  it('extracts the text of every card in the Kubernetes corpus', () => {
    // The coverage claim of ADR 0015, stated as a count: every `<KwCard>` whose body holds
    // words yields at least one unit keyed under it. 235 warnings said otherwise before.
    for (const fixture of CORPUS.filter((item) => item.name.startsWith('corpus-k8s/'))) {
      const adopted = adopt(fixture)
      const cards = [...adopted.matchAll(/<KwCard\b[^>]*>([\s\S]*?)<\/KwCard>/g)].filter((match) =>
        /\p{L}/u.test((match[1] ?? '').replace(/<[^>]*>/g, '')),
      ).length
      const keyed = new Set<string>()
      for (const unit of extractSlidevFile(adopted, CORPUS_OPTIONS).units) {
        const card = /^(.*\/kw-card\.\d+)\//.exec(unit.id.unitKey)?.[1]
        if (card !== undefined) keyed.add(`${unit.id.containerId}:${card}`)
      }
      expect({ fixture: fixture.name, cards: keyed.size }).toEqual({ fixture: fixture.name, cards })
    }
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

  it('is adopted at most once — by refusal for the files that error', () => {
    // The idempotence property ran only over files that extract cleanly, which is exactly
    // where this class of bug cannot live: a file extraction refuses is the one whose
    // insertions nothing was checking.
    //
    // Worth being precise about what this proves. Seven of these eight fixtures carry an
    // error diagnostic, so the plan fails closed and the fixed point is reached by the file
    // being left alone; only `missing-slide-id.md` exercises a real insertion and then
    // declines to make a second. It is a regression guard for the unbounded-insert path
    // rather than independent evidence that the path itself was repaired.
    const sectionId = name.replace(/\.md$/, '')
    const once = planSlideIds(source, { sectionId })
    const twice = planSlideIds(once.text, { sectionId })
    expect(twice.insertions).toEqual([])
    expect(twice.text).toBe(once.text)
  })
})
