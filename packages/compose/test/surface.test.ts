import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { compareSkeletons, locateFile, SpliceRefusedError } from '../src/surface.js'

const DECK = `---
slideId: intro
layout: statement
heading: Welcome to the workshop
---

A first paragraph of prose.

\`\`\`bash
kubectl get pods
\`\`\`

---
slideId: second
---

# Second slide

Another paragraph.
`

const LAB = `<!-- labId: lab-one -->
# Lab one

Do the thing.

\`\`\`bash
kubectl apply -f pod.yaml
\`\`\`
`

const QUIZ = `{
  "schemaVersion": 1,
  "questions": [
    {
      "id": "S01-Q-ONE-01",
      "section": "S01",
      "difficulty": "beginner",
      "prompt": "What is a Pod?",
      "options": [
        { "id": "a", "text": "A group of containers", "rationale": "Right." },
        { "id": "b", "text": "A node", "rationale": "Nodes run Pods." }
      ],
      "answer": "a",
      "explanation": "Pods group containers.",
      "learningObjective": "Name the smallest unit.",
      "references": ["https://kubernetes.io/docs/concepts/workloads/pods/"]
    }
  ]
}
`

function ids(text: string, surface: 'slides' | 'labs'): readonly string[] {
  return locateFile(surface, text).holes.map((hole) => formatUnitId(hole.id))
}

describe('locateFile', () => {
  it('locates slide units and reports each slide layout', () => {
    const located = locateFile('slides', DECK)
    expect(ids(DECK, 'slides')).toContain('slides:intro:fm/heading')
    expect(located.layoutOf('intro')).toBe('statement')
    expect(located.layoutOf('second')).toBeUndefined()
  })

  it('reproduces every surface from an empty replacement set', () => {
    expect(locateFile('slides', DECK).compose(new Map())).toBe(DECK)
    expect(locateFile('labs', LAB).compose(new Map())).toBe(LAB)
    const quiz = locateFile('quiz', QUIZ, { quizSchema: 'kubernetes-workshop' })
    expect(quiz.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(quiz.holes.length).toBeGreaterThan(0)
    expect(quiz.compose(new Map())).toBe(QUIZ)
  })

  it('refuses to locate a quiz without the manifest schema variant', () => {
    expect(() => locateFile('quiz', QUIZ)).toThrow(/schema variant/)
  })

  it('normalizes every extractor refusal into one error type naming the unit', () => {
    const located = locateFile('slides', DECK)
    const id = 'slides:intro:body/p-1'
    expect(located.holes.map((hole) => formatUnitId(hole.id))).toContain(id)
    try {
      located.compose(new Map([[id, 'eins\n---\nzwei']]))
      expect.unreachable('a slide separator must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(SpliceRefusedError)
      expect((error as SpliceRefusedError).refusals.map((item) => item.id)).toEqual([id])
    }
  })
})

describe('compareSkeletons', () => {
  const english = locateFile('slides', DECK)

  it('accepts a composed file whose only changes are inside holes', () => {
    const composed = english.compose(
      new Map([
        ['slides:intro:body/p-1', 'Ein erster Absatz.'],
        ['slides:intro:fm/heading', 'Willkommen: im "Workshop"'],
      ]),
    )
    expect(compareSkeletons(english, locateFile('slides', composed))).toBeUndefined()
  })

  it('catches a translation that splits one unit into two paragraphs', () => {
    const composed = english.compose(new Map([['slides:intro:body/p-1', 'Eins.\n\nZwei.']]))
    const mismatch = compareSkeletons(english, locateFile('slides', composed))
    expect(mismatch?.message).toMatch(/unit|skeleton/)
  })

  it('catches a translation that turns a paragraph into a list', () => {
    const composed = english.compose(new Map([['slides:intro:body/p-1', 'Eins\n1. zwei']]))
    expect(compareSkeletons(english, locateFile('slides', composed))).toBeDefined()
  })

  it('catches an edited fence in a generated file, naming its line', () => {
    const tampered = DECK.replace('kubectl get pods', 'kubectl delete pods --all')
    const mismatch = compareSkeletons(english, locateFile('slides', tampered))
    expect(mismatch).toEqual({
      line: 10,
      message:
        'protected skeleton differs from the English before unit slides:second:body/h1-1/title',
    })
  })

  it('catches an edited frontmatter key', () => {
    const tampered = DECK.replace('layout: statement', 'layout: cover')
    expect(compareSkeletons(english, locateFile('slides', tampered))).toBeDefined()
  })

  it('catches trailing bytes appended after the last unit', () => {
    const tampered = `${DECK}<script>alert(1)</script>\n`
    expect(compareSkeletons(english, locateFile('slides', tampered))?.message).toMatch(
      /after the last unit|unit/,
    )
  })

  it('catches a lab whose fenced command was changed', () => {
    const lab = locateFile('labs', LAB)
    const tampered = LAB.replace('pod.yaml', 'evil.yaml')
    expect(compareSkeletons(lab, locateFile('labs', tampered))).toBeDefined()
  })

  it('catches a quiz whose answer key was changed', () => {
    const context = { quizSchema: 'kubernetes-workshop' } as const
    const quiz = locateFile('quiz', QUIZ, context)
    const tampered = QUIZ.replace('"answer": "a"', '"answer": "b"')
    expect(compareSkeletons(quiz, locateFile('quiz', tampered, context))).toBeDefined()
  })
})
