import { describe, expect, it } from 'vitest'
import { locateProse, type ProseSpan } from '../src/prose.js'

function locate(fragment: string, root = 'body') {
  return locateProse(fragment, { start: 0, end: fragment.length, root })
}

function keys(fragment: string): readonly string[] {
  return locate(fragment).spans.map((span) => span.unitKey)
}

function texts(fragment: string): readonly string[] {
  return locate(fragment).spans.map((span) => span.text)
}

function spanFor(fragment: string, unitKey: string): ProseSpan | undefined {
  return locate(fragment).spans.find((span) => span.unitKey === unitKey)
}

describe('locateProse unit keys', () => {
  it('keys prose by heading path and structural role, never by prose text', () => {
    const fragment = [
      'Opening line.',
      '',
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '## Sub',
      '',
      '- one',
      '- two',
      '',
      '> quote',
      '',
    ].join('\n')
    expect(keys(fragment)).toEqual([
      'body/p-1',
      'body/h1-1/title',
      'body/h1-1/p-1',
      'body/h1-1/h2-1/title',
      'body/h1-1/h2-1/l-1/li-1/p-1',
      'body/h1-1/h2-1/l-1/li-2/p-1',
      'body/h1-1/h2-1/bq-1/p-1',
    ])
  })

  it('restarts role counters inside each heading scope and numbers sibling headings', () => {
    const fragment = ['# One', '', 'first', '', '# Two', '', 'second', ''].join('\n')
    expect(keys(fragment)).toEqual([
      'body/h1-1/title',
      'body/h1-1/p-1',
      'body/h1-2/title',
      'body/h1-2/p-1',
    ])
  })

  it('pops back to the parent scope when a heading level rises again', () => {
    const fragment = ['# One', '', '## Deep', '', 'a', '', '# Two', '', 'b', ''].join('\n')
    expect(keys(fragment)).toEqual([
      'body/h1-1/title',
      'body/h1-1/h2-1/title',
      'body/h1-1/h2-1/p-1',
      'body/h1-2/title',
      'body/h1-2/p-1',
    ])
  })

  it('keys nested list items by their position in each list', () => {
    const fragment = ['- outer', '  - inner one', '  - inner two', ''].join('\n')
    expect(keys(fragment)).toEqual([
      'body/l-1/li-1/p-1',
      'body/l-1/li-1/l-1/li-1/p-1',
      'body/l-1/li-1/l-1/li-2/p-1',
    ])
  })

  it('keys table cells by row and column', () => {
    const fragment = ['| Verb | Effect |', '| --- | --- |', '| get | reads |', ''].join('\n')
    expect(keys(fragment)).toEqual([
      'body/t-1/r-1/c-1',
      'body/t-1/r-1/c-2',
      'body/t-1/r-2/c-1',
      'body/t-1/r-2/c-2',
    ])
    expect(texts(fragment)).toEqual(['Verb', 'Effect', 'get', 'reads'])
  })

  it('roots speaker-note prose under the note key', () => {
    const fragment = ['Speaker: open here.', '', '- a beat', ''].join('\n')
    expect(locateProse(fragment, { start: 0, end: fragment.length, root: 'note' }).spans).toEqual([
      expect.objectContaining({ unitKey: 'note/p-1' }),
      expect.objectContaining({ unitKey: 'note/l-1/li-1/p-1' }),
    ])
  })

  it('produces keys that survive the core identity gate', () => {
    const fragment = ['# T', '', '- a', ''].join('\n')
    for (const key of keys(fragment)) {
      expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
    }
  })
})

describe('locateProse spans', () => {
  it('reports offsets relative to the whole file, not the fragment', () => {
    const file = 'HEADER\n\nA paragraph.\n'
    const located = locateProse(file, { start: 8, end: file.length, root: 'body' })
    const span = located.spans[0] as ProseSpan
    expect(file.slice(span.start, span.end)).toBe('A paragraph.')
  })

  it('excludes the heading marker and the setext underline from the span', () => {
    expect(spanFor('## Marked ##\n', 'body/h2-1/title')?.text).toBe('Marked')
    expect(spanFor('Setext\n======\n', 'body/h1-1/title')?.text).toBe('Setext')
  })

  it('keeps markdown inline markup literal inside the unit (spec 001 FR-004)', () => {
    const fragment = 'A **bold** `kubectl get pods` and an ![img](a.png) link.\n'
    expect(texts(fragment)).toEqual(['A **bold** `kubectl get pods` and an ![img](a.png) link.'])
  })

  it('strips the blockquote prefix from continuation lines and records it', () => {
    const span = spanFor('> quoted line\n> continued here\n', 'body/bq-1/p-1')
    expect(span?.text).toBe('quoted line\ncontinued here')
    expect(span?.continuationPrefix).toBe('> ')
  })

  it('strips list-item indentation from continuation lines', () => {
    const span = spanFor('- wrapped item\n  second line\n', 'body/l-1/li-1/p-1')
    expect(span?.text).toBe('wrapped item\nsecond line')
    expect(span?.continuationPrefix).toBe('  ')
  })

  it('leaves a top-level wrapped paragraph exactly as written', () => {
    const span = spanFor('one\ntwo\n', 'body/p-1')
    expect(span?.text).toBe('one\ntwo')
    expect(span?.continuationPrefix).toBe('')
  })
})

describe('locateProse leaves protected skeleton alone', () => {
  it('never emits fenced code, however the fence is spelled', () => {
    const fragment = [
      '````md magic-move',
      '```yaml {none|1-2|all}',
      'kind: Role',
      '---',
      'kind: RoleBinding',
      '```',
      '````',
      '',
      '~~~text',
      'tilde fenced',
      '~~~',
      '',
      'Real prose.',
      '',
    ].join('\n')
    expect(texts(fragment)).toEqual(['Real prose.'])
  })

  it('never emits the tags or props of a raw HTML block or a Vue island', () => {
    const fragment = [
      // `v-on:click`, not `@click`: CommonMark's attribute grammar has no `@`, so a tag
      // carrying one opens no HTML block — to micromark or to markdown-it.
      '<KwCard heading="Stable DNS" kind="svc" v-click="2" :note="x" v-on:click="go">',
      '  peers dial by name',
      '</KwCard>',
      '',
    ].join('\n')
    expect(texts(fragment)).toEqual(['peers dial by name'])
  })

  it('reports prose inside an HTML block that cannot be extracted, such as a comment aside', () => {
    const fragment = [
      '<div class="grid">',
      '<!-- an aside nobody translates -->',
      '</div>',
      '',
    ].join('\n')
    const located = locate(fragment)
    expect(located.spans).toEqual([])
    expect(located.diagnostics.map((d) => d.code)).toEqual(['prose-in-html-block'])
    expect(located.diagnostics[0]?.severity).toBe('warning')
  })

  it('stays quiet about an HTML block that carries no prose', () => {
    const fragment = ['<div class="grid">', '  <K8sIcon kind="sts" />', '</div>', ''].join('\n')
    expect(locate(fragment).diagnostics).toEqual([])
  })

  it('never emits an image-only paragraph as translatable text', () => {
    expect(texts('![](/covers/section-18.webp)\n')).toEqual([])
  })

  it('never emits an empty or whitespace-only span', () => {
    expect(texts('#\n\n##   \n\n- \n')).toEqual([])
  })

  it('never emits a span that is only inline code', () => {
    // `rate(http_requests_total[5m])` as a whole heading is an API identifier, which
    // FR-005 requires byte-identical in every locale — there is nothing to translate.
    expect(texts('# `rate(http_requests_total[5m])`\n')).toEqual([])
    expect(texts('- `--dry-run=client`\n')).toEqual([])
    expect(texts('| `get` | `list` |\n| --- | --- |\n')).toEqual([])
  })

  it('still emits a span where inline code sits inside a sentence', () => {
    expect(texts('Run `kubectl get pods` to list them.\n')).toEqual([
      'Run `kubectl get pods` to list them.',
    ])
  })
})

describe('locateProse and CommonMark laziness', () => {
  it('takes the longest common prefix when a continuation line drops the marker', () => {
    const span = spanFor('> quoted line\nlazy continuation\n> back inside\n', 'body/bq-1/p-1')
    expect(span?.continuationPrefix).toBe('')
    expect(span?.text).toBe('quoted line\nlazy continuation\n> back inside')
  })

  it('handles the corpus shape: a wrapped bullet that continues at column zero', () => {
    const fragment = ['- first line wraps', '  onto an indented line', 'then a lazy one', ''].join(
      '\n',
    )
    const span = spanFor(fragment, 'body/l-1/li-1/p-1')
    expect(span?.continuationPrefix).toBe('')
    expect(span?.text).toBe('first line wraps\n  onto an indented line\nthen a lazy one')
    expect(locate(fragment).diagnostics).toEqual([])
  })
})

describe('locateProse inside HTML blocks and components (ADR 0015)', () => {
  const pairs = (fragment: string) =>
    locate(fragment).spans.map((span) => [span.unitKey, span.text] as const)

  it('extracts the prose of every card in a grid, keyed by structure', () => {
    const fragment = [
      '<div class="kw-cols-2 mt-3 text-sm">',
      '  <KwCard heading="ClusterIP — the default" kind="svc">',
      '    A stable <strong>in-cluster</strong> virtual IP.',
      '    Reachable only from inside.',
      '  </KwCard>',
      '  <KwCard heading="NodePort" kind="svc" variant="plain">',
      '    ClusterIP <em>plus</em> a fixed port.',
      '  </KwCard>',
      '</div>',
      '',
    ].join('\n')
    const located = locate(fragment)
    expect(pairs(fragment)).toEqual([
      [
        'body/div.1/kw-card.1/t:1',
        'A stable <strong>in-cluster</strong> virtual IP.\nReachable only from inside.',
      ],
      ['body/div.1/kw-card.2/t:1', 'ClusterIP <em>plus</em> a fixed port.'],
    ])
    expect(located.spans.map((span) => [span.kind, span.continuationPrefix])).toEqual([
      ['html-text', '    '],
      ['html-text', ''],
    ])
    expect(located.diagnostics).toEqual([])
  })

  it('points every span at the original bytes', () => {
    const fragment =
      '<CodeNote at="1" label="get-contexts">\nLists every <code>*</code> cluster.\n</CodeNote>\n'
    const [span] = locate(fragment).spans
    expect(span?.unitKey).toBe('body/code-note.1/t:1')
    expect(fragment.slice(span?.start, span?.end)).toBe('Lists every <code>*</code> cluster.')
  })

  it('counts top-level elements in the heading scope, across blocks', () => {
    const fragment = [
      '# Title',
      '',
      '<KwCard>',
      'First card.',
      '</KwCard>',
      '',
      'A paragraph between.',
      '',
      '<KwCard>',
      'Second card.',
      '</KwCard>',
      '',
    ].join('\n')
    expect(keys(fragment)).toEqual([
      'body/h1-1/title',
      'body/h1-1/kw-card.1/t:1',
      'body/h1-1/p-1',
      'body/h1-1/kw-card.2/t:1',
    ])
  })

  it('reads a component whose markdown children are set off by blank lines as markdown', () => {
    const fragment = [
      '<KwCard heading="x">',
      '',
      '**Bold** markdown child.',
      '',
      '</KwCard>',
      '',
    ].join('\n')
    expect(pairs(fragment)).toEqual([['body/p-1', '**Bold** markdown child.']])
    expect(locate(fragment).diagnostics).toEqual([])
  })

  it('reads the same children without blank lines as raw HTML text, markup literal', () => {
    const fragment = ['<KwCard heading="x">', '**Bold** raw child.', '</KwCard>', ''].join('\n')
    expect(pairs(fragment)).toEqual([['body/kw-card.1/t:1', '**Bold** raw child.']])
  })

  it('keys nested components by their path', () => {
    const fragment = [
      '<div class="kw-cols-3">',
      '  <v-click at="1">',
      '    <KwCard heading="Engine">',
      '      What the kubelet talks to.',
      '    </KwCard>',
      '  </v-click>',
      '  <v-click at="2">',
      '    <KwCard heading="Runtime">',
      '      What starts the process.',
      '    </KwCard>',
      '  </v-click>',
      '</div>',
      '',
    ].join('\n')
    expect(keys(fragment)).toEqual([
      'body/div.1/v-click.1/kw-card.1/t:1',
      'body/div.1/v-click.2/kw-card.1/t:1',
    ])
  })

  it('reads a self-closing component inside a block as a boundary', () => {
    const fragment = [
      '<KwCard heading="x" kind="pod">',
      '  <K8sIcon kind="pod" /> <strong>Pod</strong> <span class="kw-muted">→</span>',
      '</KwCard>',
      '',
    ].join('\n')
    expect(pairs(fragment)).toEqual([
      ['body/kw-card.1/t:1', '<strong>Pod</strong> <span class="kw-muted">→</span>'],
    ])
  })

  it('reads a multi-line opening tag as a paragraph, as both CommonMark and Slidev do', () => {
    // An HTML block opens only on a tag complete on its first line (CommonMark 4.6, rule
    // 7; markdown-it tests the same regex per line). A tag spread over lines is inline
    // HTML in a paragraph, so the paragraph is the unit and the markup guard keeps it.
    const fragment = [
      '<KwCard',
      '  heading="x"',
      '  kind="pod">',
      '  Body text.',
      '</KwCard>',
      '',
    ].join('\n')
    expect(locate(fragment).spans.map((span) => [span.unitKey, span.kind])).toEqual([
      ['body/p-1', 'markdown'],
    ])
  })

  it('never emits a paragraph that is nothing but an opening tag', () => {
    // `>` alone on a line opens a blockquote, which leaves the tag above it unterminated.
    const fragment = ['<KwCard', '  heading="x"', '  kind="pod"', '>', ''].join('\n')
    expect(texts(fragment)).toEqual([])
  })

  it('splits text around a component rather than carrying the component in a unit', () => {
    const fragment = [
      '<KwCard>',
      '  Use <KwChip variant="ok">core</KwChip> tier.',
      '</KwCard>',
      '',
    ].join('\n')
    expect(pairs(fragment)).toEqual([
      ['body/kw-card.1/t:1', 'Use'],
      ['body/kw-card.1/kw-chip.1/t:1', 'core'],
      ['body/kw-card.1/t:2', 'tier.'],
    ])
  })

  it('treats a phrasing element carrying a directive as a boundary', () => {
    const fragment = ['<div>', '  Some <span v-if="x">maybe</span> text', '</div>', ''].join('\n')
    expect(texts(fragment)).toEqual(['Some', 'maybe', 'text'])
  })

  it('keeps an interpolation inside the run, where the markup guard protects it', () => {
    const fragment = [
      '<div>',
      '  Page {{ $slidev.nav.currentPage }} of the deck',
      '</div>',
      '',
    ].join('\n')
    expect(texts(fragment)).toEqual(['Page {{ $slidev.nav.currentPage }} of the deck'])
  })

  it('never emits a run that is only code, symbols or an interpolation', () => {
    const fragment = [
      '<div>',
      '  <code>kubectl get pods</code>',
      '  <span>→ ①</span>',
      '  {{ $slidev.nav.currentPage }}',
      '</div>',
      '',
    ].join('\n')
    expect(texts(fragment)).toEqual([])
    expect(locate(fragment).diagnostics).toEqual([])
  })

  it('never scans code, styles or scripts for prose, and does not report them', () => {
    const fragment = [
      '<style>',
      '.kw-card { color: red }',
      '</style>',
      '',
      '<pre>',
      'kubectl get pods',
      '</pre>',
      '',
    ].join('\n')
    expect(texts(fragment)).toEqual([])
    expect(locate(fragment).diagnostics).toEqual([])
  })

  it('leaves entities literal in the unit', () => {
    expect(texts('<div>\n  Use &lt;ns&gt; here.\n</div>\n')).toEqual(['Use &lt;ns&gt; here.'])
  })

  it('keeps a paragraph with an inline component whole, as a markdown unit', () => {
    const fragment = 'Use the <KwChip variant="ok">core</KwChip> tier.\n'
    expect(locate(fragment).spans.map((span) => [span.unitKey, span.kind, span.text])).toEqual([
      ['body/p-1', 'markdown', 'Use the <KwChip variant="ok">core</KwChip> tier.'],
    ])
  })

  it('keeps the blockquote prefix of an HTML block inside a quote out of the unit', () => {
    const fragment = '> <div>\n> Quoted text\n> that wraps.\n> </div>\n'
    const [span] = locate(fragment).spans
    expect(span?.unitKey).toBe('body/bq-1/div.1/t:1')
    expect(span?.text).toBe('Quoted text\nthat wraps.')
    expect(fragment.slice(span?.start, span?.end)).toBe('Quoted text\n> that wraps.')
  })
})

describe('locateProse and Slidev slot markers', () => {
  // Slidev's slot sugar (`@slidev/cli` 52.19.0, `node/syntax/slot-sugar.ts`): a line
  // matching `/^::\s*([\w.\-:]+)\s*::\s*$/` at block indent 0 becomes
  // `<template v-slot:name>`. It is layout machinery; translating it moves prose between
  // columns or drops it from the slide.
  it('never emits a slot marker line as translatable text', () => {
    const fragment = ['Left column.', '', '::right::', '', 'Right column.', ''].join('\n')
    expect(texts(fragment)).toEqual(['Left column.', 'Right column.'])
  })

  it('accepts every spelling the slot-marker grammar accepts', () => {
    for (const marker of ['::notes::', ':: right ::', '::a.b-c:d_e::', '::right::  ']) {
      const fragment = ['Before.', '', marker, '', 'After.', ''].join('\n')
      expect(texts(fragment), marker).toEqual(['Before.', 'After.'])
    }
  })

  it('scopes the keys after a marker under the slot name, so the columns key independently', () => {
    const fragment = [
      '# Title',
      '',
      'Left one.',
      '',
      '::right::',
      '',
      'Right one.',
      '',
      '- a bullet',
      '',
    ].join('\n')
    expect(keys(fragment)).toEqual([
      'body/h1-1/title',
      'body/h1-1/p-1',
      'body/slot-right/p-1',
      'body/slot-right/l-1/li-1/p-1',
    ])
  })

  it('keeps right-column keys stable when a paragraph is added to the left column', () => {
    const before = ['Left.', '', '::right::', '', 'Right.', ''].join('\n')
    const after = ['Left.', '', 'Another left.', '', '::right::', '', 'Right.', ''].join('\n')
    expect(spanFor(before, 'body/slot-right/p-1')?.text).toBe('Right.')
    expect(spanFor(after, 'body/slot-right/p-1')?.text).toBe('Right.')
  })

  it('splits a paragraph a marker interrupts, the way Slidev does', () => {
    const fragment = 'Left line.\n::right::\nRight line.\n'
    const located = locate(fragment)
    expect(located.spans.map((span) => [span.unitKey, span.text])).toEqual([
      ['body/p-1', 'Left line.'],
      ['body/slot-right/p-1', 'Right line.'],
    ])
    for (const span of located.spans) {
      expect(fragment.slice(span.start, span.end)).not.toContain('::')
    }
  })

  it('leaves a marker-shaped line inside a fence alone and opens no slot', () => {
    const fragment = ['```md', '::right::', '```', '', 'After.', ''].join('\n')
    expect(keys(fragment)).toEqual(['body/p-1'])
  })

  it('does not treat an indented or embedded marker as a slot marker', () => {
    // Slidev requires indent 0 and the whole line; anything else renders as text.
    expect(texts('Use ::right:: to split.\n')).toEqual(['Use ::right:: to split.'])
  })

  it('never emits a paragraph carrying a marker inside a container, and says so', () => {
    const located = locate('> quoted\n> ::right::\n')
    expect(located.spans).toEqual([])
    expect(located.diagnostics.map((d) => d.code)).toEqual(['slot-marker-in-container'])
  })

  it('falls back to an ordinal segment for a repeated or awkward slot name', () => {
    const fragment = [
      '::right::',
      '',
      'a',
      '',
      '::right::',
      '',
      'b',
      '',
      '::x..y::',
      '',
      'c',
      '',
    ].join('\n')
    expect(keys(fragment)).toEqual(['body/slot-right/p-1', 'body/slot.2/p-1', 'body/slot.3/p-1'])
  })
})

describe('locateProse is deterministic', () => {
  it('returns identical spans for identical input', () => {
    const fragment = ['# T', '', 'a', '', '- b', '', '> c', ''].join('\n')
    expect(locate(fragment)).toEqual(locate(fragment))
  })
})
