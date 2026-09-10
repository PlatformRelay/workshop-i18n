/**
 * The coarse layer of markup parity: renderer-independent, and the actual barrier.
 *
 * A translation may not introduce, beyond what its English unit already carries (as a
 * multiset), any of:
 *
 * - **link-shaped sequences** (`linklike`) — anything *any* linkifier, autolinker or
 *   issue tracker could turn into a link: dotted host-like runs (`evil.com`, `пример.рф`,
 *   `xn--…`, `pod.yaml` alike), an `@` touching a word character (emails, `@user`
 *   mentions), `://`, `mailto:`, a GitHub issue reference (`#123`; labs render on
 *   GitHub, not Slidev), and a bracketed label that is not inline-link text (`[admin]`,
 *   which resolves against any reference definition in the file);
 * - **syntax sequences** (`syntax`) that switch on a parser feature splitting text
 *   tokens: `$` (KaTeX), `^[` and `[^` (footnotes), `]:` (definitions);
 * - **Unicode format characters** (`format`, general category Cf: zero-width and bidi
 *   controls, U+FEFF, U+00AD …) — invisible, and read differently by different
 *   renderers' trimming and word rules;
 * - **structural lines** (`structural`) — a line of the translation that, after its
 *   leading spaces and tabs, starts with Slidev or markdown block syntax: `<<<` (a
 *   snippet import: it *reads a file from the build machine*, and a real `slidev build`
 *   of a `<<< @/.env` line published the secret into `dist/assets`), `$$` (KaTeX block),
 *   `::` (slot marker), `---` (separator), or a fence opener. Lines are split on `\n`,
 *   `\r\n` and `\r`, because a soft line break inside a paragraph is all it takes to
 *   reach the block parser. Compared as whole trimmed lines, so an English unit that
 *   carries such a line may keep it.
 *
 * None of this asks what a renderer *would* do. It over-reports on purpose — a false
 * positive is a marked English fallback a reviewer can see — and it is measured: see
 * the README for the rejection rate on the real pt-BR corpus.
 *
 * A host label is any run of characters that are not whitespace, punctuation, separators
 * or other/control characters, plus `_` and `-`: letters and digits in any script, but
 * also symbols and emoji, because IDNA maps `😈.ws` to `xn--m28h.ws` and a renderer
 * links it. The dot may be ASCII or fullwidth/ideographic (`．` `。` `｡`), which IDNA also
 * maps to `.`. Digits-only decimals (`1.5`, `10.0.0.1`) are exempt, so decimal commas
 * and points never trip it; a bare IP is still caught by the linkify passes.
 */

const LABEL_CHARACTER = /^(?:[^\s\p{P}\p{Z}\p{C}]|[_-])$/u
const DOTS = new Set(['.', '．', '。', '｡'])
const DECIMAL = /^\d+(?:[.．。｡]\d+)+$/u

/**
 * Dotted host-like runs, in any script, symbols and emoji included: maximal sequences
 * of two or more non-empty labels joined by single dots.
 *
 * A scan, not `/label(?:dot label)+/gu`: with symbols in the label class, a long run of,
 * say, `<` has no dot to stop at, and that regex backtracks quadratically from every
 * position — the linear-time tests caught it the moment the class was widened.
 */
function hostRuns(text: string): readonly string[] {
  const hosts: string[] = []
  let labels: string[] = []
  let dots: string[] = []
  let label = ''
  const flush = (): void => {
    if (label !== '') labels.push(label)
    if (labels.length >= 2) {
      hosts.push(
        labels.map((part, index) => (index === 0 ? part : `${dots[index - 1]}${part}`)).join(''),
      )
    }
    labels = []
    dots = []
    label = ''
  }
  for (const character of text) {
    if (LABEL_CHARACTER.test(character)) {
      label += character
    } else if (DOTS.has(character) && label !== '') {
      labels.push(label)
      dots.push(character)
      label = ''
    } else {
      // Anything else — including a dot with no label before it — ends the run.
      if (label === '' && labels.length > 0) dots.pop()
      flush()
    }
  }
  if (label === '' && labels.length > 0) dots.pop()
  flush()
  return hosts
}
/** Block syntax a line may not start with (after leading spaces and tabs). */
const STRUCTURAL_LINE = /^(?:<<<|\$\$|::|---|`{3,}|~{3,})/
/** An `@` with a word character on at least one side, with the word runs around it. */
const AT = /[\p{L}\p{N}._%+-]*@[\p{L}\p{N}._-]*/gu
const SCHEME = /[\p{L}\p{N}+.-]*:\/\//gu
const MAILTO = /mailto:/giu
/** `#123`, but not the digits of a numeric character reference (`&#123;`). */
const ISSUE = /(?<![\p{L}\p{N}_&])#\d+/gu
/** A bracket group; judged by what follows it (see {@link referenceLabels}). */
const BRACKET = /\[[^[\]\n]*\]/g
const SYNTAX = /\$|\^\[|\[\^|\]:/g
const FORMAT = /\p{Cf}/gu

function referenceLabels(text: string): readonly string[] {
  const labels: string[] = []
  for (const match of text.matchAll(BRACKET)) {
    const next = text.charAt(match.index + match[0].length)
    // `[text](dest)` and `[text][label]`: the first group is link text, which translators
    // must be free to translate; the destination and the second label are compared.
    if (next === '(' || next === '[') continue
    if (match[0].startsWith('[^')) continue // a footnote reference: `syntax` covers it
    labels.push(match[0])
  }
  return labels
}

/** Link-shaped sequences in `text`, in a fixed order. */
export function linkLikeTokens(text: string): readonly string[] {
  const hosts = hostRuns(text).filter((host) => !DECIMAL.test(host))
  const ats = [...text.matchAll(AT)].map((match) => match[0]).filter((run) => run.length > 1)
  return [
    ...hosts,
    ...ats,
    ...(text.match(SCHEME) ?? []),
    ...(text.match(MAILTO) ?? []).map((match) => match.toLowerCase()),
    ...(text.match(ISSUE) ?? []),
    ...referenceLabels(text),
  ]
}

/** Lines of `text` that start with block syntax, trimmed, for whole-line comparison. */
export function structuralTokens(text: string): readonly string[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/^[ \t]+/, '').trimEnd())
    .filter((line) => STRUCTURAL_LINE.test(line))
}

/** Parser-switching syntax sequences in `text`. */
export function syntaxTokens(text: string): readonly string[] {
  return text.match(SYNTAX) ?? []
}

/** Unicode format characters in `text`, spelled as code points so reports are readable. */
export function formatTokens(text: string): readonly string[] {
  return (text.match(FORMAT) ?? []).map(
    (character) =>
      `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
}
