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
 * one 60-character file name takes minutes. So braces are expanded up front, a segment
 * is matched by the greedy two-pointer wildcard algorithm — `O(pattern × name)` worst
 * case, no backtracking explosion — and `**` by a dynamic-programming table over
 * segments, `O(pattern segments × path segments)`.
 *
 * ## Why the glob itself is bounded
 *
 * Not exponential is not the same as cheap. Testing one path costs at most the
 * expanded pattern's bytes times the path's bytes, and every file under a glob's base is
 * tested — so a 1 KB glob of 64 alternatives and 500 `*` segments took `extract` on a
 * real workshop from under a second to nearly three minutes. A glob is therefore refused
 * past {@link MAX_GLOB_BYTES} as written, {@link MAX_GLOB_ALTERNATIVES} alternatives,
 * {@link MAX_GLOB_EXPANDED_BYTES} expanded or {@link MAX_GLOB_SEGMENTS} segments in any
 * alternative, which keeps a test to a small constant times the path length. The
 * rewrites that cannot change what a glob matches happen first, so they never count
 * against a limit: identical alternatives are merged and a run of `**` segments is one
 * `**`. The limits are generous: the longest glob in the README's example manifest is
 * 19 bytes.
 */

/** Most alternatives one glob may expand to; `{a,b}{a,b}…` is exponential otherwise. */
export const MAX_GLOB_ALTERNATIVES = 64

/** Longest glob accepted, in UTF-8 bytes as written in the manifest. */
export const MAX_GLOB_BYTES = 512

/** Most bytes all of a glob's alternatives may add up to once its braces are expanded. */
export const MAX_GLOB_EXPANDED_BYTES = 2048

/** Most `/`-separated segments one alternative may have, after `**` runs are collapsed. */
export const MAX_GLOB_SEGMENTS = 32

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

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/** `values` without repeats, first occurrence kept. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Expand `{…}` groups, nested or not, into distinct plain patterns. */
function expandBraces(pattern: string): readonly string[] {
  let index = 0
  const unbalanced = () => new GlobError(`${JSON.stringify(pattern)} has an unbalanced "{" or "}"`)
  const cap = (results: string[]): string[] => {
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
        results = cap(unique(results.flatMap((prefix) => alternatives.map((alt) => prefix + alt))))
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
    let alternatives: string[] = []
    for (;;) {
      alternatives = cap(unique([...alternatives, ...sequence(true)]))
      const close = pattern.charAt(index)
      index += 1
      if (close === '}') return alternatives
    }
  }

  return sequence(false)
}

/** Whether `literal` (`?` matching any one character) matches `name` at `offset`. */
function matchesAt(literal: string, name: string, offset: number): boolean {
  for (let index = 0; index < literal.length; index += 1) {
    const token = literal.charAt(index)
    if (token !== '?' && token !== name.charAt(offset + index)) return false
  }
  return true
}

/**
 * Match one segment against `*`/`?` wildcards. The text before the first `*` and after
 * the last one can only match the name's two ends, so they are checked first, in time
 * linear in their length — which rejects nearly every name a hostile segment is tried
 * against. What lies between the outer stars goes to the greedy two-pointer: no
 * backtracking blowup.
 */
function matchSegment(pattern: string, name: string): boolean {
  const first = pattern.charAt(0)
  if ((first === '*' || first === '?') && name.startsWith('.')) return false
  const firstStar = pattern.indexOf('*')
  if (firstStar < 0) return pattern.length === name.length && matchesAt(pattern, name, 0)
  const lastStar = pattern.lastIndexOf('*')
  const head = pattern.slice(0, firstStar)
  const tail = pattern.slice(lastStar + 1)
  if (head.length + tail.length > name.length) return false
  if (!matchesAt(head, name, 0) || !matchesAt(tail, name, name.length - tail.length)) {
    return false
  }
  // `inner` is matched against `middle` with a star on either side of it.
  const inner = pattern.slice(firstStar + 1, lastStar)
  const middle = name.slice(head.length, name.length - tail.length)
  let p = 0
  let n = 0
  let star = -1 // the outer leading star
  let resume = 0
  while (p < inner.length) {
    const token = inner.charAt(p)
    if (token === '*') {
      star = p
      resume = n
      p += 1
    } else if (n < middle.length && (token === '?' || token === middle.charAt(n))) {
      p += 1
      n += 1
    } else if (resume < middle.length) {
      p = star + 1
      resume += 1
      n = resume
    } else {
      return false
    }
  }
  // Everything in `inner` matched; the outer trailing star takes the rest of `middle`.
  return true
}

/**
 * Match segment lists, `**` included: a memoised walk from the first segment, so a path
 * is abandoned at the first segment that cannot match, and no (segment, name) pair is
 * ever tried twice.
 */
function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const width = path.length + 1
  // known[i * width + j]: 0 = not asked yet, 1 = pattern[i..] matches path[j..], 2 = not
  const known = new Uint8Array((pattern.length + 1) * width)
  const from = (i: number, j: number): boolean => {
    const segment = pattern[i]
    if (segment === undefined) return j === path.length
    const cell = i * width + j
    const answer = known[cell]
    if (answer !== 0) return answer === 1
    const name = path[j]
    const result =
      segment === '**'
        ? from(i + 1, j) || (name !== undefined && !name.startsWith('.') && from(i, j + 1))
        : name !== undefined && matchSegment(segment, name) && from(i + 1, j + 1)
    known[cell] = result ? 1 : 2
    return result
  }
  return from(0, 0)
}

/** `a/**\/**\/b` → `a/**\/b`: consecutive `**` segments match exactly what one does. */
function collapseGlobstars(alternative: string): string {
  const segments = alternative.split('/')
  return segments
    .filter((segment, index) => segment !== '**' || segments[index - 1] !== '**')
    .join('/')
}

function hasWildcard(segment: string): boolean {
  return segment.includes('*') || segment.includes('?')
}

/**
 * Compile a manifest glob.
 *
 * @throws {GlobError} for a glob over any bound ({@link MAX_GLOB_BYTES},
 *   {@link MAX_GLOB_ALTERNATIVES}, {@link MAX_GLOB_EXPANDED_BYTES},
 *   {@link MAX_GLOB_SEGMENTS}), unbalanced braces, an empty or `.` segment (a walked path
 *   never contains one, so such a glob could only ever match nothing), or a `..` segment
 *   spelled through braces.
 */
export function compileGlob(pattern: string): Glob {
  const bytes = utf8Length(pattern)
  if (bytes > MAX_GLOB_BYTES) {
    // Checked before expanding, and the message quotes only the start: the whole point
    // is not to spend work in proportion to a hostile pattern.
    throw new GlobError(
      `${JSON.stringify(`${pattern.slice(0, 40)}…`)} is ${bytes} bytes, longer than ${MAX_GLOB_BYTES} bytes`,
    )
  }
  const expanded = unique(expandBraces(pattern).map(collapseGlobstars))
  const expandedBytes = expanded.reduce((sum, alternative) => sum + utf8Length(alternative), 0)
  if (expandedBytes > MAX_GLOB_EXPANDED_BYTES) {
    throw new GlobError(
      `${JSON.stringify(pattern)} expands to ${expandedBytes} bytes of alternatives, more than ${MAX_GLOB_EXPANDED_BYTES}`,
    )
  }
  const alternatives = expanded.map((alternative) => {
    const segments = alternative.split('/')
    if (segments.length > MAX_GLOB_SEGMENTS) {
      throw new GlobError(
        `${JSON.stringify(pattern)} has an alternative with more than ${MAX_GLOB_SEGMENTS} path segments (${segments.length})`,
      )
    }
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
