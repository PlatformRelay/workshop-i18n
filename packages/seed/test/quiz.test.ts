import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { alignQuiz } from '../src/quiz.js'
import { type SectionAlignment, SeedInputError } from '../src/types.js'

interface Option {
  id: string
  text: string
  rationale: string
}
interface Question {
  id: string
  section: string
  prompt: string
  options: Option[]
  answer: string
  explanation: string
  difficulty: string
  learningObjective: string
  references: string[]
}

const question = (id: string, lang: 'en' | 'pt', answer = 'a'): Question => ({
  id,
  section: 'S05',
  prompt: lang === 'en' ? `What is ${id}?` : `O que é ${id}?`,
  options: [
    {
      id: 'a',
      text: lang === 'en' ? 'A Pod' : 'Um Pod',
      rationale: lang === 'en' ? 'Yes.' : 'Sim.',
    },
    { id: 'b', text: lang === 'en' ? 'A VM' : 'Uma VM', rationale: lang === 'en' ? 'No.' : 'Não.' },
  ],
  answer,
  explanation: lang === 'en' ? 'Pods are atoms.' : 'Pods são átomos.',
  difficulty: 'introductory',
  learningObjective: 'x',
  references: [],
})

const bank = (questions: Question[]) =>
  JSON.stringify({ $schema: './questions.schema.json', schemaVersion: 1, questions }, null, 2)

const file = (text: string) => ({ path: 'quiz/questions.json', text })
const OPTIONS = { schema: 'kubernetes-workshop' } as const

function only(sections: readonly SectionAlignment[]): SectionAlignment {
  expect(sections).toHaveLength(1)
  return sections[0] as SectionAlignment
}

describe('alignQuiz', () => {
  const EN = bank([question('S05-Q-A-01', 'en'), question('S05-Q-B-01', 'en')])

  it('aligns every question by its explicit id (AS-1)', () => {
    const PT = bank([question('S05-Q-B-01', 'pt'), question('S05-Q-A-01', 'pt')])
    const section = only(alignQuiz([file(EN)], [file(PT)], OPTIONS).sections)
    expect(section.surface).toBe('quiz')
    expect(section.misses).toEqual([])
    expect(section.englishUnits).toBe(12)
    expect(
      Object.fromEntries(
        section.drafts.map((draft) => [formatUnitId(draft.id), draft.translation]),
      ),
    ).toMatchObject({
      'quiz:S05-Q-A-01:prompt': 'O que é S05-Q-A-01?',
      'quiz:S05-Q-B-01:option/b/rationale': 'Não.',
      'quiz:S05-Q-A-01:explanation': 'Pods são átomos.',
    })
  })

  it('misses a question the translated bank does not have', () => {
    const PT = bank([question('S05-Q-A-01', 'pt')])
    const section = only(alignQuiz([file(EN)], [file(PT)], OPTIONS).sections)
    expect(
      section.misses.map((miss) => [miss.reason, miss.containerId, miss.unitIds.length]),
    ).toEqual([['question-missing', 'S05-Q-B-01', 6]])
  })

  it('misses a question whose answer or options diverged — a translation cannot change the key', () => {
    const swapped = question('S05-Q-A-01', 'pt', 'b')
    const reordered = question('S05-Q-B-01', 'pt')
    reordered.options.reverse()
    const section = only(
      alignQuiz([file(EN)], [file(bank([swapped, reordered]))], OPTIONS).sections,
    )
    expect(section.drafts).toEqual([])
    expect(section.misses.map((miss) => [miss.reason, miss.containerId])).toEqual([
      ['structure-diverged', 'S05-Q-A-01'],
      ['structure-diverged', 'S05-Q-B-01'],
    ])
  })

  it('misses the whole bank when the translated file is not a readable bank', () => {
    const section = only(alignQuiz([file(EN)], [file('{"questions": [')], OPTIONS).sections)
    expect(section.misses.map((miss) => miss.reason)).toEqual(['unreadable-translation'])
    expect(section.misses[0]?.unitIds).toHaveLength(12)
  })

  it('misses the whole bank when a translated question id is unsafe or duplicated', () => {
    const dup = bank([question('S05-Q-A-01', 'pt'), question('S05-Q-A-01', 'pt')])
    expect(only(alignQuiz([file(EN)], [file(dup)], OPTIONS).sections).misses[0]?.reason).toBe(
      'unreadable-translation',
    )
  })

  it('throws when the English bank cannot be extracted', () => {
    expect(() => alignQuiz([file('{}')], [file(EN)], OPTIONS)).toThrow(SeedInputError)
  })
})
