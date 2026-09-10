/**
 * Differential test: the parity gate against the renderers that actually draw the deck.
 *
 * The invariant is one-directional — **a translation from which the consumer's renderer
 * creates a link the English does not have is rejected**, and every such link is counted
 * as a `url` token. Over-reporting is fine (a false positive is an English fallback);
 * under-reporting is a live link nobody reviewed.
 *
 * Two engines, each configured as `@slidev/cli` 52.19 configures its slide renderer
 * (`html`, `xhtmlOut`, `linkify`, Slidev's quotes) with the plugins that change where
 * text tokens split: `markdown-it-footnote` 4.0.0 (always on in Slidev) and Slidev's KaTeX
 * `math_inline` rule (on whenever a deck uses `$…$`):
 *
 * - **markdown-exit** 1.0.0-beta.9 — the engine `unplugin-vue-markdown` 32 renders Slidev
 *   decks with today, pinned to the version the consumer's lockfile resolves. This half
 *   is the independent one; the version pin below keeps it from quietly disappearing.
 * - **markdown-it** 14.3.0 — the engine markdown-exit ports, and the one the gate's own
 *   renderer model runs (so this half is partly circular, and is kept as a tripwire).
 *
 * URL normalization: markdown-it 14.3.0 here resolves `mdurl` 2.1.0, the consumer's tree
 * 2.0.0. Their `lib/` and `index.mjs` are byte-identical (2.1.0 only adds type
 * declarations), so hrefs are normalized the same way on both sides. The invariant
 * compares hrefs *as each engine spells them*, so a future divergence would show up as
 * an escaped link, not a silent pass.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createMarkdownExit } from 'markdown-exit'
import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import { describe, expect, it } from 'vitest'
import { checkMarkupParity, markupTokens } from '../src/markup.js'
import { mathInline } from '../src/renderer.js'

const SLIDEV_OPTIONS = { html: true, xhtmlOut: true, linkify: true, quotes: `""''` } as const
const CONSUMER_ENGINE = 'markdown-exit'
const CONSUMER_ENGINE_VERSION = '1.0.0-beta.9'

interface LinkToken {
  readonly type: string
  readonly attrs: [string, string][] | null
  readonly children: readonly LinkToken[] | null
}

function hrefs(tokens: readonly LinkToken[]): readonly string[] {
  const found: string[] = []
  for (const token of tokens) {
    const name = token.type === 'link_open' ? 'href' : token.type === 'image' ? 'src' : undefined
    const value = name === undefined ? undefined : token.attrs?.find(([key]) => key === name)?.[1]
    if (value !== undefined) found.push(value)
    if (token.children !== null) found.push(...hrefs(token.children))
  }
  return found
}

interface Engine {
  use(plugin: unknown): Engine
  inline: { ruler: { after(name: string, rule: string, fn: unknown): void } }
  parse(text: string, env: object): unknown
}

function slidevLike(engine: Engine): (text: string) => readonly string[] {
  engine.use(footnote)
  engine.inline.ruler.after('escape', 'math_inline', mathInline)
  return (text) => hrefs(engine.parse(text, {}) as LinkToken[])
}

const RENDERERS: readonly (readonly [string, (text: string) => readonly string[]])[] = [
  [
    `${CONSUMER_ENGINE} ${CONSUMER_ENGINE_VERSION}`,
    slidevLike(createMarkdownExit(SLIDEV_OPTIONS) as unknown as Engine),
  ],
  ['markdown-it 14.3.0', slidevLike(new MarkdownIt(SLIDEV_OPTIONS) as unknown as Engine)],
]

const FORMS: readonly string[] = [
  'attacker.io',
  'evil.com/login',
  'admin@evil.com',
  'www.evil.com',
  'https://evil.com/login',
  'http://evil.com',
  'ftp://evil.com/x',
  'mailto:x@evil.com',
  '//evil.com/x',
  'пример.рф',
  'xn--e1afmkfd.xn--p1ai/x',
  'evil.com:8080/a?b=c#d',
  'sub.evil.co.uk',
]

const CONTEXTS: readonly (readonly [string, (form: string) => string])[] = [
  ['plain', (form) => form],
  ['*em*', (form) => `*${form}*`],
  ['_em_', (form) => `_${form}_`],
  ['**strong**', (form) => `**${form}**`],
  ['__strong__', (form) => `__${form}__`],
  ['***x***', (form) => `***${form}***`],
  ['___x___', (form) => `___${form}___`],
  ['*_x_*', (form) => `*_${form}_*`],
  ['_*x*_', (form) => `_*${form}*_`],
  ['~~strike~~', (form) => `~~${form}~~`],
  ['parentheses', (form) => `(${form}).`],
  ['quotes', (form) => `"${form}"`],
  ['trailing punctuation', (form) => `${form}!?`],
  ['backslash-escaped dot', (form) => form.replace('.', '\\.')],
  ['entity dot', (form) => form.replace('.', '&#46;')],
  ['entity at', (form) => form.replace('@', '&#64;')],
  ['inside link text', (form) => `[${form}](https://k8s.io)`],
  ['as link destination', (form) => `[x](${form})`],
  ['image alt and source', (form) => `![${form}](${form})`],
  ['image source', (form) => `![x](https://${form})`],
  ['autolink', (form) => `<${form}>`],
  ['inside a code span', (form) => `\`${form}\``],
  ['after a tag', (form) => `<b>${form}</b>`],
  ['glued to text', (form) => `siehe:${form}`],
  ['line break', (form) => `eins\n${form}`],
  ['inline footnote', (form) => `^[${form}]`],
  ['before an inline footnote', (form) => `${form}^[x]y`],
  ['footnote reference soup', (form) => `[^1${form}^[x]]`],
  ['footnote definition', (form) => `x\n\n[^1]:${form}`],
  ['before inline math', (form) => `${form}$x]$ zwei`],
  ['after inline math', (form) => `$x]$${form}`],
  ['trailing byte-order mark', (form) => `${form}\u{feff}`],
  ['leading byte-order mark', (form) => `\u{feff}${form}`],
]

/** Both re-reviews' bypass lists, verbatim, as extra fixtures. */
const REVIEW_BYPASSES: readonly string[] = [
  '_attacker.io_',
  '__evil.com__',
  '___x___',
  '*_x_*',
  '_admin@evil.com_',
  '~~admin@evil.com~~',
  '~~www.evil.com~~',
  '_www.evil.com_',
  '_https://evil.com/login_',
  '_mailto:x@evil.com_',
  'Zweite _https://evil.com/login_ Folie',
  'Zweite Folie ^[admin@evil.com]',
  'Siehe www.evil.com^[x]y',
  'zwei www.evil.com$x]$ zwei',
  'Zweite $x]$admin@evil.com',
  'Siehe [^1www.evil.com^[x]].',
  '[^1]:evil.com',
  'evil.com\u{feff}',
]

const INPUTS: readonly string[] = [
  ...FORMS.flatMap((form) => CONTEXTS.map(([, wrap]) => `Siehe ${wrap(form)} hier`)),
  ...REVIEW_BYPASSES,
]

const ENGLISH = 'See it here'
const COARSE_KINDS: ReadonlySet<string> = new Set(['linklike', 'syntax', 'format'])

describe('the consumer engine half of the differential', () => {
  it(`runs against ${CONSUMER_ENGINE} at exactly the consumer's version`, () => {
    const require = createRequire(import.meta.url)
    const manifest = JSON.parse(
      readFileSync(require.resolve(`${CONSUMER_ENGINE}/package.json`), 'utf8'),
    ) as { version: string }
    expect(manifest.version).toBe(CONSUMER_ENGINE_VERSION)
    expect(RENDERERS.map(([name]) => name)).toContain(
      `${CONSUMER_ENGINE} ${CONSUMER_ENGINE_VERSION}`,
    )
  })
})

describe.each(RENDERERS)('every link %s creates', (_name, render) => {
  it('is counted as a url token, and trips the coarse layer on its own', () => {
    const escaped: string[] = []
    // Rejected by the coarse layer alone: the renderer model may only ever add tokens, so
    // a translation that creates a link must trip a coarse kind whatever the model says.
    const notCoarse: string[] = []
    let linked = 0
    for (const input of INPUTS) {
      const links = render(input)
      if (links.length === 0) continue
      linked += links.length
      const counted = new Set(
        markupTokens(input)
          .filter((token) => token.kind === 'url')
          .map((token) => token.text),
      )
      for (const link of links) if (!counted.has(link)) escaped.push(`${input} -> ${link}`)
      const { added } = checkMarkupParity(ENGLISH, input)
      if (!added.some((token) => COARSE_KINDS.has(token.kind))) notCoarse.push(input)
    }
    expect(escaped).toEqual([])
    expect(notCoarse).toEqual([])
    // Guard against a vacuous pass: the engine must actually link most of the matrix,
    // and most of the bypass fixtures.
    expect(linked).toBeGreaterThan(INPUTS.length / 2)
    const bypassesLinked = REVIEW_BYPASSES.filter((input) => render(input).length > 0)
    // (A few need context a one-line fixture lacks, e.g. a footnote definition without a
    // reference renders nothing; the coarse layer rejects them regardless.)
    expect(bypassesLinked.length).toBeGreaterThan(REVIEW_BYPASSES.length / 2)
  })
})
