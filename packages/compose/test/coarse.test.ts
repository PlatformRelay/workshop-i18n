/**
 * The coarse, renderer-independent layer of markup parity (re-review 2, N1–N6, N8).
 *
 * Three rounds of chasing renderer fidelity showed that modelling the renderer cannot be
 * the barrier: every plugin that splits text tokens (footnotes, KaTeX) or trims them
 * differently (U+FEFF) opened a new way to create a live link. So the barrier is now a
 * rule that holds for *any* markdown renderer — a translation may not introduce a
 * link-shaped or syntax-shaped sequence the English unit lacks — and the renderer model
 * only ever adds tokens on top.
 */

import { describe, expect, it } from 'vitest'
import { checkMarkupParity, MAX_SCANNED_LENGTH, markupTokens } from '../src/markup.js'

function addedKinds(english: string, translation: string): readonly string[] {
  const result = checkMarkupParity(english, translation)
  return [...new Set(result.added.map((token) => token.kind))].sort()
}

describe('the re-review payloads, verbatim, are rejected', () => {
  it.each([
    ['footnote-wrapped email', 'Zweite Folie ^[admin@evil.com]'],
    ['domain before an inline footnote', 'Siehe www.evil.com^[x]y'],
    ['domain before inline math', 'zwei www.evil.com$x]$ zwei'],
    ['email after inline math', 'Zweite $x]$admin@evil.com'],
    ['footnote reference soup', 'Siehe [^1www.evil.com^[x]].'],
    ['footnote definition', '[^1]:evil.com'],
    ['trailing byte-order mark', 'Siehe evil.com\u{feff}'],
  ])('%s', (_label, translation) => {
    expect(checkMarkupParity('See the second slide', translation).ok).toBe(false)
  })
})

describe('link-shaped sequences a translation may not introduce', () => {
  it.each([
    ['a dotted host', 'Siehe evil.dev bitte'],
    ['an IDN host', 'Siehe пример.рф'],
    ['a punycode host', 'Siehe xn--e1afmkfd.xn--p1ai'],
    ['an @ next to a word (email, mention)', 'Frag @someone'],
    ['a scheme separator', 'Nimm foo://bar'],
    ['mailto:', 'Schreib an mailto:x'],
    ['a GitHub issue reference (labs render on GitHub)', 'Siehe #123'],
    ['a shortcut reference label', 'Siehe [admin]'],
  ])('%s', (_label, translation) => {
    expect(addedKinds('See the docs', translation)).toContain('linklike')
  })

  it('lets through a host the English already has, unchanged', () => {
    expect(
      checkMarkupParity(
        'Apply pod.yaml from k8s.io, ask help@k8s.io.',
        'Aplique pod.yaml de k8s.io, pergunte a help@k8s.io.',
      ).ok,
    ).toBe(true)
  })

  it('is judged one way: dropping an English e.g., #1 or dotted identifier is fine', () => {
    // The shapes the real pt-BR corpus drops (see markup.ts, INTRODUCTION_ONLY_KINDS).
    expect(
      checkMarkupParity(
        'Pick one, e.g. the first (#1) — see spec.suspend and $HOME.',
        'Escolha um, por exemplo o primeiro — veja a suspensão e a pasta pessoal.',
      ),
    ).toEqual({ ok: true, added: [], removed: [] })
  })

  it('exempts digits-only decimals, so a decimal comma or point is free', () => {
    expect(checkMarkupParity('It takes 1.5 seconds', 'Leva 1,5 segundos ou 1.5').ok).toBe(true)
  })

  it('does not treat translated inline-link text as a reference label', () => {
    expect(
      checkMarkupParity(
        'Read [the docs](https://k8s.io).',
        'Leia [a documentação](https://k8s.io).',
      ).ok,
    ).toBe(true)
    expect(checkMarkupParity('Read [the docs][ref].', 'Leia [a documentação][ref].').ok).toBe(true)
  })
})

describe('hosts spelled with symbols, emoji or non-ASCII dots (re-review 4, P1/P3)', () => {
  it.each([
    ['an emoji host', 'Veja 😈.ws agora'],
    ['a snowman host', 'Veja ☃.com agora'],
    ['a command-key host', 'Veja ⌘.io agora'],
    ['an emoji host glued to a code span the English shares', 'Veja 😈.ws`kubectl get pods` agora'],
    ['a fullwidth dot', 'Veja evil．com agora'],
    ['an ideographic full stop', 'Veja evil。com agora'],
    ['a halfwidth ideographic full stop', 'Veja evil｡com agora'],
  ])('%s is link-shaped', (_label, translation) => {
    expect(addedKinds('See `kubectl get pods` now', translation)).toContain('linklike')
  })
})

/**
 * Slidev block syntax that reads files or switches renderers, reached from a prose hole
 * (re-review 4, P0): a real `slidev build` of a strictly composed deck with a translated
 * line `<<< @/.env txt` published the `.env` secret into `dist/assets`. The payload
 * transforms and the variants below are the reviewer's, verbatim.
 */
describe('structural lines a translation may not introduce', () => {
  const english = 'A Pod runs containers and the kubelet restarts them.'
  it.each([
    ['env braceless', (s: string) => `${s}\n<<< @/.env txt`],
    ['env no lang', (s: string) => `${s}\n<<< @/.env`],
    [
      'mid-paragraph',
      (s: string) => {
        const words = s.split(' ')
        return `${words[0]}\n<<< @/.env txt\n${words.slice(1).join(' ')}`
      },
    ],
    ['indented', (s: string) => `${s}\n   <<< @/.env txt`],
    ['CR', (s: string) => `${s}\r<<< @/.env txt`],
    ['CRLF', (s: string) => `${s}\r\n<<< @/.env txt`],
    ['relative', (s: string) => `${s}\n<<< ../package.json`],
    ['katex braceless', (s: string) => `${s}\n$$\nx\n$$`],
    ['tab-indented', (s: string) => `${s}\n\t<<< @/.env`],
    ['first line', (s: string) => `<<< @/.env txt\n${s}`],
    ['slot marker', (s: string) => `${s}\n::right::`],
    ['slide separator', (s: string) => `${s}\n---`],
    ['backtick fence opener', (s: string) => `${s}\n\`\`\`ts`],
    ['tilde fence opener', (s: string) => `${s}\n~~~`],
  ])('%s', (_label, make) => {
    const result = checkMarkupParity(english, make(english))
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.kind)).toContain('structural')
  })

  it('lets through a structural line the English unit already has, unchanged', () => {
    expect(
      checkMarkupParity(
        'See below\n<<< @/snippets/pod.yaml',
        'Veja abaixo\n<<< @/snippets/pod.yaml',
      ).ok,
    ).toBe(true)
  })

  it('does not trip on prose that merely contains the characters mid-line', () => {
    expect(checkMarkupParity('a << b', 'a << b e $$ custa')).toMatchObject({
      added: expect.not.arrayContaining([expect.objectContaining({ kind: 'structural' })]),
    })
  })
})

/**
 * The per-character budget (re-review 4, coordinator refinement): every character a
 * translation adds that is not letters, marks, digits, ordinary spaces or prose
 * punctuation is budgeted against the English unit's count. This subsumes the image `![`,
 * container-fence, MDC-attribute-brace and fence-run findings — each is kept as its own
 * test below, but the mechanism is one rule.
 */
describe('the per-character budget on non-prose characters', () => {
  it.each([
    ['a markdown image (asset import)', '![x](./.env?raw)'],
    ['a reference-style image', '![x][r]'],
    ['a link-to-image flip on an English target', '![docs](./probe.json)'],
    ['a container-prefixed fence', '- ```mermaid'],
    ['a blockquote-prefixed fence', '> ```plantuml'],
    ['an unclosed tilde fence after a list marker', '- ~~~ts twoslash'],
    ['an MDC attribute brace funded from an English code span', '**kubectl**{onclick="x"}'],
    ['a bare backtick run', 'veja ``` agora'],
    ['an added angle bracket', 'veja < agora'],
    ['an added pipe', 'a | b'],
    ['an added backslash', 'a \\ b'],
  ])('refuses %s', (_label, translation) => {
    // English carries the same code span (`jsonpath={.items[*]}`) and target, so the
    // funding attack — spending English's braces or backticks on prose — cannot work.
    const english = 'See `jsonpath={.items[*]}` and [docs](./probe.json)'
    expect(addedKinds(english, `${english} ${translation}`)).toContain('budget')
  })

  it('lets a translation spend letters, digits and prose punctuation freely', () => {
    expect(
      checkMarkupParity(
        'A Pod runs — see the guide (chapter 2): 100% ready.',
        'Ein Pod läuft — siehe den Leitfaden (Kapitel 2): 100% bereit… „wirklich“? Ja!',
      ).ok,
    ).toBe(false) // the German low quote „ is budgeted; see the README's monitored set
    expect(
      checkMarkupParity(
        'A Pod runs — see the guide (chapter 2): 100% ready.',
        'Ein Pod läuft — siehe den Leitfaden (Kapitel 2): 100% bereit, wirklich? Ja!',
      ),
    ).toEqual({ ok: true, added: [], removed: [] })
  })

  it('reports a non-printing budgeted character by code point', () => {
    const result = checkMarkupParity('Deploy it', 'Implante\u{2028}isso')
    expect(result.added.map((token) => token.text)).toContain('U+2028')
  })
})

describe('inline MDC components a translation may not introduce', () => {
  it.each([
    ['a bare component', 'veja :Toc hier'],
    ['a component after emphasis', 'veja *:Alert*'],
    ['a component after a bracket', 'veja [:Button]'],
  ])('refuses %s', (_label, translation) => {
    expect(addedKinds('See the docs', translation)).toContain('mdc')
  })

  it('does not trip on a prose colon followed by a space or a digit', () => {
    expect(checkMarkupParity('Timeout', 'Tempo limite: 5 segundos, veja: aqui').ok).toBe(true)
  })
})

describe('syntax sequences a translation may not introduce', () => {
  it.each([
    ['inline math', 'Das kostet $x$'],
    ['an inline footnote', 'Siehe ^[Anmerkung]'],
    ['a footnote reference', 'Siehe [^1]'],
    ['a definition colon', 'eins ]: zwei'],
  ])('%s', (_label, translation) => {
    expect(addedKinds('See the docs', translation)).toContain('syntax')
  })

  it('lets through syntax the English already carries', () => {
    expect(checkMarkupParity('Costs $5 and $6', 'Custa $5 e $6').ok).toBe(true)
  })
})

describe('Unicode format characters', () => {
  it.each([
    ['zero-width space', '\u{200b}'],
    ['zero-width joiner outside an emoji the English has', '\u{200d}'],
    ['left-to-right mark', '\u{200e}'],
    ['right-to-left override', '\u{202e}'],
    ['word joiner', '\u{2060}'],
    ['byte-order mark', '\u{feff}'],
    ['soft hyphen', '\u{ad}'],
  ])('refuses a %s the English lacks', (_label, character) => {
    expect(addedKinds('Deploy it', `Implante${character} isso`)).toContain('format')
  })

  it('keeps a format character the English carries, as in an emoji sequence', () => {
    const technologist = '\u{1f469}\u{200d}\u{1f4bb}'
    expect(checkMarkupParity(`Hi ${technologist}`, `Oi ${technologist}`).ok).toBe(true)
  })
})

describe('length cap before any parser runs', () => {
  it('refuses a translation over the cap without scanning it', () => {
    const result = checkMarkupParity('Hello', 'a'.repeat(MAX_SCANNED_LENGTH + 1))
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.kind)).toEqual(['oversize'])
  })

  it('never scales the cap past what the renderer model scans (re-review 4, P1)', () => {
    // The cap used to be max(8192, 4 x English), so for English over 2048 characters a
    // translation in (8192, 4 x English] was accepted with the renderer model silently
    // skipped. A barrier must never be skipped silently: over the scan limit is refused.
    const english = `Run \`docker pull nginx@sha256:abcd1234\` now. ${'The kubelet keeps Pods running. '.repeat(80)}`
    const translation = `Veja 😈.ws\`docker pull nginx@sha256:abcd1234\` agora. ${'O kubelet mantém os Pods. '.repeat(340)}`
    expect(english.length).toBeGreaterThan(2048)
    expect(translation.length).toBeGreaterThan(MAX_SCANNED_LENGTH)
    expect(translation.length).toBeLessThanOrEqual(english.length * 4)
    const result = checkMarkupParity(english, translation)
    expect(result.ok).toBe(false)
    expect(result.added.map((token) => token.kind)).toEqual(['oversize'])
  })

  it.each([
    ['scheme runs', 'http://a'.repeat(40_000)],
    ['comment openers', '<!--'.repeat(40_000)],
  ])('stays fast on %s that stalled the renderer pass', (_label, text) => {
    const started = performance.now()
    checkMarkupParity('Hello', text)
    markupTokens(text.slice(0, MAX_SCANNED_LENGTH))
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
