/**
 * Differential test: the parity gate against the renderers that actually draw the deck.
 *
 * The invariant is one-directional — every link the consumer's renderer creates from a
 * translation must be counted as a `url` token by the gate. Over-reporting is fine (a
 * false positive is an English fallback); under-reporting is a live link nobody reviewed.
 *
 * Two renderers, both configured the way `@slidev/cli` 52.19 configures its own
 * (`html: true, xhtmlOut: true, linkify: true`, Slidev's quotes; no plugin in its default
 * set creates links — `MarkdownItLink` only rewrites existing ones):
 *
 * - **markdown-exit** 1.0.0-beta.9 — the engine `unplugin-vue-markdown` 32 renders Slidev
 *   decks with today, pinned to the version the consumer's lockfile resolves;
 * - **markdown-it** 14.3.0 — the engine markdown-exit ports, and the one the gate runs.
 *
 * The matrix crosses every link-shaped form with every inline context that changes how a
 * renderer tokenizes it, plus the re-review's bypass list verbatim.
 */

import { createMarkdownExit } from 'markdown-exit'
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { markupTokens } from '../src/markup.js'

const SLIDEV_OPTIONS = { html: true, xhtmlOut: true, linkify: true, quotes: `""''` } as const

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

const RENDERERS: readonly (readonly [string, (text: string) => readonly string[]])[] = [
  [
    'markdown-exit 1.0.0-beta.9',
    (text) => {
      const md = createMarkdownExit(SLIDEV_OPTIONS)
      return hrefs(md.parse(text, {}) as unknown as LinkToken[])
    },
  ],
  [
    'markdown-it 14.3.0',
    (text) => hrefs(new MarkdownIt(SLIDEV_OPTIONS).parse(text, {}) as unknown as LinkToken[]),
  ],
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
  ['autolink', (form) => `<${form}>`],
  ['inside a code span', (form) => `\`${form}\``],
  ['after a tag', (form) => `<b>${form}</b>`],
  ['glued to text', (form) => `siehe:${form}`],
  ['line break', (form) => `eins\n${form}`],
]

/** The re-review's bypass list, verbatim, as extra fixtures. */
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
]

const INPUTS: readonly string[] = [
  ...FORMS.flatMap((form) => CONTEXTS.map(([, wrap]) => `Siehe ${wrap(form)} hier`)),
  ...REVIEW_BYPASSES,
]

describe.each(RENDERERS)('every link %s creates is a url token', (_name, render) => {
  it('holds over the whole form × context matrix and the review bypass list', () => {
    const escaped: string[] = []
    let linked = 0
    for (const input of INPUTS) {
      const links = render(input)
      linked += links.length
      const counted = new Set(
        markupTokens(input)
          .filter((token) => token.kind === 'url')
          .map((token) => token.text),
      )
      for (const link of links) if (!counted.has(link)) escaped.push(`${input} -> ${link}`)
    }
    expect(escaped).toEqual([])
    // Guard against a vacuous pass: the renderer must actually link most of the matrix,
    // and every review bypass that names a real domain.
    expect(linked).toBeGreaterThan(INPUTS.length / 2)
    const bypassesLinked = REVIEW_BYPASSES.filter((input) => render(input).length > 0)
    expect(bypassesLinked).toHaveLength(REVIEW_BYPASSES.length - 2)
  })
})
