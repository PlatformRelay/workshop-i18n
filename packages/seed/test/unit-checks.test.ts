import { describe, expect, it } from 'vitest'
import { DEFAULT_SEED_LIMITS } from '../src/types.js'
import { checkTranslation } from '../src/unit-checks.js'

const check = (source: string, translation: string) =>
  checkTranslation(source, translation, DEFAULT_SEED_LIMITS)

describe('checkTranslation', () => {
  it('accepts an ordinary translation with no warnings', () => {
    expect(check('A **Pod** is small.', 'Um **Pod** é pequeno.')).toEqual({
      miss: undefined,
      warnings: [],
    })
  })

  it('refuses a translation identical to its source: nothing was translated', () => {
    expect(check('kubectl get pods', 'kubectl get pods').miss).toBe('identical-to-source')
  })

  it('refuses an empty translation', () => {
    expect(check('Hello', '').miss).toBe('empty-translation')
  })

  it.each([
    ['a tag the English does not have', 'Run it.', 'Execute <b>isso</b>.'],
    ['a script element', 'Run it.', 'Execute <script>alert(1)</script>.'],
    ['a Vue component', 'Run it.', 'Execute <KwCard heading="x" />.'],
    ['mustache interpolation', 'Run it.', 'Execute {{ secret }}.'],
    ['an HTML comment', 'Run it.', 'Execute <!-- x --> isso.'],
    ['a tag in a different case', 'Use <code>x</code>.', 'Use <SCRIPT>x</SCRIPT>.'],
    [
      'an attribute injected into a tag the English has',
      'Use <code>x</code>.',
      'Use <code onclick="alert(1)">x</code>.',
    ],
    ['a Vue directive on a tag the English has', 'A <span>b</span>', 'A <span v-html="x">b</span>'],
    ['a different mustache expression', 'Hi {{ name }}.', 'Oi {{ secret() }}.'],
    [
      'a javascript: link target',
      'See [docs](https://k8s.io).',
      'Veja [docs](javascript:alert(1)).',
    ],
    ['a data: link target', 'See [docs](https://k8s.io).', 'Veja [docs]( DATA:text/html,x ).'],
    ['an autolink with a script scheme', 'See the docs.', 'Veja <javascript:alert(1)>.'],
  ])('refuses %s', (_label, source, translation) => {
    expect(check(source, translation).miss).toBe('markup-divergence')
  })

  it('accepts markup that the English already carries', () => {
    expect(
      check('Use <code>kubectl</code> and {{ name }}.', 'Use <code>kubectl</code> e {{ name }}.')
        .miss,
    ).toBeUndefined()
  })

  it('does not mistake a comparison for a tag', () => {
    expect(check('Keep a < b and b > c.', 'Mantenha a < b e b > c.').miss).toBeUndefined()
  })

  it('accepts a tag the English has, respelled only in whitespace', () => {
    expect(
      check('Set <span class="kw">x</span>.', 'Defina <span  class="kw">x</span>.').miss,
    ).toBeUndefined()
  })

  it('refuses more mustache openings than the English has', () => {
    expect(check('Hi {{ a }}.', 'Oi {{ a }} {{ b }}.').miss).toBe('markup-divergence')
  })

  it('refuses a translation implausibly longer than its source', () => {
    expect(check('Hi', 'x'.repeat(DEFAULT_SEED_LIMITS.lengthSlack + 13)).miss).toBe(
      'length-divergence',
    )
  })

  it('warns, without refusing, when inline code spans differ', () => {
    expect(check('Run `kubectl get pods` now.', 'Execute kubectl get pods agora.')).toEqual({
      miss: undefined,
      warnings: ['code-span-divergence'],
    })
  })

  it('warns, without refusing, when link targets differ', () => {
    expect(
      check('See [docs](https://k8s.io/docs).', 'Veja a [doc](https://k8s.io/pt-br/docs).'),
    ).toEqual({ miss: undefined, warnings: ['link-divergence'] })
  })

  it('treats code spans as a multiset, not a sequence', () => {
    expect(check('`a` then `b`', 'primeiro `b` depois `a`').warnings).toEqual([])
  })
})
