/**
 * The manifest's path globs, matched without a dependency — and without a regex.
 *
 * Supported syntax, and nothing else: `*` (any run inside one path segment), `?` (one
 * character inside a segment), `**` as a whole segment (zero or more segments), and
 * `{a,b}` alternatives, which may nest. Every other character is literal — including `[`
 * and `]`, which are legal in file names and rare enough in globs that a character class
 * is not worth the ambiguity. Like most shells, **a wildcard never matches a leading
 * `.`**: `labs/**\/*.md` does not reach into `labs/.cache/`. Name a dot-path literally
 * (`.github/*.md`, or `{.github,docs}/*.md`) to include it.
 *
 * ## Why not a regular expression
 *
 * The manifest and the tree both arrive through pull requests, and SECURITY.md scopes
 * denial of service in. Compiled to a backtracking `RegExp`, `*a*a*a*a*a*a*a*a*b` against
 * one 60-character file name takes minutes. So braces are expanded up front (capped at
 * {@link MAX_GLOB_ALTERNATIVES}), a segment is matched by the greedy two-pointer
 * wildcard algorithm — `O(pattern × name)` worst case, no backtracking explosion — and
 * `**` by a dynamic-programming table over segments, `O(pattern segments × path
 * segments)`.
 */

/** Most alternatives one glob may expand to; `{a,b}{a,b}…` is exponential otherwise. */
export const MAX_GLOB_ALTERNATIVES = 64

/** A glob the matcher refuses: unbalanced braces, an explosion, a `.` segment. */
export class GlobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlobError'
  }
}

/** A compiled glob. */
export interface Glob {
  readonly pattern: string
  /**
   * The directories the glob can only match beneath — one per brace alternative, sorted
   * and deduplicated. Walking from these instead of the root keeps `pages/**` out of
   * `node_modules`.
   */
  readonly bases: readonly string[]
  test(path: string): boolean
}

/** Expand `{…}` groups, nested or not, into plain patterns. */
function expandBraces(pattern: string): readonly string[] {
  let index = 0
  const unbalanced = () => new GlobError(`${JSON.stringify(pattern)} has an unbalanced "{" or "}"`)
  const cap = (results: readonly string[]) => {
    if (results.length > MAX_GLOB_ALTERNATIVES) {
      throw new GlobError(
        `${JSON.stringify(pattern)} expands to more than ${MAX_GLOB_ALTERNATIVES} alternatives`,
      )
    }
    return results
  }

  const sequence = (nested: boolean): string[] => {
    let results = ['']
    while (index < pattern.length) {
      const character = pattern.charAt(index)
      if (character === '{') {
        index += 1
        const alternatives = group()
        results = cap(
          results.flatMap((prefix) => alternatives.map((alt) => prefix + alt)),
        ) as string[]
        continue
      }
      if (nested && (character === ',' || character === '}')) return results
      if (character === '}') throw unbalanced()
      results = results.map((prefix) => prefix + character)
      index += 1
    }
    if (nested) throw unbalanced()
    return results
  }

  const group = (): string[] => {
    const alternatives: string[] = []
    for (;;) {
      alternatives.push(...sequence(true))
      cap(alternatives)
      const close = pattern.charAt(index)
      index += 1
      if (close === '}') return alternatives
    }
  }

  return sequence(false)
}

/** Match one segment against `*`/`?` wildcards: greedy two-pointer, no backtracking blowup. */
function matchSegment(pattern: string, name: string): boolean {
  const first = pattern.charAt(0)
  if ((first === '*' || first === '?') && name.startsWith('.')) return false
  let p = 0
  let n = 0
  let star = -1
  let resume = 0
  while (n < name.length) {
    const token = pattern.charAt(p)
    if (p < pattern.length && token === '*') {
      star = p
      resume = n
      p += 1
    } else if (p < pattern.length && (token === '?' || token === name.charAt(n))) {
      p += 1
      n += 1
    } else if (star >= 0) {
      p = star + 1
      resume += 1
      n = resume
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern.charAt(p) === '*') p += 1
  return p === pattern.length
}

/** Match segment lists, `**` included, with a table instead of recursion. */
function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const width = path.length + 1
  // can[i * width + j]: pattern[i..] matches path[j..]
  const can = new Uint8Array((pattern.length + 1) * width)
  can[pattern.length * width + path.length] = 1
  for (let i = pattern.length - 1; i >= 0; i -= 1) {
    const segment = pattern[i] as string
    for (let j = path.length; j >= 0; j -= 1) {
      const name = path[j]
      let result: number
      if (segment === '**') {
        const skip = can[(i + 1) * width + j] ?? 0
        const consume =
          name !== undefined && !name.startsWith('.') ? (can[i * width + j + 1] ?? 0) : 0
        result = skip | consume
      } else {
        result =
          name !== undefined && matchSegment(segment, name)
            ? (can[(i + 1) * width + j + 1] ?? 0)
            : 0
      }
      can[i * width + j] = result
    }
  }
  return can[0] === 1
}

function hasWildcard(segment: string): boolean {
  return segment.includes('*') || segment.includes('?')
}

/**
 * Compile a manifest glob.
 *
 * @throws {GlobError} for unbalanced braces, more than {@link MAX_GLOB_ALTERNATIVES}
 *   alternatives, an empty or `.` segment (a walked path never contains one, so such a
 *   glob could only ever match nothing), or a `..` segment spelled through braces.
 */
export function compileGlob(pattern: string): Glob {
  const alternatives = expandBraces(pattern).map((alternative) => {
    const segments = alternative.split('/')
    for (const segment of segments) {
      if (segment === '.' || segment === '') {
        throw new GlobError(
          `${JSON.stringify(pattern)} has an empty or "." segment; write paths relative to the repository root without "./" or "//"`,
        )
      }
      // Core refuses a literal `..` segment; a brace alternative can still spell one.
      if (segment === '..') {
        throw new GlobError(`${JSON.stringify(pattern)} escapes the repository with ".."`)
      }
    }
    const base: string[] = []
    for (const segment of segments.slice(0, -1)) {
      if (hasWildcard(segment)) break
      base.push(segment)
    }
    return { segments, base: base.join('/') }
  })
  const bases = [...new Set(alternatives.map((alternative) => alternative.base))].sort()
  return {
    pattern,
    bases,
    test(path: string): boolean {
      const segments = path.split('/')
      return alternatives.some((alternative) => matchSegments(alternative.segments, segments))
    },
  }
}
