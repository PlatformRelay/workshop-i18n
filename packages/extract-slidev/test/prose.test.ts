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

  it('never emits a raw HTML block or a Vue island', () => {
    const fragment = [
      '<KwCard heading="Stable DNS">',
      '  peers dial by name',
      '</KwCard>',
      '',
    ].join('\n')
    expect(texts(fragment)).toEqual([])
  })

  it('reports prose trapped inside an HTML block instead of extracting or hiding it', () => {
    const fragment = ['<div class="grid">', 'Headless Service dials by name.', '</div>', ''].join(
      '\n',
    )
    const located = locate(fragment)
    expect(located.spans).toEqual([])
    expect(located.diagnostics.map((d) => d.code)).toEqual(['prose-in-html-block'])
    expect(located.diagnostics[0]?.severity).toBe('warning')
  })

  it('reports prose a tag sits in front of on the same line', () => {
    // A line starting with `<` is not automatically markup: `<p>text</p>` is prose with a
    // tag in front of it, and a coverage metric that under-reports is worse than none.
    const fragment = ['<div class="grid">', '<p>Trapped prose lives here</p>', '</div>', ''].join(
      '\n',
    )
    expect(locate(fragment).diagnostics.map((d) => d.code)).toEqual(['prose-in-html-block'])
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

describe('locateProse is deterministic', () => {
  it('returns identical spans for identical input', () => {
    const fragment = ['# T', '', 'a', '', '- b', '', '> c', ''].join('\n')
    expect(locate(fragment)).toEqual(locate(fragment))
  })
})
