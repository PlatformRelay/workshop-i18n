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

  // markdown-it decodes character references and backslash escapes into literal text,
  // and Vue then compiles a literal `{{ }}` in that text as a live expression.
  it.each([
    [
      'decimal character references',
      "Um Pod &#123;&#123; constructor.constructor('alert(document.domain)')() &#125;&#125;",
    ],
    ['hex character references', 'Um Pod &#x7B;&#x7b; x &#x7D;&#x7d;'],
    ['named character references', 'Um Pod &lcub;&lcub; x &rcub;&rcub;'],
    ['backslash escapes', 'Um Pod \\{\\{ x \\}\\}'],
    ['a mix of spellings', 'Um Pod {&lbrace; x }&#125;'],
  ])('refuses an interpolation spelled with %s', (_label, translation) => {
    expect(check('A Pod.', translation).miss).toBe('markup-divergence')
  })

  it.each([
    ['an unknown named reference', 'Um Pod&bogus;.'],
    ['a numeric reference for a bracket', 'Um &#x3C;b&#62; Pod.'],
    ['an upper-case named reference for a bracket', 'Um &LT;b&GT; Pod.'],
  ])('refuses %s the English does not use', (_label, translation) => {
    expect(check('A Pod.', translation).miss).toBe('markup-divergence')
  })

  it('accepts a reference for a harmless character, like &amp; for a bare ampersand', () => {
    expect(check('Scaling & labelling', 'Escala &amp; labels').miss).toBeUndefined()
    expect(check('A Pod.', 'Um &#80;od&nbsp;aqui.').miss).toBeUndefined()
  })

  it('accepts character references the English already uses', () => {
    expect(
      check('Use <code>web-0.web.&lt;ns&gt;</code>.', 'Use <code>web-0.web.&lt;ns&gt;</code>!')
        .miss,
    ).toBeUndefined()
  })

  it('refuses an interpolation moved out of a code span, where Slidev escapes it, into live prose', () => {
    expect(check('Write `{{ x }}` in the template.', 'Escreva {{ x }} no template.').miss).toBe(
      'markup-divergence',
    )
  })

  it('refuses a tag moved out of a code span into live prose', () => {
    expect(check('Never write `<script>` here.', 'Nunca escreva <script> aqui.').miss).toBe(
      'markup-divergence',
    )
  })

  it.each([
    ['a backslash escape', 'Avoid \\<b>here</b>.', 'Evite <b>aqui</b>.'],
    ['character references', 'Avoid &lt;b&gt;.', 'Evite <b>.'],
  ])(
    'refuses a live tag where the English only wrote one as text, with %s',
    (_label, source, translation) => {
      expect(check(source, translation).miss).toBe('markup-divergence')
    },
  )

  it('refuses a tag hidden in what only looks like a code span', () => {
    // The first backtick belongs to the tag's attribute, so the renderer never opens a
    // code span there, and the script is live.
    expect(
      check(
        'See `<script>` in <a href="x">docs</a>.',
        "Veja <a title='`'>x</a> <script>alert(1)</script> `.",
      ).miss,
    ).toBe('markup-divergence')
  })

  it('accepts an interpolation that stays inside a code span', () => {
    expect(check('Write `{{ x }}` here.', 'Escreva `{{ x }}` aqui.').miss).toBeUndefined()
  })

  it('refuses an unclosed opener: an interpolation split across two units', () => {
    // No complete `{{ … }}` in either string, so only the opener count can see it.
    expect(check('Start here.', 'Comece {{ constructor.constructor(').miss).toBe(
      'markup-divergence',
    )
  })

  it('compares tags as a multiset: one more copy of an English tag is refused', () => {
    expect(check('One <br> break.', 'Uma <br> quebra <br>.').miss).toBe('markup-divergence')
  })

  it('compares interpolations as a multiset', () => {
    expect(check('{{ a }} and {{ b }} {{ b }}', '{{ a }} e {{ a }} {{ b }}').miss).toBe(
      'markup-divergence',
    )
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

  it('stays fast on hostile backtick and brace runs', () => {
    const limits = { ...DEFAULT_SEED_LIMITS, lengthRatio: 100 }
    const started = performance.now()
    checkTranslation('`'.repeat(8000), `x${'`'.repeat(8000)}`, limits)
    checkTranslation('{{'.repeat(8000), `x${'{{'.repeat(8000)}`, limits)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
