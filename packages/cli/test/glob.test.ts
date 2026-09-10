import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import {
  compileGlob,
  GlobError,
  MAX_GLOB_ALTERNATIVES,
  MAX_GLOB_BYTES,
  MAX_GLOB_EXPANDED_BYTES,
  MAX_GLOB_SEGMENTS,
} from '../src/glob.js'

function matches(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path)
}

/**
 * The matcher's own source as plain JavaScript, so a worker can run it without vitest.
 * This relies on glob.ts importing nothing; give it an import and these tests say so.
 * `stripTypeScriptTypes` needs Node 22.13 or later — newer than the package's `>=22`
 * engines floor, which applies to the shipped CLI, not to this test; CI runs the latest
 * 22.x. On an older Node this file fails to load rather than skipping.
 */
const GLOB_MODULE = stripTypeScriptTypes(
  readFileSync(new URL('../src/glob.ts', import.meta.url), 'utf8'),
)

/**
 * Run `body` against the real matcher (`compileGlob` in scope) in a worker thread and
 * resolve with how long it took. Vitest cannot interrupt synchronous code, so a timing
 * test run in-process would *hang* on the regression it exists to catch; a worker can be
 * terminated, so past `limitMs` the test fails with a message instead.
 */
function timeInWorker(body: string, limitMs: number): Promise<number> {
  const code = `${GLOB_MODULE}
import { parentPort } from 'node:worker_threads'
const started = performance.now()
${body}
parentPort.postMessage(performance.now() - started)
`
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`))
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`the matcher did not finish within ${limitMs} ms`))
    }, limitMs)
    worker.once('message', (elapsed: number) => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(elapsed)
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('timeInWorker (the timing tests’ harness)', () => {
  it('fails a matcher that never returns instead of hanging the suite', async () => {
    await expect(timeInWorker('for (;;) {}', 300)).rejects.toThrow('did not finish within 300 ms')
  })

  it('surfaces an error thrown by the matcher', async () => {
    await expect(timeInWorker("compileGlob('{a')", 5_000)).rejects.toThrow('unbalanced')
  })
})

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

  it('matches pathological star runs in linear-ish time (no regex backtracking)', async () => {
    const elapsed = await timeInWorker(
      `
      const name = 'labs/' + 'a'.repeat(60) + '.md'
      if (compileGlob('labs/*a*a*a*a*a*a*a*a*b.md').test(name)) throw new Error('matched')
      if (compileGlob('*a*a*a*a*a*a*a*a*a*a*a*a*b').test('a'.repeat(200))) throw new Error('matched')
      if (compileGlob('**/'.repeat(12) + 'b').test('a/'.repeat(60) + 'c')) throw new Error('matched')
      `,
      5_000,
    )
    expect(elapsed).toBeLessThan(250)
  })
})

describe('compileGlob bounds (work is bounded, not merely non-exponential)', () => {
  // The reviewer's glob: 64 brace alternatives, 500 `*` segments. Before the bounds it
  // took `extract --check` on the real corpus from under a second to nearly three minutes.
  const HOSTILE = `{${Array(64).fill('*').join(',')}}/${'*/'.repeat(500)}x.md`

  it('refuses a glob longer than the byte limit, saying what the limit is', () => {
    expect(new TextEncoder().encode(HOSTILE).length).toBeGreaterThan(MAX_GLOB_BYTES)
    expect(() => compileGlob(HOSTILE)).toThrow(GlobError)
    expect(() => compileGlob(HOSTILE)).toThrow(`longer than ${MAX_GLOB_BYTES} bytes`)
  })

  it('counts the limit in UTF-8 bytes, not characters', () => {
    const wide = `labs/${'ü'.repeat(MAX_GLOB_BYTES / 2)}.md`
    expect(wide.length).toBeLessThan(MAX_GLOB_BYTES)
    expect(() => compileGlob(wide)).toThrow(`longer than ${MAX_GLOB_BYTES} bytes`)
    expect(() => compileGlob(`labs/${'x'.repeat(MAX_GLOB_BYTES - 5)}`)).not.toThrow()
  })

  it('refuses an alternative with more segments than the segment limit', () => {
    const deep = `${'a/'.repeat(MAX_GLOB_SEGMENTS)}x.md`
    expect(() => compileGlob(deep)).toThrow(`more than ${MAX_GLOB_SEGMENTS} path segments`)
    expect(() => compileGlob(`${'a/'.repeat(MAX_GLOB_SEGMENTS - 1)}x.md`)).not.toThrow()
    expect(() => compileGlob(`{x,${'*/'.repeat(MAX_GLOB_SEGMENTS)}y}.md`)).toThrow(
      `more than ${MAX_GLOB_SEGMENTS} path segments`,
    )
  })

  it('collapses a run of ** into one before counting segments, without changing matches', () => {
    const glob = `labs/${'**/'.repeat(MAX_GLOB_SEGMENTS * 2)}x.md`
    expect(matches(glob, 'labs/x.md')).toBe(true)
    expect(matches(glob, 'labs/a/b/c/x.md')).toBe(true)
    expect(matches(glob, 'labs/a/b/c/y.md')).toBe(false)
    expect(matches(glob, 'labs/.hidden/x.md')).toBe(false)
  })

  it('deduplicates brace alternatives before counting them', () => {
    const repeated = `{${Array(MAX_GLOB_ALTERNATIVES * 2)
      .fill('x')
      .join(',')}}/*.md`
    const glob = compileGlob(repeated)
    expect(glob.bases).toEqual(['x'])
    expect(glob.test('x/a.md')).toBe(true)
    expect(() => compileGlob(`{*,*}{*,*}{*,*}{*,*}{*,*}{*,*}{*,*}/x.md`)).not.toThrow()
  })

  it('keeps a worst-case glob the bounds still admit fast on deep paths', async () => {
    // Close to every limit at once: four alternatives of ~460 bytes (just under the
    // expanded-bytes limit), 31 segments with `**` between star-heavy segments that fail
    // late, tested against thousands of deep, long paths the attacker also controls.
    const elapsed = await timeInWorker(
      `
      const star = '*a'.repeat(12) + '*b'
      const pattern = '{a,b}{a,b}/**/' + Array(15).fill(star).join('/**/')
      const glob = compileGlob(pattern)
      const segment = 'a'.repeat(60)
      for (let file = 0; file < 2000; file += 1) {
        const path = Array(8).fill(segment).join('/') + '/' + file + segment
        if (glob.test(path)) throw new Error('matched ' + path)
      }
      `,
      20_000,
    )
    expect(elapsed).toBeLessThan(5_000)
  }, 30_000)

  it('never retries a (segment, name) pair: ** between wildcards on a deep path', async () => {
    // `**` runs collapse, so the pattern alternates `**` with `*`, which every name
    // satisfies; only the memo keeps the ways of splitting 30 names across 15 `**` from
    // being tried one by one (without it this is seconds at depth 26, x12 per 4 levels).
    const elapsed = await timeInWorker(
      `
      const glob = compileGlob(Array(15).fill('**/*').join('/') + '/x')
      if (glob.test(Array(30).fill('a').join('/'))) throw new Error('matched')
      if (!glob.test(Array(29).fill('a').join('/') + '/x')) throw new Error('did not match')
      `,
      5_000,
    )
    expect(elapsed).toBeLessThan(200)
  }, 10_000)

  it('stops testing a path at the first segment that cannot match', async () => {
    // The shape of a hostile manifest entry against an unchanged tree: a wildcard base
    // (so the whole repository is walked), the most alternatives and segments the bounds
    // admit, and segments no real file name satisfies. Over a workshop-sized tree this
    // must cost about what a plain `**/*.md` does, not seconds.
    const elapsed = await timeInWorker(
      `
      const star = '*a'.repeat(12) + '*b'
      const pattern = '{*a,*b}{*c,*d}/**/' + Array(15).fill(star).join('/**/')
      const glob = compileGlob(pattern)
      const names = ['pages', 'labs', 'S05-pod', 'day-1', 'components', 'public', 'img']
      let matched = 0
      for (let file = 0; file < 9000; file += 1) {
        const depth = 2 + (file % 4)
        const dirs = Array.from({ length: depth }, (_, level) => names[(file + level) % names.length])
        if (glob.test(dirs.join('/') + '/file-' + file + '-kubernetes-networking-and-service-diagram.md')) matched += 1
      }
      if (matched !== 0) throw new Error('matched ' + matched)
      `,
      20_000,
    )
    expect(elapsed).toBeLessThan(300)
  }, 30_000)

  it('refuses a glob whose alternatives add up to more than the expanded-bytes limit', () => {
    const star = `${'*a'.repeat(12)}*b`
    const pattern = `{a,b}{a,b}{a,b}/**/${Array(15).fill(star).join('/**/')}`
    expect(new TextEncoder().encode(pattern).length).toBeLessThanOrEqual(MAX_GLOB_BYTES)
    expect(() => compileGlob(pattern)).toThrow(`more than ${MAX_GLOB_EXPANDED_BYTES}`)
  })
})

/** The glob semantics written as plainly as possible — exponential, fine for tiny inputs. */
function referenceMatch(pattern: readonly string[], path: readonly string[]): boolean {
  const [segment, ...rest] = pattern
  const [name, ...below] = path
  if (segment === undefined) return name === undefined
  if (segment === '**') {
    return (
      referenceMatch(rest, path) ||
      (name !== undefined && !name.startsWith('.') && referenceMatch(pattern, below))
    )
  }
  return name !== undefined && referenceSegment(segment, name) && referenceMatch(rest, below)
}

function referenceSegment(pattern: string, name: string): boolean {
  if (/^[*?]/.test(pattern) && name.startsWith('.')) return false
  const from = (p: number, n: number): boolean => {
    if (p === pattern.length) return n === name.length
    const token = pattern.charAt(p)
    if (token === '*') return from(p + 1, n) || (n < name.length && from(p, n + 1))
    return n < name.length && (token === '?' || token === name.charAt(n)) && from(p + 1, n + 1)
  }
  return from(0, 0)
}

/** Every plain pattern a `{a,b}` glob stands for, by the most literal reading of braces. */
function referenceExpand(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  const commas: number[] = []
  let close = -1
  for (let index = open; index < pattern.length && close < 0; index += 1) {
    const character = pattern.charAt(index)
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) close = index
    } else if (character === ',' && depth === 1) commas.push(index)
  }
  const bounds = [open, ...commas, close]
  const rest = referenceExpand(pattern.slice(close + 1))
  return bounds.slice(1).flatMap((end, index) => {
    const alternative = pattern.slice((bounds[index] as number) + 1, end)
    return referenceExpand(alternative).flatMap((head) =>
      rest.map((tail) => pattern.slice(0, open) + head + tail),
    )
  })
}

/** mulberry32: a 32-bit PRNG on integer arithmetic, so it cannot lose precision. */
function prng(seed: number): (below: number) => number {
  let state = seed >>> 0
  return (below) => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) % below
  }
}

describe('compileGlob agrees with the reference semantics', () => {
  it('on thousands of distinct generated globs, braces included, and paths', () => {
    const random = prng(20260910)
    const word = (alphabet: string, max: number) => {
      let out = ''
      const length = 1 + random(max)
      for (let index = 0; index < length; index += 1) {
        out += alphabet.charAt(random(alphabet.length))
      }
      return out
    }
    const segment = (): string => {
      const kind = random(10)
      if (kind === 0) return '**'
      if (kind === 1) return `${word('ab*?', 2)}{${word('ab*?', 2)},${word('ab*?.', 2)}}`
      if (kind === 2) return `{${word('ab*?', 3)},${word('ab', 1)}/${word('ab*?', 2)}}`
      return word('ab*?.', 3)
    }
    const valid = (plain: string) =>
      plain.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    const cases = new Set<string>()
    const mismatches: string[] = []
    let matched = 0
    let braced = 0
    let starred = 0
    for (let round = 0; round < 10000; round += 1) {
      const pattern = Array.from({ length: 1 + random(3) }, segment).join('/')
      const path = Array.from({ length: 1 + random(3) }, () => word('aab.', 3)).join('/')
      const alternatives = referenceExpand(pattern)
      if (!alternatives.every(valid) || !valid(path)) continue
      cases.add(`${pattern} vs ${path}`)
      if (pattern.includes('{')) braced += 1
      if (/(^|\/)[^/]*[*?][^/]*(\/|$)/.test(pattern.replaceAll('**', ''))) starred += 1
      const expected = alternatives.some((plain) =>
        referenceMatch(plain.split('/'), path.split('/')),
      )
      if (expected) matched += 1
      if (compileGlob(pattern).test(path) !== expected) {
        mismatches.push(`${pattern} vs ${path}: expected ${expected}`)
      }
    }
    expect(mismatches).toEqual([])
    // A generator that collapses to a handful of cases proves nothing: pin its spread.
    expect(cases.size).toBeGreaterThan(6000)
    expect(braced).toBeGreaterThan(2000)
    expect(starred).toBeGreaterThan(4000)
    expect(matched).toBeGreaterThan(400)
  })

  it('expands braces in the reference the way the README describes them', () => {
    expect(referenceExpand('{a,{b,c}}.md')).toEqual(['a.md', 'b.md', 'c.md'])
    expect(referenceExpand('x{1,2}y{a,b}')).toEqual(['x1ya', 'x1yb', 'x2ya', 'x2yb'])
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
