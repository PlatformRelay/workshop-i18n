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
 *   renderers' trimming and word rules.
 *
 * None of this asks what a renderer *would* do. It over-reports on purpose — a false
 * positive is a marked English fallback a reviewer can see — and it is measured: see
 * the README for the rejection rate on the real pt-BR corpus.
 *
 * Digits-only decimals (`1.5`, `10.0.0.1`) are exempt from the host rule, so decimal
 * commas and points never trip it; a bare IP is still caught by the linkify passes.
 */

/** Dotted host-like runs, Unicode-aware so IDN hosts count. */
const HOST = /[\p{L}\p{N}\p{M}_-]+(?:\.[\p{L}\p{N}\p{M}_-]+)+/gu
const DECIMAL = /^\d+(?:\.\d+)+$/
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
  const hosts = [...text.matchAll(HOST)]
    .map((match) => match[0])
    .filter((host) => !DECIMAL.test(host))
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
