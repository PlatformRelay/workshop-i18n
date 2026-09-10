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

  it('warns when a bare URL the linkifier turns into a link is retargeted', () => {
    expect(
      check('Read https://kubernetes.io/docs/home first.', 'Leia https://evil.example/pt/x antes.'),
    ).toEqual({ miss: undefined, warnings: ['link-divergence'] })
  })

  it('warns, without refusing, when link targets differ', () => {
    expect(check('See [docs](https://k8s.io/docs).', 'Veja a [doc](https://k8s.io/ptbr).')).toEqual(
      { miss: undefined, warnings: ['link-divergence'] },
    )
  })

  it('treats code spans as a multiset, not a sequence', () => {
    expect(check('`a` then `b`', 'primeiro `b` depois `a`').warnings).toEqual([])
  })

  describe('a construct that eats the opening backtick, so no code span opens', () => {
    // markdown-it gives the first backtick to the construct before it, so the text the
    // scanner thinks is a code span is live prose — each with a markup-free English and
    // with an English that carries `{{ x }}` inside a real code span.
    const eaters = [
      ['a link destination', '[docs](/a`)'],
      ['a link title', '[a](/b "`")'],
      ['a reference label', '[a][`]'],
      ['a footnote label', '[^`]'],
      ['an image alt text', '![a`](a.png)'],
      ['a bare URL', 'https://kubernetes.io/`'],
      ['an autolink', '<https://kubernetes.io/`>'],
      ['a processing instruction', '<? ` ?>'],
      ['a declaration', '<!X `>'],
      ['a CDATA section', '<![CDATA[`]]>'],
      ['an attribute value', '<kbd title="`">Enter</kbd>'],
      ['inline math', '$`$'],
    ]
    it.each(eaters)('refuses a references-spelled interpolation after %s', (_label, eater) => {
      expect(
        check('Use helm now.', `Use ${eater} &#123;&#123; $slidev.nav.next() &#125;&#125; \`.`)
          .miss,
      ).toBe('markup-divergence')
    })
    it.each(eaters)(
      'refuses an English code-span interpolation moved live after %s',
      (_label, eater) => {
        expect(check('Render `{{ x }}` here.', `Renderize ${eater} {{ x }} \` aqui.`).miss).toBe(
          'markup-divergence',
        )
      },
    )
  })

  it('refuses a bare opener moved out of an English code span into live prose', () => {
    // Complete interpolations and whole-unit counts agree; only the live-opener guard sees it.
    expect(check('Type `{{` to start.', 'Digite {{ para começar.').miss).toBe('markup-divergence')
  })

  it.each([
    ['a processing instruction', '<?x onclick?>'],
    ['a declaration', '<!X onclick>'],
    ['a CDATA section', '<![CDATA[x]]>'],
    ['an upper-case spelling of an English tag (Vue reads it as a component)', '<KBD>Enter</KBD>'],
  ])('refuses %s the English does not have', (_label, markup) => {
    expect(
      check('Press <kbd>Enter</kbd> now.', `Pressione <kbd>Enter</kbd> ${markup} agora.`).miss,
    ).toBe('markup-divergence')
  })

  it.each([
    ['a slot marker', 'Pressione\n::right::\ntexto'],
    ['a slot marker with spaces', 'Pressione\n  :: right ::  \ntexto'],
    ['a slide separator', 'Pressione\n---\ntexto'],
    ['a fence opener', 'Pressione\n```js\nalert(1)'],
    ['a tilde fence opener', 'Pressione\n~~~\nx'],
  ])('refuses a line that is %s, unless the English has it', (_label, translation) => {
    expect(check('Press it\nand see.', translation).miss).toBe('markup-divergence')
  })

  it.each([
    ['a zero-width space', 0x200b],
    ['a soft hyphen', 0xad],
    ['a byte-order mark', 0xfeff],
    ['a word joiner', 0x2060],
    ['a right-to-left override', 0x202e],
    ['a left-to-right isolate', 0x2066],
  ])('refuses %s the English does not have', (_label, code) => {
    const hidden = String.fromCodePoint(code)
    expect(check('See https://k8s.io now.', `Veja https://k8s.io${hidden}/x agora.`).miss).toBe(
      'markup-divergence',
    )
    expect(check(`See k8s${hidden}io now.`, `Veja k8s${hidden}io agora.`).miss).toBeUndefined()
  })

  it('refuses a format character spelled as a character reference', () => {
    expect(check('Run {x} now.', 'Execute {&#8203;{ x }} agora.').miss).toBe('markup-divergence')
    expect(check('Run x now.', 'Execute x&shy;y agora.').miss).toBe('markup-divergence')
  })

  it.each([
    ['a reference definition', 'Veja [x][r].\n\n[r]: javascript:alert(1)'],
    ['a character-reference spelling', 'Veja [x](java&#115;cript:alert(1)).'],
    ['a mixed-case scheme', 'Veja [x](JaVaScRiPt:alert(1)).'],
    ['a data URL', 'Veja ![x](data:text/html,x).'],
  ])('refuses an active link scheme in %s', (_label, translation) => {
    expect(check('See [x](https://k8s.io).', translation).miss).toBe('markup-divergence')
  })

  describe('Slidev syntax that runs or reads files', () => {
    const english = 'Kubernetes schedules Pods onto Nodes.'
    it.each([
      [
        'a snippet import with a hook',
        'O Kubernetes agenda Pods.\n<<< @/probe.json json {1}{onVnodeMounted: () => $slidev.nav.go(9)}',
      ],
      [
        'a snippet import into a writable Monaco editor',
        'O Kubernetes agenda Pods.\n<<< @/probe.json json {monaco-write}',
      ],
      ['a snippet import of a local file', 'O Kubernetes agenda Pods.\n<<< @/.env txt'],
      ['an indented snippet import', 'O Kubernetes agenda Pods.\n   <<< @/.env'],
      [
        'a KaTeX block with options',
        'O Kubernetes agenda Pods.\n$$ {1}{onVnodeMounted: () => $slidev.nav.go(3)}\nx\n$$',
      ],
      ['a bare KaTeX block', 'O Kubernetes agenda Pods.\n$$\nx\n$$'],
      ['inline math, which alone switches KaTeX on', 'O Kubernetes agenda $x$ Pods.'],
      ['a single dollar sign', 'O Kubernetes custa $5.'],
      ['a dollar sign spelled as a reference', 'O Kubernetes custa &#36;5.'],
      ['an MDC attribute block', 'O Kubernetes agenda [Pods]{onclick="x"}.'],
      ['a brace spelled with a backslash escape', 'O Kubernetes \\{agenda\\} Pods.'],
      ['one more brace than the English', 'O Kubernetes agenda Pods {'],
    ])('refuses %s', (_label, translation) => {
      expect(check(english, translation).miss).toBe('markup-divergence')
    })

    it('accepts dollars and braces the English already carries, in any order', () => {
      expect(
        check('Set ${VAR} and {a} costs $5.', 'Defina {a} e ${VAR}, custa $5.').miss,
      ).toBeUndefined()
    })

    it('accepts a snippet line the English carries identically, and no other', () => {
      expect(check('See:\n<<< @/a.json json', 'Veja:\n<<< @/a.json json').miss).toBeUndefined()
      expect(check('See:\n<<< @/a.json json', 'Veja:\n<<< @/b.json json').miss).toBe(
        'markup-divergence',
      )
    })
  })

  it.each([
    ['a combining grapheme joiner', 0x034f],
    ['a variation selector', 0xfe0f],
    ['a supplementary variation selector', 0xe0100],
    ['a Hangul filler', 0x3164],
    ['a Hangul choseong filler', 0x115f],
    ['a Hangul jungseong filler', 0x1160],
    ['a halfwidth Hangul filler', 0xffa0],
  ])('refuses %s, an invisible that is not Cf, unless the English has it', (_label, code) => {
    const hidden = String.fromCodePoint(code)
    expect(check('See the docs now.', `Veja a doc${hidden} agora.`).miss).toBe('markup-divergence')
    expect(check(`See ${hidden} now.`, `Veja ${hidden} agora.`).miss).toBeUndefined()
  })

  // Each of these kills a mutation that survived review.
  it('refuses a tag inside a code span when the English has none anywhere (whole-unit rule)', () => {
    expect(check('Use the tool.', 'Use a ferramenta `<b onclick=x>`.').miss).toBe(
      'markup-divergence',
    )
  })

  it('refuses a "<" + non-letter pair the English does not have (two-character rule)', () => {
    expect(check('Run the template.', 'Rode o template <% x %>.').miss).toBe('markup-divergence')
  })

  it('compares tag names case-sensitively, even as a straight replacement', () => {
    expect(check('Press <kbd>Enter</kbd>', 'Pressione <KBD>Enter</KBD>').miss).toBe(
      'markup-divergence',
    )
  })

  describe('braces and dollars an English code span carries do not fund live prose', () => {
    const english =
      'Print names with `kubectl get pods -o jsonpath={.items[*].metadata.name}` today.'
    it.each([
      ['an MDC attribute block', 'Imprima nomes com **kubectl**{onclick="alert(1)"} hoje.'],
      [
        'an MDC attribute block, with the code span kept',
        'Imprima `kubectl get pods -o jsonpath=` com **kubectl**{onclick="alert(1)"} hoje.',
      ],
    ])('refuses %s', (_label, translation) => {
      expect(check(english, translation).miss).toBe('markup-divergence')
    })

    it('refuses inline math funded by dollars inside an English code span', () => {
      expect(check('Run `echo $A $B` now.', 'Rode $x$ agora.').miss).toBe('markup-divergence')
    })

    it('still accepts the code span translated in place', () => {
      expect(
        check(
          english,
          'Imprima nomes com `kubectl get pods -o jsonpath={.items[*].metadata.name}` hoje.',
        ).miss,
      ).toBeUndefined()
    })
  })

  describe('rules that are the only guard once the English funds the character budget', () => {
    // Each English below funds every budgeted character its translation uses — including
    // the `=`, `>` and line breaks — so the budget passes and only the named rule refuses.
    // Each was shown red with that rule disabled.
    it('the `$$` line rule refuses a funded KaTeX block', () => {
      expect(
        check(
          'Costs $1, $2, $3 and $4 using {a} and {b} (x => y)\nper\nnode.',
          'Custa:\n$$ {1}{onVnodeMounted: () => x}\nx\n$$',
        ).miss,
      ).toBe('markup-divergence')
    })

    it('the image-count rule refuses a reference link flipped into an image', () => {
      expect(
        check('See ![a](./a.png) and [b][r] now.', 'Veja ![a](./a.png) e ![b][r] agora.').miss,
      ).toBe('markup-divergence')
    })

    it('the reference-definition line rule refuses a funded definition', () => {
      expect(
        check(
          'See [x][r] and [y] at https://kubernetes.io\nfor\nmore.',
          'Veja [x][r] e mais.\n\n[r]: https://evil.example',
        ).miss,
      ).toBe('markup-divergence')
    })
  })

  describe('images, which the build turns into imports', () => {
    it.each([
      ['a local file read as raw text', 'Veja ![x](./.env?raw) agora.'],
      ['a JSON file', 'Veja ![x](./probe.json) agora.'],
      ['a reference-style image', 'Veja ![x][r] agora.\n\n[r]: ./.env?raw'],
      ['a remote image', 'Veja ![x](https://tracker.example/p.png) agora.'],
      ['an image spelled with an escaped bang', 'Veja \\![x](./.env?raw) agora.'],
    ])('refuses %s', (_label, translation) => {
      expect(check('See the docs now.', translation).miss).toBe('markup-divergence')
    })

    it('refuses a link the English has, flipped into an image', () => {
      expect(check('See [docs](./a.png).', 'Veja ![docs](./a.png).').miss).toBe('markup-divergence')
    })

    it('refuses an English image retargeted at another file', () => {
      expect(
        check('See the ![diagram](./diagram.png) below.', 'Veja o ![diagrama](./.env?raw) abaixo.')
          .miss,
      ).toBe('markup-divergence')
    })

    it('accepts an image the English already has', () => {
      expect(
        check('See ![diagram](./a.png) here.', 'Veja ![diagrama](./a.png) aqui.').miss,
      ).toBeUndefined()
    })

    it('refuses an added reference definition line', () => {
      expect(check('See [x][r] now.', 'Veja [x][r] agora.\n\n[r]: https://evil.example').miss).toBe(
        'markup-divergence',
      )
    })
  })

  describe('MDC lines, in every spelling the MDC block rule accepts', () => {
    it.each([
      ['a spaced block component', 'Veja isto.\n:: Toc\n::'],
      ['a lower-case block component', 'Veja isto.\n:: toc\n::'],
      ['a widely spaced block component', 'Veja isto.\n::   Toc\n::'],
      ['an indented block component', 'Veja isto.\n  :: Toc\n::'],
      ['a three-colon block component', 'Veja isto.\n:::Toc\n:::'],
      ['a four-colon block component', 'Veja isto.\n::::Toc\n::::'],
      ['the `:1` shorthand that crashes the build', 'Veja isto.\n:1 texto'],
      ['a bare colon line', 'Veja isto.\n: texto'],
    ])('refuses %s', (_label, translation) => {
      // The English funds the line breaks, so the budget passes and the line rule decides.
      expect(check('See\nthis\nnow\nplease.', translation).miss).toBe('markup-divergence')
    })

    it.each([
      ['a digit', 'O Kubernetes agenda :1 Pods.'],
      ['a dollar name', 'O Kubernetes agenda :$x Pods.'],
      ['a dash name', 'O Kubernetes agenda :-x Pods.'],
      ['an underscore name', 'O Kubernetes agenda :_x Pods.'],
    ])('refuses an inline MDC name starting with %s', (_label, translation) => {
      expect(check('Kubernetes schedules $x - and _y Pods.', translation).miss).toBe(
        'markup-divergence',
      )
    })

    it('accepts a colon line the English has identically', () => {
      expect(check('See:\n::right::\nthis', 'Veja:\n::right::\nisto').miss).toBeUndefined()
    })
  })

  describe('braceless MDC components', () => {
    it.each([
      ['an inline component', 'O Kubernetes agenda :Toc Pods.'],
      ['an inline component at line start', 'O Kubernetes agenda\n:Toc Pods.'],
      ['an inline component inside emphasis', 'O Kubernetes agenda *:Toc* Pods.'],
      ['an inline component inside strong emphasis', 'O Kubernetes agenda __:Toc__ Pods.'],
      ['an inline component inside a link text', 'O Kubernetes agenda [:Toc](x) Pods.'],
      ['a bound MDC prop', 'O Kubernetes :href="x" agenda.'],
      ['a block component', 'O Kubernetes agenda Pods.\n\n::Toc\n::'],
    ])('refuses %s', (_label, translation) => {
      expect(check('Kubernetes schedules Pods.', translation).miss).toBe('markup-divergence')
    })

    it.each([
      ['a label colon', 'Note: this matters.', 'Nota: isso importa.'],
      ['a clock time', 'Meet at 10:30 today.', 'Encontro às 10:30 hoje.'],
      ['a URL', 'See https://k8s.io now.', 'Veja https://k8s.io agora.'],
      ['an emoji shortcode the English has', 'Ship it :rocket: now.', 'Entregue :rocket: agora.'],
    ])('accepts %s', (_label, english, translation) => {
      expect(check(english, translation).miss).toBeUndefined()
    })
  })

  describe('the character budget', () => {
    it('lets a translation add letters, digits, marks, spaces and prose punctuation freely', () => {
      expect(
        check(
          'Run it.',
          'Rode-o já (agora): 100% «sério», “sim” — ‘não’… ¿quê? ¡olé! \'a\' "b"; ok, fim.',
        ).miss,
      ).toBeUndefined()
      expect(check('Run it.', `Rode${String.fromCodePoint(0xa0)}isso.`).miss).toBeUndefined()
    })

    it.each([
      ['an asterisk', 'Rode *isso*.'],
      ['an underscore', 'Rode _isso_.'],
      ['a hash', 'Rode #isso.'],
      ['a pipe', 'Rode | isso.'],
      ['an at sign', 'Rode @isso.'],
      ['a slash', 'Rode e/ou isso.'],
      ['a backslash', 'Rode \\ isso.'],
      ['an ampersand', 'Rode &amp; isso.'],
      ['a caret', 'Rode ^isso.'],
      ['an equals sign', 'Rode = isso.'],
      ['a plus sign', 'Rode + isso.'],
      ['a tilde', 'Rode ~isso.'],
      ['a backtick', 'Rode `isso`.'],
      ['a bracket', 'Rode [isso].'],
      ['an emoji', `Rode isso ${String.fromCodePoint(0x1f680)}.`],
      ['a tab', 'Rode\tisso.'],
      ['an em space', `Rode${String.fromCodePoint(0x2003)}isso.`],
      ['an asterisk spelled as a reference', 'Rode &#42;isso&#42;.'],
    ])('refuses %s the English does not have', (_label, translation) => {
      expect(check('Run it.', translation).miss).toBe('markup-divergence')
    })

    it('accepts budgeted characters the English carries, as a multiset', () => {
      expect(check('Run *it* / now.', 'Rode / *isso* agora.').miss).toBeUndefined()
      expect(check('Run *it* now.', 'Rode *isso* e *aquilo*.').miss).toBe('markup-divergence')
    })

    it('treats a line break before a letter as a re-wrap, and any other added break as budgeted', () => {
      expect(check('Run it now and see.', 'Rode isso agora\ne veja.').miss).toBeUndefined()
      expect(check('Run it now and see.', 'Rode isso agora\n   e veja.').miss).toBeUndefined()
      for (const next of ['- item', '1. item', ':: x', '-- ', '(a)', '**b**']) {
        expect(check('Run it now and see.', `Rode isso agora\n${next}`).miss).toBe(
          'markup-divergence',
        )
      }
    })
  })

  describe('fences opened after a container marker', () => {
    it.each([
      ['a PlantUML fence in a list item', '- Veja\n- ```plantuml\n@startuml'],
      ['a Mermaid fence in a blockquote', 'Veja\n> ```mermaid\ngraph TD'],
      ['a twoslash tilde fence in a list item', 'Veja\n- ~~~ts twoslash\nconst x = 1'],
      ['a fence run mid-line', 'Veja ```plantuml agora'],
      [
        'a list-item unit that is itself a fence opener',
        '```plantuml\n@startuml\nBob -> Alice\n@enduml',
      ],
      ['a blockquote unit that is itself a fence opener', '```mermaid\ngraph TD\nA ==> B'],
    ])('refuses %s', (_label, translation) => {
      expect(check('- See\n- the docs', translation).miss).toBe('markup-divergence')
    })

    it('refuses a fence run even when the English funds every backtick in code spans', () => {
      expect(check('Use `a` `b` and `c`.', 'Use ``` mermaid.').miss).toBe('markup-divergence')
    })
  })

  it('does not mistake the Portuguese word "Data:" for a data URL', () => {
    expect(check('Date: 2026-09-10', 'Data: 2026-09-10').miss).toBeUndefined()
  })

  it('does not mistake a less-than number for a tag', () => {
    expect(check('Takes <5 min.', 'Leva <5 min, no máximo.').miss).toBeUndefined()
  })

  it('stays fast on hostile backtick and brace runs', () => {
    const limits = { ...DEFAULT_SEED_LIMITS, lengthRatio: 100 }
    const started = performance.now()
    checkTranslation('`'.repeat(8000), `x${'`'.repeat(8000)}`, limits)
    checkTranslation('{{'.repeat(8000), `x${'{{'.repeat(8000)}`, limits)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
