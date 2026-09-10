import { describe, expect, it } from 'vitest'
import { compileGlob, globBase } from '../src/glob.js'

function matches(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path)
}

describe('compileGlob', () => {
  it('matches a literal path exactly', () => {
    expect(matches('quiz/questions.json', 'quiz/questions.json')).toBe(true)
    expect(matches('quiz/questions.json', 'quiz/questions.jsonx')).toBe(false)
    expect(matches('quiz/questions.json', 'x/quiz/questions.json')).toBe(false)
  })

  it('treats regex metacharacters in a literal as literal', () => {
    expect(matches('a.b/(c)+.md', 'a.b/(c)+.md')).toBe(true)
    expect(matches('a.b/c.md', 'aXb/c.md')).toBe(false)
  })

  it('lets * match within one segment only', () => {
    expect(matches('labs/*.md', 'labs/05-pod.md')).toBe(true)
    expect(matches('labs/*.md', 'labs/day-1/05-pod.md')).toBe(false)
  })

  it('lets ** match zero or more whole segments', () => {
    expect(matches('pages/**/index.md', 'pages/index.md')).toBe(true)
    expect(matches('pages/**/index.md', 'pages/S05-pod/index.md')).toBe(true)
    expect(matches('pages/**/index.md', 'pages/a/b/index.md')).toBe(true)
    expect(matches('pages/**/index.md', 'pages/a/b/notindex.md')).toBe(false)
    expect(matches('labs/**', 'labs/day-1/x.md')).toBe(true)
  })

  it('does not let a wildcard match a leading dot', () => {
    expect(matches('labs/**/*.md', 'labs/.hidden/x.md')).toBe(false)
    expect(matches('labs/*.md', 'labs/.x.md')).toBe(false)
    expect(matches('labs/.x.md', 'labs/.x.md')).toBe(true)
  })

  it('supports ? and brace alternatives', () => {
    expect(matches('slides-?.md', 'slides-1.md')).toBe(true)
    expect(matches('slides-?.md', 'slides-12.md')).toBe(false)
    expect(matches('labs/**/*.{md,markdown}', 'labs/a.markdown')).toBe(true)
    expect(matches('labs/**/*.{md,markdown}', 'labs/a.txt')).toBe(false)
  })
})

describe('globBase', () => {
  it('is the leading run of literal directory segments', () => {
    expect(globBase('pages/**/index.md')).toBe('pages')
    expect(globBase('labs/day-*/x.md')).toBe('labs')
    expect(globBase('quiz/questions.json')).toBe('quiz')
    expect(globBase('**/*.md')).toBe('')
    expect(globBase('README.md')).toBe('')
  })
})
