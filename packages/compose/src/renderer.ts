/**
 * A model of the consumer's markdown renderer, used only to **add** URL tokens.
 *
 * It is not the barrier. The barrier is the coarse layer in `coarse.ts`, which holds for
 * any renderer. Three review rounds showed why: every plugin that splits text tokens
 * (footnotes, KaTeX) or trims them differently (U+FEFF) opened a new way to make a live
 * link, and a model can only ever be as complete as the last plugin someone read. This
 * model exists so that whatever it *does* know about is counted exactly as the renderer
 * spells it (normalized `href`s), on top of the coarse rule.
 *
 * ## What is modelled
 *
 * `@slidev/cli` 52.19's slide renderer (`node/vite/markdown.ts`, `node/syntax/index.ts`):
 * `html: true, xhtmlOut: true, linkify: true` and Slidev's quotes, plus the two always-on
 * or content-enabled plugins that change where text tokens split —
 * `markdown-it-footnote` 4.0.0 (always on) and Slidev's KaTeX `math_inline` rule (enabled
 * whenever a deck uses `$…$`, so a translation can turn it on), vendored below. The
 * engine is markdown-it 14.3.0; Slidev 52 renders through markdown-exit, its port, which
 * the differential test holds to the same invariant.
 *
 * Not modelled (the README lists them): Shiki/code-block plugins (no prose links),
 * `MarkdownItLink` (rewrites existing links, creates none), task lists, GitHub alerts,
 * v-drag, slot sugar, scoped styles, MDC/Comark (opt-in), and speaker notes, which Slidev
 * renders separately with markdown-exit 1.1.0-beta.2 and `linkify` off.
 */

import MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import footnote from 'markdown-it-footnote'

/**
 * Slidev's KaTeX `math_inline` rule, transcribed from `@slidev/cli` 52.19
 * (`node/syntax/katex.ts`, itself derived from markdown-it-katex; both MIT). Only the
 * tokenizing half: what matters here is that `$…$` becomes its own token and so splits
 * the text around it, not what KaTeX draws.
 */
function isValidDelim(state: StateInline, pos: number): { canOpen: boolean; canClose: boolean } {
  const max = state.posMax
  const previous = pos > 0 ? state.src.charCodeAt(pos - 1) : -1
  const next = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1
  let canOpen = true
  let canClose = true
  if (previous === 0x20 || previous === 0x09 || (next >= 0x30 && next <= 0x39)) canClose = false
  if (next === 0x20 || next === 0x09) canOpen = false
  return { canOpen, canClose }
}

export function mathInline(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== '$') return false
  if (!isValidDelim(state, state.pos).canOpen) {
    if (!silent) state.pending += '$'
    state.pos += 1
    return true
  }
  const start = state.pos + 1
  let match = start
  for (;;) {
    match = state.src.indexOf('$', match)
    if (match === -1) break
    let pos = match - 1
    while (state.src[pos] === '\\') pos -= 1
    if ((match - pos) % 2 === 1) break
    match += 1
  }
  if (match === -1) {
    if (!silent) state.pending += '$'
    state.pos = start
    return true
  }
  if (match - start === 0) {
    if (!silent) state.pending += '$$'
    state.pos = start + 1
    return true
  }
  if (!isValidDelim(state, match).canClose) {
    if (!silent) state.pending += '$'
    state.pos = start
    return true
  }
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.markup = '$'
    token.content = state.src.slice(start, match)
  }
  state.pos = match + 1
  return true
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: true, xhtmlOut: true, linkify: true, quotes: `""''` })
  md.use(footnote)
  md.inline.ruler.after('escape', 'math_inline', mathInline)
  return md
}

const RENDERER = createRenderer()

function collect(tokens: readonly Token[], found: string[]): void {
  for (const token of tokens) {
    const attribute =
      token.type === 'link_open' ? 'href' : token.type === 'image' ? 'src' : undefined
    const value = attribute === undefined ? null : token.attrGet(attribute)
    if (value !== null) found.push(value)
    if (token.children !== null) collect(token.children, found)
  }
}

/**
 * The `href` of every link and the `src` of every image the modelled renderer creates
 * from `text`, parsed both as inline content (the unit's real context) and as a block
 * (so footnote definitions and the footnote section are seen too). The text is trimmed
 * first, exactly as the renderer's paragraph and heading rules trim it: an untrimmed
 * U+FEFF reads as a letter to linkify-it and changes what it links.
 *
 * Callers must bound the length: markdown-it is superlinear on some crafted inputs.
 */
export function rendererLinks(text: string): readonly string[] {
  const trimmed = text.trim()
  const inline: string[] = []
  const block: string[] = []
  collect(RENDERER.parseInline(trimmed, {}), inline)
  collect(RENDERER.parse(trimmed, {}), block)
  // Each link as often as the parse that saw it most often: the union of the two reads
  // as a multiset, so a duplicated link still counts as an addition.
  const count = (list: readonly string[], href: string): number =>
    list.filter((item) => item === href).length
  const found: string[] = []
  for (const href of new Set([...inline, ...block])) {
    const times = Math.max(count(inline, href), count(block, href))
    for (let index = 0; index < times; index += 1) found.push(href)
  }
  return found
}
