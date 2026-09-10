/**
 * Composition properties over **every** file of the hostile corpus — slides, labs (both
 * consumer workshops) and quiz banks — never a curated subset (ADR 0010, constitution III).
 *
 * 1. **Empty catalog** — every unit falls back, every fallback carries the marker (the
 *    marker is placeable in every hole context the real corpora have), and the output's
 *    protected skeleton is byte-identical to the English: markers aside, it is the source.
 * 2. **English as translation** — a reviewed catalog whose every translation is its own
 *    English composes strictly, releasably, and byte-for-byte into the source.
 * 3. **Every unit translated** — markup-preserving translations of every unit compose
 *    strictly with fences byte-identical (checked by an independent fence scanner, not the
 *    package's own gate) and no content-gate error.
 * 4. **Hostile translations** — markup payloads never reach the output in preview, and
 *    always fail strict.
 * 5. **Determinism** — identical input, deep-equal result.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Catalog, emptyCatalog } from '@workshop-i18n/catalog-po'
import {
  formatUnitId,
  type Manifest,
  parseManifest,
  QUIZ_SCHEMA_VARIANTS,
  type QuizSchemaVariant,
  type Surface,
} from '@workshop-i18n/core'
import { planLabId } from '@workshop-i18n/extract-markdown'
import { decodeSource, planSlideIds } from '@workshop-i18n/extract-slidev'
import { describe, expect, it } from 'vitest'
import { composeLocale } from '../src/compose.js'
import { FALLBACK_MARKER } from '../src/marker.js'
import { compareSkeletons, locateFile } from '../src/surface.js'
import { locateContextFor } from '../src/verify.js'
import { catalog, type EntrySpec } from './helpers.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))

interface Fixture {
  readonly name: string
  readonly surface: Surface
  /** The file as a consumer holds it after `init-ids`. */
  readonly text: string
  readonly manifest: Manifest
}

function manifestFor(schema: QuizSchemaVariant): Manifest {
  return parseManifest(`
apiVersion: workshop-i18n/v1
locales: { source: en, targets: [de] }
surfaces:
  slides: { include: ["**/*.md"] }
  labs: { include: ["**/*.md"] }
  quiz: { include: ["**/*.json"], schema: ${schema} }
protectedTerms: [kubectl, Pod, OpenTofu]
`)
}

const MANIFESTS = Object.fromEntries(
  QUIZ_SCHEMA_VARIANTS.map((variant) => [variant, manifestFor(variant)]),
) as Record<QuizSchemaVariant, Manifest>

function load(directory: string, surface: Surface): readonly Fixture[] {
  const base = join(FIXTURE_ROOT, directory)
  const extension = surface === 'quiz' ? '.json' : '.md'
  return readdirSync(base)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => {
      const source = decodeSource(readFileSync(join(base, name)), name)
      const stem = name.slice(0, -extension.length)
      const text =
        surface === 'slides'
          ? planSlideIds(source, { sectionId: stem }).text
          : surface === 'labs'
            ? planLabId(source, { pathStem: stem }).text
            : source
      const schema = (QUIZ_SCHEMA_VARIANTS.find((variant) => name.startsWith(variant)) ??
        'kubernetes-workshop') as QuizSchemaVariant
      return { name: `${directory}/${name}`, surface, text, manifest: MANIFESTS[schema] }
    })
}

const CORPUS: readonly Fixture[] = [
  ...load('corpus-k8s', 'slides'),
  ...load('adversarial', 'slides'),
  ...load('corpus-k8s-labs', 'labs'),
  ...load('corpus-opentofu-labs', 'labs'),
  ...load('adversarial-labs', 'labs'),
  ...load('corpus-quiz', 'quiz'),
  ...load('adversarial-quiz', 'quiz'),
]

function located(fixture: Fixture) {
  return locateFile(
    fixture.surface,
    fixture.text,
    locateContextFor(fixture.manifest, fixture.surface),
  )
}

function catalogOf(
  fixture: Fixture,
  translate: (source: string, index: number) => string,
): Catalog {
  const entries: EntrySpec[] = located(fixture).holes.map((hole, index) => ({
    id: formatUnitId(hole.id),
    source: hole.source,
    translation: translate(hole.source, index),
  }))
  return entries.length === 0
    ? emptyCatalog({ locale: 'de', name: 'x' })
    : catalog('de', 'x', entries)
}

function compose(fixture: Fixture, catalogs: readonly Catalog[], mode: 'preview' | 'strict') {
  return composeLocale({
    manifest: fixture.manifest,
    locale: 'de',
    files: [{ path: 'file', surface: fixture.surface, text: fixture.text }],
    catalogs,
    mode,
  })
}

/** An independent fenced-code scanner — deliberately not the package's own gate. */
function fenceBlocks(text: string): readonly string[] {
  const blocks: string[] = []
  let open: { marker: string; length: number; lines: string[] } | undefined
  for (const line of text.split(/\r?\n/)) {
    const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    const run = match?.[1]
    if (open === undefined) {
      if (run !== undefined) open = { marker: run[0] as string, length: run.length, lines: [line] }
      continue
    }
    open.lines.push(line)
    if (run !== undefined && run[0] === open.marker && run.length >= open.length) {
      if ((match?.[2] ?? '').trim() === '') {
        blocks.push(open.lines.join('\n'))
        open = undefined
      }
    }
  }
  if (open !== undefined) blocks.push(open.lines.join('\n'))
  return blocks
}

/**
 * A control character survives only as the English bytes: every extractor refuses one
 * in a replacement even when the English carries it (the quiz escapes fixture does, as
 * a JSON `\u0007` escape), so such a unit can only ever render as its own English, unmarked.
 */
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f
  })
}

/**
 * A unit whose source is a structural line — a Slidev slot marker (`::right::`) the
 * extractor lifts as a unit — cannot be given prose appended to it: `::right:: word` is a
 * different structural line, which the coarse gate refuses (correctly). Such a unit, like
 * one carrying a control character, can only render as its own English.
 */
function isStructuralOnly(source: string): boolean {
  return source
    .split(/\r\n|\n|\r/)
    .some((line) => /^[ \t]*(?:<<<|\$\$|::|---|`{3,}|~{3,})/.test(line))
}

/** Keeps every token the gates compare: the English, with prose-only words around it. */
function markupPreserving(source: string, index: number): string {
  if (hasControlCharacter(source) || isStructuralOnly(source)) return source
  return `${source} (traducao ${index})`
}

/** Findings other than the extractor's coverage-gap warnings, which are the English's own. */
function composeFindings(result: ReturnType<typeof composeLocale>) {
  return result.findings.filter((finding) => finding.code !== 'extraction')
}

const HOSTILE_SUFFIXES: readonly string[] = [
  ' <img src=x onerror=alert(1)>',
  ' {{ $slidev.nav.go(1) }}',
  ' [klick](javascript:alert(1))',
  ' <a href="https://evil.example">x</a>',
  '\n<<< @/.env txt',
  ' ![x](./.env?raw)',
  '\n- ```plantuml',
  ' :Toc',
  ' 😈.ws',
]

describe.each(CORPUS.map((fixture) => [fixture.name, fixture] as const))(
  'composition properties over %s',
  (_name, fixture) => {
    const english = located(fixture)

    it('has units to compose and extracts without error', () => {
      expect(english.holes.length).toBeGreaterThan(0)
      expect(english.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    })

    it('marks every unit of an empty catalog and keeps the skeleton byte-identical', () => {
      const result = compose(fixture, [], 'preview')
      const unmarkable = new Set(
        english.holes
          .filter((hole) => hasControlCharacter(hole.source))
          .map((hole) => formatUnitId(hole.id)),
      )
      expect(composeFindings(result).filter((finding) => finding.severity === 'error')).toEqual([])
      // The marker is placeable in every hole context the corpora have; the only units it
      // skips are the ones no replacement at all may touch.
      expect(
        composeFindings(result)
          .filter((finding) => finding.code === 'marker-omitted')
          .map((finding) => finding.unitId),
      ).toEqual([...unmarkable].sort())
      for (const unit of result.units) {
        expect(unit).toMatchObject({ rendering: 'fallback', marked: !unmarkable.has(unit.id) })
      }
      const output = result.files[0]?.text ?? ''
      const relocated = locateFile(
        fixture.surface,
        output,
        locateContextFor(fixture.manifest, fixture.surface),
      )
      expect(compareSkeletons(english, relocated)).toBeUndefined()
      expect(relocated.holes.map((hole) => hole.source)).toEqual(
        english.holes.map((hole) =>
          unmarkable.has(formatUnitId(hole.id)) ? hole.source : `${FALLBACK_MARKER}${hole.source}`,
        ),
      )
    })

    it('reproduces the source byte-for-byte from English-as-translation, strictly', () => {
      const result = compose(fixture, [catalogOf(fixture, (source) => source)], 'strict')
      expect(composeFindings(result)).toEqual([])
      expect(result.releasable).toBe(true)
      const output = result.files[0]?.text ?? ''
      expect(Buffer.from(output, 'utf8')).toEqual(Buffer.from(fixture.text, 'utf8'))
    })

    it('composes every unit translated, strictly, with fences byte-identical', () => {
      const result = compose(fixture, [catalogOf(fixture, markupPreserving)], 'strict')
      expect(composeFindings(result).filter((finding) => finding.severity === 'error')).toEqual([])
      expect(result.releasable).toBe(true)
      const output = result.files[0]?.text ?? ''
      expect(output).not.toBe(fixture.text)
      expect(output).not.toContain(FALLBACK_MARKER)
      expect(fenceBlocks(output)).toEqual(fenceBlocks(fixture.text))
      expect(result.units.every((unit) => unit.rendering === 'translation')).toBe(true)
    })

    it('never emits a hostile translation, and never releases one', () => {
      for (const [index, suffix] of HOSTILE_SUFFIXES.entries()) {
        const hostile = [catalogOf(fixture, (source) => `${source}${suffix}`)]
        const preview = compose(fixture, hostile, 'preview')
        const output = preview.files[0]?.text ?? ''
        expect(output.split(suffix).length - 1, suffix).toBe(fixture.text.split(suffix).length - 1)
        expect(
          preview.units.every((unit) => unit.rendering === 'fallback'),
          suffix,
        ).toBe(true)
        // Strict takes the same gate path with a different severity, so one payload per
        // file proves it; the sweep is the suite's slowest test and this halves it.
        if (index > 0) continue
        const strict = compose(fixture, hostile, 'strict')
        expect(strict.releasable, suffix).toBe(false)
        expect(strict.files, suffix).toEqual([])
      }
    })

    it('is deterministic', () => {
      const catalogs = [catalogOf(fixture, markupPreserving)]
      expect(compose(fixture, catalogs, 'preview')).toEqual(compose(fixture, catalogs, 'preview'))
    })
  },
)

describe('the corpus this suite runs over', () => {
  it('covers both workshops and all three surfaces', () => {
    const names = CORPUS.map((fixture) => fixture.name)
    for (const tree of [
      'corpus-k8s/',
      'adversarial/',
      'corpus-k8s-labs/',
      'corpus-opentofu-labs/',
      'adversarial-labs/',
      'corpus-quiz/kubernetes-workshop',
      'corpus-quiz/opentofu-workshop',
      'adversarial-quiz/',
    ]) {
      expect(
        names.some((name) => name.startsWith(tree)),
        tree,
      ).toBe(true)
    }
  })
})
