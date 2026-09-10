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

  it('scales the cap with a long English unit', () => {
    const english = 'word '.repeat(MAX_SCANNED_LENGTH / 4)
    expect(checkMarkupParity(english, `${english}!`).ok).toBe(true)
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
