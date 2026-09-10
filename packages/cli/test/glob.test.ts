import { describe, expect, it } from 'vitest'
import { compileGlob, GlobError, MAX_GLOB_ALTERNATIVES } from '../src/glob.js'

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
    expect(matches('[ab].md', '[ab].md')).toBe(true)
    expect(matches('[ab].md', 'a.md')).toBe(false)
  })

  it('lets * match within one segment only', () => {
    expect(matches('labs/*.md', 'labs/05-pod.md')).toBe(true)
    expect(matches('labs/*.md', 'labs/day-1/05-pod.md')).toBe(false)
    expect(matches('labs/*-pod*.md', 'labs/05-pod.solution.md')).toBe(true)
    expect(matches('labs/*-pod*.md', 'labs/05-pods')).toBe(false)
    expect(matches('*', 'a')).toBe(true)
    expect(matches('a*', 'a')).toBe(true)
  })

  it('lets ** match zero or more whole segments', () => {
    expect(matches('pages/**/index.md', 'pages/index.md')).toBe(true)
    expect(matches('pages/**/index.md', 'pages/S05-pod/index.md')).toBe(true)
    expect(matches('pages/**/index.md', 'pages/a/b/index.md')).toBe(true)
    expect(matches('pages/**/index.md', 'pages/a/b/notindex.md')).toBe(false)
    expect(matches('labs/**', 'labs/day-1/x.md')).toBe(true)
    expect(matches('**/x.md', 'x.md')).toBe(true)
    expect(matches('a/**/b/**/c.md', 'a/x/b/y/z/c.md')).toBe(true)
    expect(matches('a/**/b/**/c.md', 'a/x/y/z/c.md')).toBe(false)
  })

  it('does not let a wildcard match a leading dot', () => {
    expect(matches('labs/**/*.md', 'labs/.hidden/x.md')).toBe(false)
    expect(matches('labs/*.md', 'labs/.x.md')).toBe(false)
    expect(matches('labs/?x.md', 'labs/.x.md')).toBe(false)
    expect(matches('labs/.x.md', 'labs/.x.md')).toBe(true)
  })

  it('supports ? and brace alternatives', () => {
    expect(matches('slides-?.md', 'slides-1.md')).toBe(true)
    expect(matches('slides-?.md', 'slides-12.md')).toBe(false)
    expect(matches('labs/**/*.{md,markdown}', 'labs/a.markdown')).toBe(true)
    expect(matches('labs/**/*.{md,markdown}', 'labs/a.txt')).toBe(false)
  })

  it('lets a brace alternative name a dot-directory literally', () => {
    expect(matches('{.github,docs}/*.md', '.github/a.md')).toBe(true)
    expect(matches('{.github,docs}/*.md', 'docs/a.md')).toBe(true)
  })

  it('supports nested braces', () => {
    expect(matches('{a,{b,c}}.md', 'c.md')).toBe(true)
    expect(matches('{a,{b,c}}.md', 'd.md')).toBe(false)
    expect(matches('x{1,2{a,b}}.md', 'x2b.md')).toBe(true)
  })

  it('refuses an unbalanced brace instead of matching nothing', () => {
    expect(() => compileGlob('labs/{a,b.md')).toThrow(GlobError)
    expect(() => compileGlob('labs/a,b}.md')).toThrow(GlobError)
  })

  it('refuses a brace explosion', () => {
    const pattern = '{a,b}'.repeat(8)
    expect(2 ** 8).toBeGreaterThan(MAX_GLOB_ALTERNATIVES)
    expect(() => compileGlob(pattern)).toThrow(/expands to more than/)
  })

  it('refuses "." segments, which would never match a walked path', () => {
    expect(() => compileGlob('./labs/*.md')).toThrow(/"\." segment/)
  })

  it('refuses a ".." segment spelled through a brace alternative', () => {
    expect(() => compileGlob('{..,labs}/x.md')).toThrow(/escapes the repository/)
  })

  it('matches pathological star runs in linear-ish time (no regex backtracking)', () => {
    const name = `labs/${'a'.repeat(60)}.md`
    const started = performance.now()
    expect(matches('labs/*a*a*a*a*a*a*a*a*b.md', name)).toBe(false)
    expect(matches('*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(200))).toBe(false)
    expect(matches(`${'**/'.repeat(12)}b`, `${'a/'.repeat(60)}c`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('compileGlob(...).bases', () => {
  it('is the leading run of literal directory segments, per alternative', () => {
    expect(compileGlob('pages/**/index.md').bases).toEqual(['pages'])
    expect(compileGlob('labs/day-*/x.md').bases).toEqual(['labs'])
    expect(compileGlob('quiz/questions.json').bases).toEqual(['quiz'])
    expect(compileGlob('**/*.md').bases).toEqual([''])
    expect(compileGlob('README.md').bases).toEqual([''])
    expect(compileGlob('{labs,docs}/**/*.md').bases).toEqual(['docs', 'labs'])
  })
})
