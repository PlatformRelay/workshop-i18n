import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { extractSlidevFile, locateSlidevFile, SlidevExtractionError } from '../src/extract.js'
import { composeSkeleton } from '../src/skeleton.js'

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

  it('reports prose trapped in a Vue island rather than dropping it silently', () => {
    const source = [
      '---',
      'slideId: s12-sts-dns',
      '---',
      '',
      '<KwCard kind="svc">',
      'Headless Service means peers dial by name.',
      '</KwCard>',
      '',
    ].join('\n')
    const located = locateSlidevFile(source)
    expect(located.units).toEqual([])
    expect(located.diagnostics.map((d) => d.code)).toEqual(['prose-in-html-block'])
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
