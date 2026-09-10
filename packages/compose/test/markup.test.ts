/**
 * Markup and placeholder parity (spec 003 FR-004, SECURITY.md "untrusted input").
 *
 * A translation is hostile input: it arrives from a TMS, a seeding pass, or a parallel-
 * tree contribution nobody wrote against this tool. Every case below is something a
 * translation could smuggle into a deck that Slidev and Vue would then *act on* — a tag,
 * an attribute, an expression, a link target — and each one must be caught.
 */

import { describe, expect, it } from 'vitest'
import { checkMarkupParity, markupTokens } from '../src/markup.js'

describe('markupTokens', () => {
  it('finds inline code spans, including longer backtick runs', () => {
    const tokens = markupTokens('Run `kubectl get pods` and ``a ` b`` now')
    expect(tokens.filter((token) => token.kind === 'code').map((token) => token.text)).toEqual([
      '`kubectl get pods`',
      '``a ` b``',
    ])
  })

  it('finds HTML tags and Vue components with their attributes', () => {
    const tokens = markupTokens('<v-click>Hi <KwCard title="a>b" /></v-click>')
    expect(tokens.filter((token) => token.kind === 'tag').map((token) => token.text)).toEqual([
      '<v-click>',
      '<KwCard title="a>b" />',
      '</v-click>',
    ])
  })

  it('finds mustache expressions', () => {
    const tokens = markupTokens('Value: {{ $slidev.nav.currentPage }} of {{total}}')
    expect(tokens.filter((token) => token.kind === 'mustache').map((token) => token.text)).toEqual([
      '{{ $slidev.nav.currentPage }}',
      '{{total}}',
    ])
  })

  it('finds link and image destinations, autolinks and bare URLs', () => {
    const tokens = markupTokens(
      'See [docs](https://k8s.io/docs "Docs") and ![logo](./img/logo.png), <https://a.example/x> or https://b.example/y.',
    )
    expect(tokens.filter((token) => token.kind === 'url').map((token) => token.text)).toEqual([
      'https://k8s.io/docs',
      './img/logo.png',
      'https://a.example/x',
      'https://k8s.io/docs',
      'https://a.example/x',
      'https://b.example/y',
      // …and then every href/src the renderer itself creates, in document order.
      'https://k8s.io/docs',
      './img/logo.png',
      'https://a.example/x',
      'https://b.example/y',
    ])
  })

  it('finds character references', () => {
    const tokens = markupTokens('a &lt; b &#123; &#x7b;')
    expect(tokens.filter((token) => token.kind === 'entity').map((token) => token.text)).toEqual([
      '&lt;',
      '&#123;',
      '&#x7b;',
    ])
  })

  // A catalog is hostile input, and a gate that goes quadratic on a crafted msgstr is a
  // way to stall every compose and verify run. Each shape below defeated a naive scan.
  it.each([
    [
      'backtick runs of every length',
      Array.from({ length: 600 }, (_, i) => '`'.repeat(i + 1)).join('a'),
    ],
    ['unclosed mustache openers', '{{ '.repeat(70_000)],
    ['link destinations that never end', '](x'.repeat(70_000)],
    ['angle brackets', '<'.repeat(200_000)],
    ['unclosed tags', '<a '.repeat(70_000)],
  ])('stays linear on %s', (_label, text) => {
    const started = performance.now()
    markupTokens(text)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('is empty for plain prose', () => {
    expect(markupTokens('Ein Pod ist die kleinste Einheit — 100 % „sicher“.')).toEqual([])
  })
})

describe('checkMarkupParity', () => {
  const english =
    'Run `kubectl apply -f pod.yaml` in <v-click>the lab</v-click>, see [docs](https://k8s.io).'

  it('accepts a translation that keeps every token, in any order', () => {
    const german =
      'Siehe [Doku](https://k8s.io) und führe <v-click>im Lab</v-click> `kubectl apply -f pod.yaml` aus.'
    expect(checkMarkupParity(english, german)).toEqual({ ok: true, added: [], removed: [] })
  })

  it('rejects an added <script> tag', () => {
    const result = checkMarkupParity(english, `${english} <script>alert(1)</script>`)
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.text)).toEqual(['<script>', '</script>'])
  })

  it('rejects an event handler attribute added to an existing tag', () => {
    const result = checkMarkupParity(
      english,
      english.replace('<v-click>', '<v-click onclick="steal()">'),
    )
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.text)).toEqual(['<v-click onclick="steal()">'])
    expect(result.removed.map((token) => token.text)).toEqual(['<v-click>'])
  })

  it('does not let a quoted ">" hide an attribute after it', () => {
    const source = 'Card <KwCard title="x>y" /> here'
    const hostile = 'Karte <KwCard title="x>y" onmouseover="evil()" /> hier'
    expect(checkMarkupParity(source, hostile).ok).toBe(false)
  })

  it('catches an unterminated tag the renderer would still open', () => {
    expect(checkMarkupParity('plain', 'schlicht <img src=x onerror=alert(1)').ok).toBe(false)
  })

  it('catches tags regardless of case', () => {
    expect(checkMarkupParity('plain', 'schlicht <SCRIPT>x</SCRIPT>').ok).toBe(false)
  })

  it('catches a tag hidden inside what only looks like a code span', () => {
    // `\`` is an escaped backtick: no code span opens, and the tag is live HTML.
    expect(checkMarkupParity('plain', 'schlicht \\`<script>x</script>\\`').ok).toBe(false)
  })

  it('rejects a new mustache expression, which Vue would evaluate', () => {
    const result = checkMarkupParity('Hello', 'Hallo {{ constructor.constructor("x")() }}')
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.kind)).toEqual(['mustache'])
  })

  // The next two assert the *kind*, not just the verdict: the brace and entity kinds
  // would reject these too, and a test that any one defense satisfies proves none of them.
  it('reads mustache spelled with backslash escapes as mustache, which markdown unescapes', () => {
    const result = checkMarkupParity('Hello', 'Hallo \\{\\{ evil() \\}\\}')
    expect(result.ok).toBe(false)
    expect(result.added).toContainEqual({ kind: 'mustache', text: '{{ evil() }}' })
  })

  it('reads mustache spelled with character references as mustache', () => {
    const result = checkMarkupParity('Hello', 'Hallo &#123;&#123; evil() &#125;&#x7D;')
    expect(result.ok).toBe(false)
    expect(result.added).toContainEqual({ kind: 'mustache', text: '{{ evil() }}' })
  })

  it('reads a tag spelled with named references as a tag', () => {
    const result = checkMarkupParity('Hello', 'Hallo &lt;img src=x onerror=alert(1)&gt;')
    expect(result.added).toContainEqual({ kind: 'tag', text: '<img src=x onerror=alert(1)>' })
  })

  it('rejects an unbalanced mustache delimiter, which breaks the Vue compile', () => {
    expect(checkMarkupParity('Hello', 'Hallo {{ offen').ok).toBe(false)
  })

  it('rejects a changed link destination', () => {
    const result = checkMarkupParity(
      english,
      english.replace('https://k8s.io', 'https://evil.example'),
    )
    expect(result.ok).toBe(false)
    expect(result.removed.map((token) => token.text)).toContain('https://k8s.io')
  })

  it('rejects a javascript: link a translation introduces', () => {
    expect(checkMarkupParity('Click here', 'Klick [hier](javascript:alert(1))').ok).toBe(false)
  })

  it('rejects a changed image source', () => {
    expect(checkMarkupParity('![a](./a.png)', '![b](https://tracker.example/p.png)').ok).toBe(false)
  })

  it('rejects a dropped or altered inline code span', () => {
    expect(checkMarkupParity('Run `kubectl get pods`', 'Führe kubectl get pods aus').ok).toBe(false)
    expect(checkMarkupParity('Run `kubectl get pods`', 'Führe `kubectl get pod` aus').ok).toBe(
      false,
    )
  })

  it('rejects an attribute block a markdown extension would apply', () => {
    expect(checkMarkupParity('[x](./a)', '[x](./a){onclick="evil()"}').ok).toBe(false)
  })

  // Slidev renders with markdown-it `linkify: true`, and linkify-it links schemeless
  // domains and email addresses too ("fuzzy" links). Each of these became a live link.
  it.each([
    ['a bare domain', 'Mehr unter attacker.io'],
    ['a domain with a path', 'Melde dich an: evil.com/login'],
    ['a bare email address', 'Schreib an admin@evil.com'],
    ['an IDN domain', 'Siehe пример.рф'],
    ['a punycode domain', 'Siehe xn--e1afmkfd.xn--p1ai/x'],
    ['a domain in parentheses before punctuation', 'Siehe (evil.com).'],
    ['a bare IP address', 'Öffne 10.0.0.1/admin'],
  ])('rejects %s a linkifier would turn into a live link', (_label, translation) => {
    const result = checkMarkupParity('See the docs', translation)
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.kind)).toContain('url')
  })

  // The re-review's bypass list, verbatim: markdown-it linkifies each text token *after*
  // emphasis and strikethrough delimiters are split off, while linkify-it run over the
  // whole string will not start a match right after `_ * ~`. Each rendered as a live link.
  it.each([
    '_attacker.io_',
    '__evil.com__',
    '___attacker.io___',
    '*_attacker.io_*',
    '_admin@evil.com_',
    '~~admin@evil.com~~',
    '~~www.evil.com~~',
    '_www.evil.com_',
    '_https://evil.com/login_',
    '_mailto:x@evil.com_',
  ])('rejects %s, which the renderer links inside emphasis', (payload) => {
    const result = checkMarkupParity('See the docs', `Siehe ${payload} hier`)
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.kind)).toContain('url')
  })

  it('also links schemeless domains on the extra TLDs a consumer may enable', () => {
    // Not linked by the default renderer: this pins the deliberate over-report.
    expect(markupTokens('Siehe evil.dev')).toContainEqual({ kind: 'url', text: 'evil.dev' })
  })

  it('reads a domain whose dot is backslash-escaped as a domain', () => {
    // markdown-it 14 keeps `\.` as a separate token and does not link it; a renderer that
    // joins text before linkifying would. Scanning the unescaped text covers both.
    expect(markupTokens('Siehe evil\\.com')).toContainEqual({ kind: 'url', text: 'evil.com' })
  })

  it('accepts a schemeless domain the English already links, unchanged', () => {
    expect(
      checkMarkupParity(
        'Docs live at k8s.io, questions to help@k8s.io.',
        'Die Doku liegt auf k8s.io, Fragen an help@k8s.io.',
      ),
    ).toEqual({ ok: true, added: [], removed: [] })
  })

  it('rejects a changed schemeless domain', () => {
    const result = checkMarkupParity('Docs at k8s.io', 'Doku auf k8s.io.evil.com')
    expect(result.ok).toBe(false)
  })

  it('compares multisets: duplicating a token the English has once is an addition', () => {
    const result = checkMarkupParity('Page {{ a }}', 'Seite {{ a }} und {{ a }}')
    expect(result.ok).toBe(false)
    expect(result.added).toEqual([{ kind: 'mustache', text: '{{ a }}' }])
    expect(result.removed).toEqual([])
  })

  it('ignores a trailing sentence period on a bare URL', () => {
    expect(
      checkMarkupParity('See https://k8s.io/docs.', 'Unter https://k8s.io/docs findest du mehr').ok,
    ).toBe(true)
  })
})
