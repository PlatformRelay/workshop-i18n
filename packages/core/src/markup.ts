/**
 * `html` with every `<...>` run removed.
 *
 * A scanner rather than `.replace(/<[^>]*>/g, '')`: the regex is quadratic on a line of
 * `<`s with no `>` (each `<` rescans to the end), and a lone `.replace` is what
 * `js/incomplete-multi-character-sanitization` flags, because `<<script>script>` leaves
 * `<script>` behind. Nothing that calls this renders the result - callers only measure how
 * much text is left - but the scanner is linear and needs no such argument. This is not a
 * sanitiser and must not be used as one.
 */
export function stripTags(html: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const open = html.indexOf('<', at)
    if (open === -1) break
    const close = html.indexOf('>', open + 1)
    if (close === -1) break
    out += html.slice(at, open)
    at = close + 1
  }
  return out + html.slice(at)
}
