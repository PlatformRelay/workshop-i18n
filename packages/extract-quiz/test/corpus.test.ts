/**
 * The four round-trip property groups spec 001 SC-003 names, run over **every** quiz
 * fixture rather than a curated subset: losslessness, structure identity, identity
 * stability under edit/move/reorder, and determinism.
 *
 * The corpus is both consumers' real question banks (`fixtures/PROVENANCE.md`). They are
 * the argument for the offset-splice model in one file pair: identical JSON Schemas,
 * completely different *formatting* — one writes each option on a single line with no
 * escape anywhere, the other pretty-prints options across four lines and carries 52 `\"`
 * escapes. A `JSON.parse` → mutate → `JSON.stringify` extractor would rewrite each into
 * the other's shape and produce a diff on every line of a file where nothing changed.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnitId, QUIZ_SCHEMA_VARIANTS, type QuizSchemaVariant } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import type { DiagnosticCode } from '../src/diagnostic.js'
import { extractQuizFile, locateQuizFile, QuizExtractionError } from '../src/extract.js'
import { memberOf, scanJson } from '../src/json-scan.js'
import { composeSkeleton } from '../src/skeleton.js'
import { decodeSource } from '../src/source.js'

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/', import.meta.url))

interface Fixture {
  readonly name: string
  readonly bytes: Buffer
  readonly source: string
  readonly schema: QuizSchemaVariant
}

function load(directory: string): readonly Fixture[] {
  const base = join(FIXTURE_ROOT, directory)
  return readdirSync(base)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(base, name))
      return {
        name: `${directory}/${name}`,
        bytes,
        source: decodeSource(bytes, name),
        // The corpus files are named after the variant they came from; the adversarial
        // ones are shape-compatible with both, so either declaration must extract them.
        schema: (QUIZ_SCHEMA_VARIANTS.find((variant) => name.startsWith(variant)) ??
          'kubernetes-workshop') as QuizSchemaVariant,
      }
    })
}

/** Every fixture that must round-trip. */
const CORPUS: readonly Fixture[] = [...load('corpus-quiz'), ...load('adversarial-quiz')]

/** Fixtures that must be refused, and the diagnostic each must raise. */
const REJECTED: readonly (readonly [string, DiagnosticCode])[] = [
  ['byte-order-mark.json', 'malformed-json'],
  ['duplicate-question-id.json', 'duplicate-question-id'],
  ['question-missing-prompt.json', 'unknown-quiz-schema'],
  ['root-is-an-array.json', 'unknown-quiz-schema'],
  ['truncated.json', 'malformed-json'],
  ['unknown-schema-version.json', 'unknown-quiz-schema'],
  ['unsafe-option-id.json', 'unsafe-option-id'],
  ['unsafe-question-id.json', 'unsafe-question-id'],
]

/**
 * The translatable strings, read out with `JSON.parse` rather than with the scanner
 * under test. If the scanner's own string decoding were wrong, asking it to check itself
 * would agree — this is the differential that catches an escape handled two ways.
 */
function expectedStrings(source: string): readonly [string, string][] {
  const document = JSON.parse(source) as {
    questions: {
      id: string
      prompt: string
      explanation: string
      options: { id: string; text: string; rationale: string }[]
    }[]
  }
  const out: [string, string][] = []
  for (const question of document.questions) {
    out.push([`quiz:${question.id}:prompt`, question.prompt])
    out.push([`quiz:${question.id}:explanation`, question.explanation])
    for (const option of question.options) {
      out.push([`quiz:${question.id}:option/${option.id}/text`, option.text])
      out.push([`quiz:${question.id}:option/${option.id}/rationale`, option.rationale])
    }
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The structural fields that must be identical in every locale. */
function structure(source: string): unknown {
  const document = JSON.parse(source) as { questions: Record<string, unknown>[] }
  return document.questions.map((question) => ({
    id: question.id,
    section: question.section,
    answer: question.answer,
    difficulty: question.difficulty,
    learningObjective: question.learningObjective,
    references: question.references,
    options: (question.options as { id: string }[]).map((option) => option.id),
  }))
}

describe.each(CORPUS.map((fixture) => [fixture.name, fixture] as const))(
  'round-trip properties over %s',
  (_name, fixture) => {
    const options = { schema: fixture.schema } as const
    const extraction = extractQuizFile(fixture.source, options, fixture.name)

    // Group 1 — losslessness.
    it('decodes and re-encodes without losing a byte', () => {
      expect(decodeSource(fixture.bytes)).toBe(fixture.source)
      expect(Buffer.from(fixture.source, 'utf8')).toEqual(fixture.bytes)
    })

    it('reproduces the source byte-for-byte from an empty catalog (SC-002)', () => {
      const composed = composeSkeleton(extraction.skeleton, {})
      expect(composed).toBe(fixture.source)
      expect(Buffer.from(composed, 'utf8')).toEqual(fixture.bytes)
    })

    it('treats translating every unit to its own English as a no-op', () => {
      const identity = Object.fromEntries(
        extraction.units.map((unit) => [formatUnitId(unit.id), unit.source]),
      )
      expect(composeSkeleton(extraction.skeleton, identity)).toBe(fixture.source)
    })

    it('decodes every string exactly as JSON.parse does', () => {
      expect(extraction.units.map((unit) => [formatUnitId(unit.id), unit.source])).toEqual(
        expectedStrings(fixture.source),
      )
    })

    it('raises no error diagnostic', () => {
      expect(extraction.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    })

    it('extracts under either declared variant, because the two shapes agree today', () => {
      for (const variant of QUIZ_SCHEMA_VARIANTS) {
        expect(extractQuizFile(fixture.source, { schema: variant }).units).toEqual(extraction.units)
      }
    })

    // Group 2 — structure identity.
    it('keeps every structural field byte-identical when everything is translated', () => {
      const translations = Object.fromEntries(
        extraction.units.map((unit, index) => [formatUnitId(unit.id), `uebersetzt ${index}`]),
      )
      const translated = composeSkeleton(extraction.skeleton, translations)
      expect(() => JSON.parse(translated)).not.toThrow()
      expect(structure(translated)).toEqual(structure(fixture.source))
      expect(translated).not.toBe(fixture.source)
    })

    it('keeps key order and indentation, which a re-serializer would normalize', () => {
      const translations = Object.fromEntries(
        extraction.units.map((unit) => [formatUnitId(unit.id), 'X']),
      )
      const translated = composeSkeleton(extraction.skeleton, translations)
      // Every byte outside a hole is copied, so blanking the holes on both sides must
      // give the same string — the strongest statement of "nothing else moved".
      const blank = (text: string, holes: readonly { start: number; end: number }[]): string => {
        let out = text
        for (let index = holes.length - 1; index >= 0; index -= 1) {
          const hole = holes[index] as { start: number; end: number }
          out = out.slice(0, hole.start) + out.slice(hole.end)
        }
        return out
      }
      const translatedHoles = extractQuizFile(translated, options).skeleton.holes
      expect(blank(translated, translatedHoles)).toBe(
        blank(fixture.source, extraction.skeleton.holes),
      )
    })

    it('never emits an id, a section key, an answer or a reference as translatable text', () => {
      const document = JSON.parse(fixture.source) as { questions: Record<string, unknown>[] }
      const structural = new Set(
        document.questions.flatMap((question) => [
          String(question.id),
          String(question.section),
          String(question.answer),
          String(question.difficulty),
          String(question.learningObjective),
          ...(question.references as string[]),
          ...(question.options as { id: string }[]).map((option) => option.id),
        ]),
      )
      for (const unit of extraction.units) expect(structural.has(unit.source)).toBe(false)
    })

    // Group 3 — identity stability.
    it('changes one hash and no identity when one string of English is edited (AS-2)', () => {
      const hole = extraction.skeleton.holes[0]
      if (hole === undefined) return
      const edited = `${fixture.source.slice(0, hole.end)} (edited)${fixture.source.slice(hole.end)}`
      const after = extractQuizFile(edited, options).units
      expect(after.map((unit) => formatUnitId(unit.id))).toEqual(
        extraction.units.map((unit) => formatUnitId(unit.id)),
      )
      const moved = after.filter(
        (unit, index) => unit.sourceHash !== extraction.units[index]?.sourceHash,
      )
      expect(moved.map((unit) => formatUnitId(unit.id))).toEqual([formatUnitId(hole.id)])
    })

    it('keeps every identity when the questions are reordered (AS-3)', () => {
      const document = JSON.parse(fixture.source) as { questions: unknown[] }
      if (document.questions.length < 2) return
      const reordered = JSON.stringify({
        ...document,
        questions: [...document.questions].reverse(),
      })
      expect(
        extractQuizFile(reordered, options)
          .units.map((unit) => formatUnitId(unit.id))
          .sort(),
      ).toEqual(extraction.units.map((unit) => formatUnitId(unit.id)).sort())
    })

    it('keeps every identity when the options are reordered (AS-3)', () => {
      const document = JSON.parse(fixture.source) as {
        questions: { options: unknown[] }[]
      }
      const reordered = JSON.stringify({
        ...document,
        questions: document.questions.map((question) => ({
          ...question,
          options: [...question.options].reverse(),
        })),
      })
      expect(
        extractQuizFile(reordered, options)
          .units.map((unit) => formatUnitId(unit.id))
          .sort(),
      ).toEqual(extraction.units.map((unit) => formatUnitId(unit.id)).sort())
    })

    // Group 4 — determinism.
    it('yields identical output for identical input (FR-006)', () => {
      expect(extractQuizFile(fixture.source, options)).toEqual(
        extractQuizFile(fixture.source, options),
      )
    })

    it('emits units in identity order, with no duplicates', () => {
      const ids = extraction.units.map((unit) => formatUnitId(unit.id))
      expect(ids).toEqual([...ids].sort())
      expect(new Set(ids).size).toBe(ids.length)
    })
  },
)

describe('the hostile corpus describes the corpus it claims to test', () => {
  const all = CORPUS.map((fixture) => fixture.source).join('\n')

  it('carries both consumer banks and is large enough to be worth running', () => {
    expect(CORPUS.map((fixture) => fixture.name)).toEqual(
      expect.arrayContaining([
        'corpus-quiz/kubernetes-workshop.questions.json',
        'corpus-quiz/opentofu-workshop.questions.json',
      ]),
    )
    const units = CORPUS.reduce(
      (total, fixture) =>
        total + extractQuizFile(fixture.source, { schema: fixture.schema }).units.length,
      0,
    )
    expect(units).toBeGreaterThan(1000)
  })

  it('carries the two formatting styles that make re-serializing wrong', () => {
    const source = (name: string): string =>
      CORPUS.find((fixture) => fixture.name === `corpus-quiz/${name}`)?.source ?? ''
    // One bank writes an option on one line; the other spreads it over four.
    expect(source('kubernetes-workshop.questions.json')).toMatch(
      /\{ "id": "[^"]+", "text": "[^"]+", "rationale": "[^"]*" \}/,
    )
    expect(source('opentofu-workshop.questions.json')).toMatch(/\{\n\s+"id": "[^"]+",\n\s+"text":/)
    // One carries no string escape at all; the other carries dozens.
    expect(/\\"/.test(source('kubernetes-workshop.questions.json'))).toBe(false)
    expect((source('opentofu-workshop.questions.json').match(/\\"/g) ?? []).length).toBeGreaterThan(
      20,
    )
  })

  it.each([
    ['an escaped quote', /\\"/],
    ['an escaped backslash', /\\\\/],
    ['an escaped solidus', /\\\//],
    ['an escaped newline', /\\n/],
    ['an escaped tab', /\\t/],
    ['an escaped carriage return', /\\r/],
    ['an escaped backspace and form feed', /\\b[^"]*\\f/],
    ['a BMP \\u escape', /\\u00e9/],
    ['a surrogate pair written as escapes', /\\ud83d\\ude80/],
    ['a literal astral character', /[\u{1f300}-\u{1faff}]/u],
    ['a ZWJ sequence', /‍/],
    ['a combining mark', /́/],
    ['a right-to-left script', /[֐-ۿ]/],
    ['minified JSON with no whitespace', /\{"id":"[^"]+","section":/],
    ['tabs used as indentation', /\n\t\t"id"/],
    ['a CRLF line break', /\r\n/],
    ['an unconventional key order', /"references": \[[^\]]*\],\n\s+"learningObjective"/],
    ['a five-option question', /"id": "e"/],
  ])('contains %s', (_label, pattern) => {
    expect(all).toMatch(pattern)
  })

  it('agrees with JSON.parse about the number of translatable strings in every fixture', () => {
    for (const fixture of CORPUS) {
      const document = JSON.parse(fixture.source) as {
        questions: { options: unknown[] }[]
      }
      const expected = document.questions.reduce(
        (total, question) => total + 2 + question.options.length * 2,
        0,
      )
      expect(extractQuizFile(fixture.source, { schema: fixture.schema }).units).toHaveLength(
        expected,
      )
    }
  })
})

describe.each(REJECTED)('fixtures/adversarial-quiz-rejected/%s', (name, code) => {
  const source = decodeSource(readFileSync(join(FIXTURE_ROOT, 'adversarial-quiz-rejected', name)))
  const options = { schema: 'kubernetes-workshop' } as const

  it(`fails closed with a ${code} diagnostic`, () => {
    expect(() => extractQuizFile(source, options, `quiz/${name}`)).toThrow(QuizExtractionError)
    const located = locateQuizFile(source, options)
    expect(located.diagnostics.map((item) => item.code)).toContain(code)
    expect(located.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it('names the manifest entry when the shape is the problem', () => {
    if (code !== 'unknown-quiz-schema') return
    expect(() => extractQuizFile(source, options, `quiz/${name}`)).toThrow(/surfaces\.quiz\.schema/)
  })

  it('still reproduces the file byte-for-byte, because refusing is not mangling', () => {
    expect(composeSkeleton(locateQuizFile(source, options).skeleton, {})).toBe(source)
  })
})

describe('the scanner and JSON.parse agree on every string in the real banks', () => {
  it.each(['kubernetes-workshop.questions.json', 'opentofu-workshop.questions.json'])(
    '%s',
    (name) => {
      const source = decodeSource(readFileSync(join(FIXTURE_ROOT, 'corpus-quiz', name)))
      const root = scanJson(source, name)
      const questions = memberOf(root, 'questions')
      if (questions?.kind !== 'array') throw new Error('expected a questions array')
      const parsed = (JSON.parse(source) as { questions: Record<string, string>[] }).questions
      questions.items.forEach((node, index) => {
        for (const key of ['id', 'section', 'prompt', 'explanation', 'answer']) {
          const member = memberOf(node, key)
          if (member?.kind !== 'string') throw new Error(`expected ${key} to be a string`)
          expect(member.value).toBe((parsed[index] as Record<string, string>)[key])
          // The recorded range must slice the *raw* spelling back out of the file.
          expect(source.slice(member.start, member.end)).toBe(
            `"${source.slice(member.innerStart, member.innerEnd)}"`,
          )
        }
      })
    },
  )
})
