import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { extractSlidevFile, locateSlidevFile, SlidevExtractionError } from '../src/extract.js'
import { locateProse } from '../src/prose.js'
import { type CompositionError, composeSkeleton } from '../src/skeleton.js'

/** Spec 001 AS-1: two frontmatter blocks, a Vue island, a note, and a fenced block. */
const SLIDE_FILE = [
  '---',
  'slideId: s05-pod-cover',
  'layout: section-cover',
  'image: /covers/section-05.webp',
  'kicker: Day 1',
  'heading: What runs your container?',
  '---',
  '',
  '# Pods',
  '',
  'A Pod is the smallest deployable unit.',
  '',
  '<!--',
  'Speaker: open on the shipping-container metaphor.',
  '',
  '- keep it to two minutes',
  '-->',
  '',
  '---',
  'slideId: s05-pod-spec',
  'layout: code-annotated',
  'clicks: 3',
  '---',
  '',
  '## The spec',
  '',
  '<KwCard heading="One IP per Pod" kind="net" />',
  '',
  '```yaml {none|1-2|all}',
  'kind: Pod',
  '---',
  'kind: Service',
  '```',
  '',
  '- containers share a network namespace',
  '- and a lifecycle',
  '',
  '<!--',
  'Speaker: the fence above must never change.',
  '-->',
  '',
].join('\n')

function ids(source: string): readonly string[] {
  return extractSlidevFile(source).units.map((unit) => formatUnitId(unit.id))
}

describe('extractSlidevFile', () => {
  it('emits prose, headings, declared layout fields and speaker-note prose — and nothing else', () => {
    expect(ids(SLIDE_FILE)).toEqual([
      'slides:s05-pod-cover:body/h1-1/p-1',
      'slides:s05-pod-cover:body/h1-1/title',
      'slides:s05-pod-cover:fm/heading',
      'slides:s05-pod-cover:fm/kicker',
      'slides:s05-pod-cover:note/l-1/li-1/p-1',
      'slides:s05-pod-cover:note/p-1',
      'slides:s05-pod-spec:body/h2-1/l-1/li-1/p-1',
      'slides:s05-pod-spec:body/h2-1/l-1/li-2/p-1',
      'slides:s05-pod-spec:body/h2-1/title',
      'slides:s05-pod-spec:note/p-1',
    ])
  })

  it('never emits the fence, the Vue island, the image reference or the machinery keys', () => {
    const sources = extractSlidevFile(SLIDE_FILE).units.map((unit) => unit.source)
    for (const protectedText of [
      'kind: Pod',
      '```yaml {none|1-2|all}',
      '<KwCard',
      '/covers/section-05.webp',
      'code-annotated',
      's05-pod-spec',
    ]) {
      expect(sources.join('\n')).not.toContain(protectedText)
    }
  })

  it('reproduces the source byte-for-byte when nothing is translated', () => {
    const { skeleton } = extractSlidevFile(SLIDE_FILE)
    expect(composeSkeleton(skeleton, {})).toBe(SLIDE_FILE)
    expect(Buffer.from(composeSkeleton(skeleton, {}), 'utf8')).toEqual(
      Buffer.from(SLIDE_FILE, 'utf8'),
    )
  })

  it('splices a translation into every hole and leaves the skeleton untouched', () => {
    const { skeleton, units } = extractSlidevFile(SLIDE_FILE)
    const translations = Object.fromEntries(
      units.map((unit) => [formatUnitId(unit.id), `DE ${unit.id.unitKey}`]),
    )
    const composed = composeSkeleton(skeleton, translations)
    expect(composed).toContain('# DE body/h1-1/title')
    expect(composed).toContain('kicker: "DE fm/kicker"')
    expect(composed).toContain('- DE body/h2-1/l-1/li-1/p-1')
    expect(composed).toContain('```yaml {none|1-2|all}\nkind: Pod\n---\nkind: Service\n```')
    expect(composed).toContain('<KwCard heading="One IP per Pod" kind="net" />')
    expect(composed).toContain('image: /covers/section-05.webp')
  })

  it('anchors every unit on the hash of its own source', () => {
    for (const unit of extractSlidevFile(SLIDE_FILE).units) {
      expect(unit.sourceHash).toMatch(/^sha256:[0-9a-f]{16}$/)
    }
  })

  it('extracts the prose inside a Vue island and leaves its tag skeleton (ADR 0015)', () => {
    const source = [
      '---',
      'slideId: s12-sts-dns',
      '---',
      '',
      '<KwCard kind="svc">',
      '  Headless Service means peers dial <strong>by name</strong>.',
      '</KwCard>',
      '',
    ].join('\n')
    const located = locateSlidevFile(source)
    expect(located.units.map((unit) => [formatUnitId(unit.id), unit.source])).toEqual([
      [
        'slides:s12-sts-dns:body/kw-card.1/t:1',
        'Headless Service means peers dial <strong>by name</strong>.',
      ],
    ])
    expect(located.skeleton.holes[0]?.encoding).toEqual({
      kind: 'html-text',
      continuationPrefix: '',
      context: 'body',
    })
    expect(located.diagnostics).toEqual([])
    const composed = composeSkeleton(located.skeleton, {
      'slides:s12-sts-dns:body/kw-card.1/t:1': 'Peers wählen <strong>per Name</strong>.',
    })
    expect(composed).toContain(
      '<KwCard kind="svc">\n  Peers wählen <strong>per Name</strong>.\n</KwCard>',
    )
  })

  it('refuses a translation that would end the HTML block it sits in', () => {
    const source = ['---', 'slideId: s1', '---', '', '<div>', '  One line.', '</div>', ''].join(
      '\n',
    )
    const { skeleton } = extractSlidevFile(source)
    expect(() =>
      composeSkeleton(skeleton, { 'slides:s1:body/div.1/t:1': 'Eins.\n\nZwei.' }),
    ).toThrow(/blank line/)
  })
})

describe('extractSlidevFile component text props (ADR 0015)', () => {
  const PROPS = { KwCard: ['heading', 'leftHeading'], CodeNote: ['label'] }
  const slide = (...body: string[]) => ['---', 'slideId: s1', '---', '', ...body, ''].join('\n')
  const units = (source: string, options = { componentTextProps: PROPS }) =>
    extractSlidevFile(source, options).units.map((unit) => [unit.id.unitKey, unit.source])

  it('extracts nothing from a prop until the manifest declares it', () => {
    expect(units(slide('<KwCard heading="One IP per Pod" kind="net" />'), {} as never)).toEqual([])
  })

  it('extracts a declared prop, and never an undeclared one or a binding', () => {
    const source = slide(
      '<CodeNote at="1" label="a real tag" variant="warn" :heading="computed">',
      'You built it.',
      '</CodeNote>',
    )
    expect(units(source)).toEqual([
      ['body/code-note.1/prop:label', 'a real tag'],
      ['body/code-note.1/t:1', 'You built it.'],
    ])
  })

  it('matches names the way Vue resolves them', () => {
    const source = slide('<kw-card left-heading="Links" kind="pod" />')
    expect(units(source)).toEqual([['body/kw-card.1/prop:left-heading', 'Links']])
  })

  it('keeps entities literal and re-escapes the delimiting quote on composition', () => {
    const source = slide(
      `<KwCard heading='Say "hi" &amp; wave' />`,
      '<KwCard heading="It&#39;s here" />',
      '<KwCard heading=Unquoted />',
    )
    const extraction = extractSlidevFile(source, { componentTextProps: PROPS })
    expect(extraction.units.map((unit) => unit.source)).toEqual([
      'Say "hi" &amp; wave',
      'It&#39;s here',
      'Unquoted',
    ])
    const composed = composeSkeleton(extraction.skeleton, {
      'slides:s1:body/kw-card.1/prop:heading': `Sag "hallo" & wink's`,
      'slides:s1:body/kw-card.2/prop:heading': 'Er sagt "da"',
      'slides:s1:body/kw-card.3/prop:heading': 'Ohne "Anführung"',
    })
    expect(composed).toContain(`<KwCard heading='Sag "hallo" & wink&#39;s' />`)
    expect(composed).toContain('<KwCard heading="Er sagt &quot;da&quot;" />')
    expect(composed).toContain('<KwCard heading="Ohne &quot;Anführung&quot;" />')
  })

  it('reproduces the source byte-for-byte when a prop is not translated', () => {
    const source = slide(`<KwCard heading='Say "hi"' />`, '<KwCard heading=Bare />')
    const { skeleton } = extractSlidevFile(source, { componentTextProps: PROPS })
    expect(composeSkeleton(skeleton, {})).toBe(source)
  })

  it('refuses a prop translation that breaks the line or opens a comment', () => {
    const source = slide('<KwCard heading="One line" />')
    const { skeleton } = extractSlidevFile(source, { componentTextProps: PROPS })
    const reasonOf = (text: string) => {
      try {
        composeSkeleton(skeleton, { 'slides:s1:body/kw-card.1/prop:heading': text })
        return undefined
      } catch (error) {
        return (error as CompositionError).issues[0]?.reason
      }
    }
    expect(reasonOf('Zwei\nZeilen')).toBe('attribute-line-break')
    expect(reasonOf('offen <!-- hier')).toBe('comment-terminator')
    expect(reasonOf('Eine Zeile')).toBeUndefined()
  })

  it('refuses a declaration the manifest parser would refuse, when handed one directly', () => {
    for (const props of [['vHtml'], ['v-on'], ['onClick'], ['href'], [':heading']]) {
      expect(
        () =>
          extractSlidevFile(slide('<KwCard heading="x" />'), {
            componentTextProps: { KwCard: props },
          }),
        props[0],
      ).toThrow(TypeError)
    }
    expect(() =>
      extractSlidevFile(slide('<KwCard heading="x" />'), {
        componentTextProps: { 'Kw Card': ['heading'] },
      }),
    ).toThrow(TypeError)
  })

  it('never reads a directive attribute as a prop, even from a table that lists one', () => {
    // The locator's own last line of defence, below the declaration check above.
    // No `@click` in the source: CommonMark has no `@` in attribute names, so a tag
    // carrying one opens no HTML block at all.
    const source = '<KwCard v-html="evil" :heading="x" heading="ok" />\n'
    const spans = locateProse(source, {
      start: 0,
      end: source.length,
      root: 'body',
      textProps: new Map([['kw-card', new Set(['v-html', ':heading', '@click', 'heading'])]]),
    }).spans
    expect(spans.map((span) => [span.unitKey, span.text])).toEqual([
      ['body/kw-card.1/prop:heading', 'ok'],
    ])
  })

  it('skips an empty or symbol-only prop value', () => {
    expect(units(slide('<KwCard heading="" />', '<KwCard heading="①" />'))).toEqual([])
  })
})

describe('extractSlidevFile identity', () => {
  it('fails closed on a slide with no slideId instead of inventing one', () => {
    const source = ['---', 'layout: statement', '---', '', '# No identity', ''].join('\n')
    expect(() => extractSlidevFile(source)).toThrow(SlidevExtractionError)
    const located = locateSlidevFile(source)
    expect(located.diagnostics.map((d) => d.code)).toEqual(['missing-slide-id'])
    expect(located.diagnostics[0]?.line).toBe(1)
    expect(located.units).toEqual([])
  })

  it('fails closed when two slides claim one identity, naming both places', () => {
    const source = [
      '---',
      'slideId: s01-twice',
      '---',
      '',
      '# One',
      '',
      '---',
      'slideId: s01-twice',
      '---',
      '',
      '# Two',
      '',
    ].join('\n')
    const located = locateSlidevFile(source)
    expect(located.diagnostics.map((d) => d.code)).toEqual(['duplicate-slide-id'])
    expect(located.diagnostics[0]?.message).toContain('line 1')
    expect(located.diagnostics[0]?.line).toBe(7)
  })

  it('fails closed on a slideId that would escape its file name', () => {
    const source = ['---', "slideId: '../../etc/passwd'", '---', '', '# Hostile', ''].join('\n')
    expect(locateSlidevFile(source).diagnostics.map((d) => d.code)).toEqual(['unsafe-slide-id'])
  })

  it('carries a deck-level diagnostic through, such as an unclosed frontmatter block', () => {
    const source = ['---', 'slideId: s01-open', '', '# Never closed', ''].join('\n')
    expect(locateSlidevFile(source).diagnostics.map((d) => d.code)).toContain(
      'unclosed-frontmatter',
    )
  })
})

describe('extractSlidevFile identity stability', () => {
  it('changes only the edited unit hash when English changes (spec 001 AS-2)', () => {
    const edited = SLIDE_FILE.replace(
      'A Pod is the smallest deployable unit.',
      'A Pod is the smallest deployable unit in Kubernetes.',
    )
    const before = extractSlidevFile(SLIDE_FILE).units
    const after = extractSlidevFile(edited).units
    expect(after.map((unit) => formatUnitId(unit.id))).toEqual(
      before.map((unit) => formatUnitId(unit.id)),
    )
    const changed = after.filter(
      (unit, index) => unit.sourceHash !== (before[index]?.sourceHash ?? ''),
    )
    expect(changed.map((unit) => formatUnitId(unit.id))).toEqual([
      'slides:s05-pod-cover:body/h1-1/p-1',
    ])
  })

  it('keeps every identity when a slide moves to another file and is reordered (AS-3)', () => {
    const slides = SLIDE_FILE.split('\n---\nslideId: s05-pod-spec\n')
    const moved = ['---', 'slideId: s05-pod-spec', slides[1] ?? ''].join('\n')
    const remaining = slides[0] ?? ''
    const movedIds = ids(moved)
    const remainingIds = ids(remaining)
    expect([...remainingIds, ...movedIds].sort()).toEqual([...ids(SLIDE_FILE)].sort())
  })

  it('is deterministic: the same tree yields the same output (FR-006)', () => {
    expect(extractSlidevFile(SLIDE_FILE)).toEqual(extractSlidevFile(SLIDE_FILE))
  })
})

describe('extractSlidevFile options', () => {
  it('lets the caller declare which frontmatter keys hold text', () => {
    const source = ['---', 'slideId: s01-x', 'blurb: Some prose', '---', '', '# T', ''].join('\n')
    expect(ids(source)).toEqual(['slides:s01-x:body/h1-1/title'])
    const withKey = extractSlidevFile(source, { frontmatterTextKeys: ['blurb'] })
    expect(withKey.units.map((unit) => formatUnitId(unit.id))).toContain('slides:s01-x:fm/blurb')
  })
})
