/**
 * The manifest's path globs, matched without a dependency.
 *
 * Supported syntax, and nothing else: `*` (any run inside one path segment), `?` (one
 * character inside a segment), `**` as a whole segment (zero or more segments), and
 * `{a,b}` alternatives. Every other character is literal — including `[` and `]`, which
 * are legal in file names and rare enough in globs that a character class is not worth
 * the ambiguity. Like most shells, **a wildcard never matches a leading `.`**: a
 * `labs/**\/*.md` should not reach into `labs/.cache/`. Name a dot-path literally to
 * include it.
 *
 * Patterns are matched against repository-relative POSIX paths of regular files.
 */

const WILDCARD_START = /^[*?{]/

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Convert one non-`**` segment (or brace alternative) to a regex fragment. */
function segmentSource(segment: string): string {
  let out = ''
  let index = 0
  while (index < segment.length) {
    const character = segment.charAt(index)
    if (character === '*') {
      out += '[^/]*'
      index += 1
    } else if (character === '?') {
      out += '[^/]'
      index += 1
    } else if (character === '{') {
      const close = segment.indexOf('}', index)
      if (close < 0) {
        out += escapeLiteral(character)
        index += 1
        continue
      }
      const alternatives = segment.slice(index + 1, close).split(',')
      out += `(?:${alternatives.map(segmentSource).join('|')})`
      index = close + 1
    } else {
      out += escapeLiteral(character)
      index += 1
    }
  }
  return WILDCARD_START.test(segment) ? `(?!\\.)${out}` : out
}

/** Compile a manifest glob to an anchored regular expression. */
export function compileGlob(pattern: string): RegExp {
  const segments = pattern.split('/')
  let source = ''
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      source += last ? '(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*' : '(?:(?!\\.)[^/]+/)*'
      return
    }
    source += segmentSource(segment) + (last ? '' : '/')
  })
  return new RegExp(`^${source}$`)
}

/**
 * The directory a glob can only match beneath: its leading segments that contain no
 * wildcard, excluding the final (file) segment. Walking from here instead of from the
 * repository root is what keeps a `pages/**` manifest from reading `node_modules`.
 */
export function globBase(pattern: string): string {
  const segments = pattern.split('/')
  const literal: string[] = []
  for (const segment of segments.slice(0, -1)) {
    if (/[*?{]/.test(segment)) break
    literal.push(segment)
  }
  return literal.join('/')
}
