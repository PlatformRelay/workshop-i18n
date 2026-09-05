import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { extractQuizFile, locateQuizFile, QuizExtractionError } from '../src/extract.js'
import { composeSkeleton } from '../src/skeleton.js'

function question(id: string, optionIds: readonly string[] = ['a', 'b', 'c']): unknown {
  return {
    id,
    section: id.slice(0, 3),
    prompt: `Prompt for ${id}?`,
    options: optionIds.map((optionId) => ({
      id: optionId,
      text: `Text ${optionId}`,
      rationale: `Rationale ${optionId}`,
    })),
    answer: optionIds[0],
    explanation: `Explanation for ${id}.`,
    difficulty: 'introductory',
    learningObjective: `Objective for ${id}.`,
    references: ['https://example.invalid/'],
  }
}

function bank(...questions: unknown[]): string {
  return `${JSON.stringify({ schemaVersion: 1, questions }, null, 2)}\n`
}

const OPTIONS = { schema: 'kubernetes-workshop' } as const
const SOURCE = bank(question('S00-Q-RET-01'), question('S01-Q-SCN-02', ['x', 'y', 'z']))

describe('extractQuizFile', () => {
  const extraction = extractQuizFile(SOURCE, OPTIONS)

  it('addresses every unit as quiz:<questionId>:<unitKey>', () => {
    expect(extraction.units.map((unit) => formatUnitId(unit.id))).toEqual([
      'quiz:S00-Q-RET-01:explanation',
      'quiz:S00-Q-RET-01:option/a/rationale',
      'quiz:S00-Q-RET-01:option/a/text',
      'quiz:S00-Q-RET-01:option/b/rationale',
      'quiz:S00-Q-RET-01:option/b/text',
      'quiz:S00-Q-RET-01:option/c/rationale',
      'quiz:S00-Q-RET-01:option/c/text',
      'quiz:S00-Q-RET-01:prompt',
      'quiz:S01-Q-SCN-02:explanation',
      'quiz:S01-Q-SCN-02:option/x/rationale',
      'quiz:S01-Q-SCN-02:option/x/text',
      'quiz:S01-Q-SCN-02:option/y/rationale',
      'quiz:S01-Q-SCN-02:option/y/text',
      'quiz:S01-Q-SCN-02:option/z/rationale',
      'quiz:S01-Q-SCN-02:option/z/text',
      'quiz:S01-Q-SCN-02:prompt',
    ])
  })

  it('keys options by their declared id, not by their position in the array', () => {
    const reordered = bank(question('S00-Q-RET-01', ['c', 'b', 'a']))
    expect(
      extractQuizFile(reordered, OPTIONS)
        .units.map((unit) => formatUnitId(unit.id))
        .filter((id) => id.includes('option/')),
    ).toEqual(
      extractQuizFile(bank(question('S00-Q-RET-01')), OPTIONS)
        .units.map((unit) => formatUnitId(unit.id))
        .filter((id) => id.includes('option/')),
    )
  })

  it('never emits an id, a correctness flag, a section key or any other structural field', () => {
    const sources = extraction.units.map((unit) => unit.source)
    expect(sources).not.toContain('S00')
    expect(sources).not.toContain('a')
    expect(sources).not.toContain('introductory')
    expect(sources).not.toContain('https://example.invalid/')
    expect(sources).not.toContain('Objective for S00-Q-RET-01.')
  })

  it('anchors every unit on a source hash', () => {
    expect(extraction.units.every((unit) => unit.sourceHash.startsWith('sha256:'))).toBe(true)
  })

  it('reproduces the file byte-for-byte from an empty catalog', () => {
    expect(composeSkeleton(extraction.skeleton, {})).toBe(SOURCE)
  })

  it('keeps every non-translatable byte identical when everything is translated', () => {
    const translations = Object.fromEntries(
      extraction.units.map((unit, index) => [formatUnitId(unit.id), `uebersetzt ${index}`]),
    )
    const composed = composeSkeleton(extraction.skeleton, translations)
    const before = JSON.parse(SOURCE) as { questions: Record<string, unknown>[] }
    const after = JSON.parse(composed) as { questions: Record<string, unknown>[] }
    for (const [index, question] of before.questions.entries()) {
      const other = after.questions[index] as Record<string, unknown>
      for (const key of ['id', 'section', 'answer', 'difficulty', 'learningObjective']) {
        expect(other[key]).toEqual(question[key])
      }
      expect(other.references).toEqual(question.references)
    }
    expect(composed).not.toBe(SOURCE)
  })

  it('is deterministic', () => {
    expect(extractQuizFile(SOURCE, OPTIONS)).toEqual(extractQuizFile(SOURCE, OPTIONS))
  })

  it('reports the questions it saw, in source order', () => {
    expect(extraction.questionIds).toEqual(['S00-Q-RET-01', 'S01-Q-SCN-02'])
  })

  describe('failing closed', () => {
    it('refuses a file that matches neither schema variant, naming the manifest entry', () => {
      let caught: unknown
      try {
        extractQuizFile('{"schemaVersion": 2, "questions": []}', OPTIONS, 'quiz/questions.json')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(QuizExtractionError)
      expect((caught as Error).message).toContain('surfaces.quiz.schema')
      expect((caught as Error).message).toContain('kubernetes-workshop')
      expect((caught as Error).message).toContain('quiz/questions.json')
      expect((caught as QuizExtractionError).diagnostics.map((item) => item.code)).toContain(
        'unknown-quiz-schema',
      )
    })

    it('refuses malformed JSON', () => {
      expect(() => extractQuizFile('{"questions": ', OPTIONS)).toThrow(QuizExtractionError)
      expect(
        locateQuizFile('{"questions": ', OPTIONS).diagnostics.map((item) => item.code),
      ).toEqual(['malformed-json'])
    })

    it('refuses a duplicate question id, naming both', () => {
      const source = bank(question('S00-Q-RET-01'), question('S00-Q-RET-01'))
      expect(() => extractQuizFile(source, OPTIONS)).toThrow(QuizExtractionError)
      expect(locateQuizFile(source, OPTIONS).diagnostics.map((item) => item.code)).toEqual([
        'duplicate-question-id',
      ])
    })

    it('refuses a question id that is not usable as a container id', () => {
      const source = bank({ ...(question('S00-Q-RET-01') as object), id: '../../etc/passwd' })
      expect(locateQuizFile(source, OPTIONS).diagnostics.map((item) => item.code)).toEqual([
        'unsafe-question-id',
      ])
    })

    it('refuses a question id that does not match the schema pattern', () => {
      const source = bank({ ...(question('S00-Q-RET-01') as object), id: 'not-a-question-id' })
      expect(locateQuizFile(source, OPTIONS).diagnostics.map((item) => item.code)).toEqual([
        'unsafe-question-id',
      ])
    })

    it('refuses an option id that would not survive as a unit-key segment', () => {
      const source = bank(question('S00-Q-RET-01', ['a/b', 'c', 'd']))
      expect(locateQuizFile(source, OPTIONS).diagnostics.map((item) => item.code)).toEqual([
        'unsafe-option-id',
      ])
    })

    it('refuses a duplicate option id inside one question', () => {
      const source = bank(question('S00-Q-RET-01', ['a', 'a', 'b']))
      expect(locateQuizFile(source, OPTIONS).diagnostics.map((item) => item.code)).toEqual([
        'duplicate-option-id',
      ])
    })
  })
})

describe('locateQuizFile', () => {
  it('reports rather than throws, and still reproduces a refused file byte-for-byte', () => {
    for (const source of ['{"questions": ', '{"schemaVersion": 2, "questions": []}', 'null']) {
      const located = locateQuizFile(source, OPTIONS)
      expect(located.units).toEqual([])
      expect(located.diagnostics.some((item) => item.severity === 'error')).toBe(true)
      expect(composeSkeleton(located.skeleton, {})).toBe(source)
    }
  })
})
