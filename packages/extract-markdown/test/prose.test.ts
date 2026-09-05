import { describe, expect, it } from 'vitest'
import { locateProse, type ProseSpan } from '../src/prose.js'

function locate(source: string): readonly ProseSpan[] {
  return locateProse(source, { start: 0, end: source.length, root: 'body' }).spans
}

function keys(source: string): readonly string[] {
  return locate(source).map((span) => span.unitKey)
}

function texts(source: string): readonly string[] {
  return locate(source).map((span) => span.text)
}

describe('locateProse', () => {
  it('reports offsets that slice the exact prose out of the source', () => {
    const source = '# Lab 05\n\nRun the pod.\n'
    for (const span of locate(source)) {
      expect(source.slice(span.start, span.end)).toBe(span.text)
    }
  })

  it('roots keys at heading scopes rather than a flat ordinal', () => {
    const source = ['# Lab', '', 'intro', '', '## Step 1', '', 'first', '', 'second', ''].join('\n')
    expect(keys(source)).toEqual([
      'body/h1-1/title',
      'body/h1-1/p-1',
      'body/h1-1/h2-1/title',
      'body/h1-1/h2-1/p-1',
      'body/h1-1/h2-1/p-2',
    ])
  })

  it('restarts role counters inside each heading scope, so editing one section does not renumber another', () => {
    const before = ['## A', '', 'a1', '', '## B', '', 'b1', ''].join('\n')
    const after = ['## A', '', 'a0', '', 'a1', '', '## B', '', 'b1', ''].join('\n')
    expect(keys(after).at(-1)).toBe(keys(before).at(-1))
  })

  it('never emits fenced code, indented code or thematic breaks', () => {
    const source = [
      'prose',
      '',
      '```yaml',
      'kind: Pod',
      '---',
      'kind: Service',
      '```',
      '',
      '---',
      '',
      '    indented code',
      '',
      'after',
    ].join('\n')
    expect(texts(source)).toEqual(['prose', 'after'])
  })

  it('leaves inline markup literal inside the unit', () => {
    const source = 'Apply `kubectl apply -f pod.yaml` to **create** [it](./pod.yaml).\n'
    expect(texts(source)).toEqual([
      'Apply `kubectl apply -f pod.yaml` to **create** [it](./pod.yaml).',
    ])
  })

  it('skips a paragraph that is only an image reference', () => {
    expect(texts('![](./diagram.png)\n')).toEqual([])
  })

  it('skips a heading that is only inline code', () => {
    expect(texts('## `kubectl get pods -o wide`\n')).toEqual([])
  })

  it('keeps an image that rides inside a sentence', () => {
    expect(texts('See ![the diagram](./d.png) here.\n')).toEqual([
      'See ![the diagram](./d.png) here.',
    ])
  })

  it('extracts GFM table cells, cell by cell, and skips the empty ones', () => {
    const source = ['| | |', '| --- | --- |', '| **Section** | S05 — Pod |', ''].join('\n')
    expect(locate(source).map((span) => [span.unitKey, span.text])).toEqual([
      ['body/t-1/r-2/c-1', '**Section**'],
      ['body/t-1/r-2/c-2', 'S05 — Pod'],
    ])
  })

  it('descends into blockquotes and list items with per-container key scopes', () => {
    const source = ['- first item', '- second item', '', '> quoted prose', ''].join('\n')
    expect(keys(source)).toEqual(['body/l-1/li-1/p-1', 'body/l-1/li-2/p-1', 'body/bq-1/p-1'])
  })

  it('records the container prefix that every continuation line carries', () => {
    const source = '> wrapped one\n> wrapped two\n'
    const [span] = locate(source)
    expect(span?.continuationPrefix).toBe('> ')
    expect(span?.text).toBe('wrapped one\nwrapped two')
  })

  it('takes the longest common prefix when CommonMark laziness drops the marker', () => {
    const source = '> wrapped one\nlazy continuation\n'
    const [span] = locate(source)
    expect(span?.continuationPrefix).toBe('')
    expect(span?.text).toBe('wrapped one\nlazy continuation')
  })

  describe('<details> spoilers', () => {
    const source = [
      '<details><summary>Solution / expected output</summary>',
      '',
      '```bash',
      'kubectl get pods',
      '```',
      '',
      '</details>',
      '',
    ].join('\n')

    it('extracts the summary text as its own unit', () => {
      const spans = locate(source)
      expect(spans.map((span) => [span.unitKey, span.text])).toEqual([
        ['body/html-1/summary-1', 'Solution / expected output'],
      ])
      expect(spans[0]?.encoding).toEqual({ kind: 'html-inline' })
    })

    it('slices the summary text exactly out of the source', () => {
      const [span] = locate(source)
      expect(source.slice(span?.start ?? 0, span?.end ?? 0)).toBe('Solution / expected output')
    })

    it('leaves the <details> and <summary> tags as skeleton', () => {
      const spans = locate(source)
      for (const span of spans) {
        expect(span.text).not.toContain('<summary')
        expect(span.text).not.toContain('<details')
      }
    })

    it('keeps inline markup inside a summary literal', () => {
      const spans = locate('<details><summary>Got <code>403</code>?</summary>\n')
      expect(spans.map((span) => span.text)).toEqual(['Got <code>403</code>?'])
    })

    it('raises no coverage warning once the summary is extracted', () => {
      const located = locateProse(source, { start: 0, end: source.length, root: 'body' })
      expect(located.diagnostics).toEqual([])
    })

    it('extracts prose inside the spoiler body, which CommonMark parses as markdown', () => {
      const withProse = [
        '<details><summary>Answer</summary>',
        '',
        'Because the selector no longer matches.',
        '',
        '</details>',
        '',
      ].join('\n')
      expect(texts(withProse)).toEqual(['Answer', 'Because the selector no longer matches.'])
    })
  })

  it('reports prose trapped inside a raw HTML block as a coverage gap', () => {
    const located = locateProse('<div>\n  Trapped prose that nobody translates.\n</div>\n', {
      start: 0,
      end: 51,
      root: 'body',
    })
    expect(located.spans).toEqual([])
    expect(located.diagnostics.map((item) => item.code)).toEqual(['prose-in-html-block'])
    expect(located.diagnostics[0]?.severity).toBe('warning')
  })

  it('stays quiet about an HTML block that carries no words', () => {
    const located = locateProse('<!-- labId: day-1-05-pod -->\n', {
      start: 0,
      end: 29,
      root: 'body',
    })
    expect(located.diagnostics).toEqual([])
  })

  describe('footnote definitions', () => {
    const source = [
      'A claim.[^cve] And another.[^nist]',
      '',
      '[^cve]: First body.',
      '[^nist]: Second body.',
      '',
    ].join('\n')

    it('gives each definition its own unit, so two footnotes are two identities', () => {
      // Consecutive definitions are one paragraph to a parser without the footnote
      // extension, which puts two independent footnotes behind one msgctxt and one
      // source hash — editing either would fuzz both, and a translation only has to
      // keep the first label to be accepted (constitution II).
      expect(texts(source)).toEqual([
        'A claim.[^cve] And another.[^nist]',
        'First body.',
        'Second body.',
      ])
    })

    it('keys them by their declared label, not by position', () => {
      expect(keys(source)).toEqual(['body/p-1', 'body/fn-cve/p-1', 'body/fn-nist/p-1'])
    })

    it('leaves the [^label]: marker outside the unit entirely', () => {
      for (const span of locate(source)) {
        expect(span.text).not.toContain('[^cve]:')
        expect(span.text).not.toContain('[^nist]:')
        expect(source.slice(span.start, span.end)).toBe(span.text)
      }
    })

    it('renaming one footnote re-keys only that footnote', () => {
      const renamed = source.replace(/nist/g, 'iso')
      expect(keys(renamed)).toEqual(['body/p-1', 'body/fn-cve/p-1', 'body/fn-iso/p-1'])
    })

    it('handles a multi-paragraph footnote body', () => {
      const long = ['[^cve]: First paragraph.', '', '    Second paragraph.', ''].join('\n')
      expect(keys(long)).toEqual(['body/fn-cve/p-1', 'body/fn-cve/p-2'])
    })
  })

  describe('link reference definitions', () => {
    it('reports a definition title, which renders but is not extracted', () => {
      const source = '[docs]: https://kubernetes.io/docs/ "Kubernetes documentation"\n'
      const located = locateProse(source, { start: 0, end: source.length, root: 'body' })
      expect(located.spans).toEqual([])
      expect(located.diagnostics.map((item) => item.code)).toEqual(['prose-in-link-definition'])
      expect(located.diagnostics[0]?.severity).toBe('warning')
      expect(located.diagnostics[0]?.message).toContain('Kubernetes documentation')
    })

    it('stays quiet about an untitled definition, which carries no prose', () => {
      const source = '[docs]: https://kubernetes.io/docs/\n'
      expect(
        locateProse(source, { start: 0, end: source.length, root: 'body' }).diagnostics,
      ).toEqual([])
    })

    it('never emits the label or the target as translatable text', () => {
      const source = 'See [the docs][docs].\n\n[docs]: https://kubernetes.io/docs/\n'
      expect(texts(source)).toEqual(['See [the docs][docs].'])
    })
  })

  it('skips an image-only paragraph and an inline-code-only heading without a diagnostic', () => {
    // Silence here is the stated policy, not an oversight: neither span holds anything a
    // translator could act on, and a finding per image would bury the real gaps under
    // hundreds that need no decision.
    const source = '## `kubectl get pods`\n\n![](./diagram.png)\n'
    const located = locateProse(source, { start: 0, end: source.length, root: 'body' })
    expect(located.spans).toEqual([])
    expect(located.diagnostics).toEqual([])
  })

  it('pays back the byte-order mark the parser silently drops', () => {
    const source = '﻿# CRLF and BOM\n\nThis file starts with a mark.\n'
    for (const span of locate(source)) {
      expect(source.slice(span.start, span.end)).toBe(span.text)
    }
    expect(texts(source)).toEqual(['CRLF and BOM', 'This file starts with a mark.'])
  })

  it('translates offsets back into the whole file when given a fragment', () => {
    const file = 'PREAMBLE\n\nthe prose\n'
    const located = locateProse(file, { start: 10, end: file.length, root: 'body' })
    expect(located.spans.map((span) => file.slice(span.start, span.end))).toEqual(['the prose'])
  })
})
