import { parseManifest, QUIZ_SCHEMA_VARIANTS } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { scanJson } from '../src/json-scan.js'
import {
  detectQuizSchemas,
  QUIZ_MANIFEST_ENTRY,
  QUIZ_SHAPES,
  QuizSchemaError,
  quizSchemaOf,
} from '../src/schema.js'

const BANK = JSON.stringify({
  schemaVersion: 1,
  questions: [
    {
      id: 'S00-Q-RET-01',
      section: 'S00',
      prompt: 'Why?',
      options: [
        { id: 'a', text: 'Because.', rationale: 'It is.' },
        { id: 'b', text: 'Nope.', rationale: 'It is not.' },
        { id: 'c', text: 'Maybe.', rationale: 'Unclear.' },
      ],
      answer: 'a',
      explanation: 'Because.',
      difficulty: 'introductory',
      learningObjective: 'Know why.',
      references: ['https://example.invalid/'],
    },
  ],
})

const MANIFEST = (schema: string): string =>
  [
    'apiVersion: workshop-i18n/v1',
    'locales:',
    '  targets: [de]',
    'surfaces:',
    '  quiz:',
    '    include: ["quiz/questions.json"]',
    `    schema: ${schema}`,
  ].join('\n')

describe('QUIZ_SHAPES', () => {
  it('declares a shape for every variant core knows', () => {
    expect(Object.keys(QUIZ_SHAPES).sort()).toEqual([...QUIZ_SCHEMA_VARIANTS].sort())
  })

  it('marks exactly the four translatable fields, and no structural one', () => {
    for (const shape of Object.values(QUIZ_SHAPES)) {
      expect(shape.translatableQuestionKeys).toEqual(['prompt', 'explanation'])
      expect(shape.translatableOptionKeys).toEqual(['text', 'rationale'])
      for (const key of [...shape.translatableQuestionKeys, ...shape.translatableOptionKeys]) {
        expect(['id', 'section', 'answer', 'difficulty', 'references']).not.toContain(key)
      }
    }
  })
})

describe('detectQuizSchemas', () => {
  it('recognizes a well-formed bank', () => {
    expect(detectQuizSchemas(scanJson(BANK))).toEqual([...QUIZ_SCHEMA_VARIANTS])
  })

  it.each([
    ['the root is an array', '[]'],
    ['the root is a scalar', '"nope"'],
    ['there is no questions key', '{"schemaVersion": 1}'],
    ['questions is empty', '{"schemaVersion": 1, "questions": []}'],
    [
      'the schema version is one this release does not know',
      '{"schemaVersion": 2, "questions": []}',
    ],
    [
      'a question is missing a required key',
      '{"schemaVersion": 1, "questions": [{"id": "S00-Q-A"}]}',
    ],
    [
      'a translatable field is not a string',
      JSON.stringify(JSON.parse(BANK), (key, value) => (key === 'prompt' ? 42 : value)),
    ],
    [
      'an option is missing its rationale',
      JSON.stringify({
        schemaVersion: 1,
        questions: [
          {
            id: 'S00-Q-A',
            section: 'S00',
            prompt: 'p',
            options: [{ id: 'a', text: 't' }],
            answer: 'a',
            explanation: 'e',
            difficulty: 'introductory',
            learningObjective: 'l',
            references: ['https://example.invalid/'],
          },
        ],
      }),
    ],
  ])('matches nothing when %s', (_label, text) => {
    expect(detectQuizSchemas(scanJson(text))).toEqual([])
  })
})

describe('quizSchemaOf', () => {
  it('reads the variant the manifest declares', () => {
    expect(quizSchemaOf(parseManifest(MANIFEST('kubernetes-workshop')))).toBe('kubernetes-workshop')
    expect(quizSchemaOf(parseManifest(MANIFEST('opentofu-workshop')))).toBe('opentofu-workshop')
  })

  it('fails naming the manifest entry when no quiz surface is declared', () => {
    const manifest = parseManifest(
      [
        'apiVersion: workshop-i18n/v1',
        'locales:',
        '  targets: [de]',
        'surfaces:',
        '  labs:',
        '    include: ["labs/**/*.md"]',
      ].join('\n'),
    )
    let caught: unknown
    try {
      quizSchemaOf(manifest)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(QuizSchemaError)
    expect((caught as QuizSchemaError).manifestEntry).toBe('surfaces.quiz')
    expect((caught as QuizSchemaError).message).toContain('surfaces.quiz')
  })

  it('exposes the manifest path its errors name', () => {
    expect(QUIZ_MANIFEST_ENTRY).toBe('surfaces.quiz.schema')
  })
})
