import { isSafeContainerId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { extractSlidevFile } from '../src/extract.js'
import { checkSlideIds, collectSlideIds, planSlideIds, proposeSlideId } from '../src/init-ids.js'

const SECTION = 's05-pod'

/**
 * Re-derive the original by deleting exactly what the plan inserted.
 *
 * Ascending order needs no offset arithmetic: removing insertion `j` cancels the shift
 * it introduced, so insertion `i` sits at the offset the plan recorded when its turn
 * comes.
 */
function withoutInsertions(plan: {
  text: string
  insertions: readonly { offset: number; text: string }[]
}): string {
  let text = plan.text
  for (const insertion of plan.insertions) {
    text = text.slice(0, insertion.offset) + text.slice(insertion.offset + insertion.text.length)
  }
  return text
}

describe('planSlideIds', () => {
  it('inserts an id into an existing block and changes no other byte (spec 001 AS-1)', () => {
    const source = [
      '---',
      'layout: section-cover',
      'heading: What runs your container?',
      '---',
      '',
      '# Pods',
      '',
    ].join('\n')
    const plan = planSlideIds(source, { sectionId: SECTION })
    expect(plan.text).toBe(
      [
        '---',
        'slideId: s05-pod-what-runs-your-container',
        'layout: section-cover',
        'heading: What runs your container?',
        '---',
        '',
        '# Pods',
        '',
      ].join('\n'),
    )
    expect(withoutInsertions(plan)).toBe(source)
  })

  it('opens a frontmatter block for a slide that has none', () => {
    const source = [
      '---',
      'slideId: s05-pod-one',
      '---',
      '',
      '# One',
      '',
      '---',
      '',
      '# Two',
      '',
    ].join('\n')
    const plan = planSlideIds(source, { sectionId: SECTION })
    expect(plan.text).toBe(
      [
        '---',
        'slideId: s05-pod-one',
        '---',
        '',
        '# One',
        '',
        '---',
        'slideId: s05-pod-two',
        '---',
        '',
        '# Two',
        '',
      ].join('\n'),
    )
    expect(withoutInsertions(plan)).toBe(source)
  })

  it('opens a leading block for a file that starts with content', () => {
    const source = '# Straight in\n\ntext\n'
    const plan = planSlideIds(source, { sectionId: SECTION })
    expect(plan.text).toBe('---\nslideId: s05-pod-straight-in\n---\n# Straight in\n\ntext\n')
    expect(withoutInsertions(plan)).toBe(source)
  })

  it('is idempotent: a second run changes nothing (AS-2)', () => {
    const source = [
      '---',
      'heading: Why Pods',
      '---',
      '',
      '# Pods',
      '',
      '---',
      '',
      '# More',
      '',
    ].join('\n')
    const once = planSlideIds(source, { sectionId: SECTION })
    const twice = planSlideIds(once.text, { sectionId: SECTION })
    expect(twice.insertions).toEqual([])
    expect(twice.text).toBe(once.text)
  })

  it('leaves an existing identity alone', () => {
    const source = ['---', 'slideId: keep-me', 'heading: Ignored', '---', '', '# X', ''].join('\n')
    expect(planSlideIds(source, { sectionId: SECTION }).insertions).toEqual([])
  })

  it('gives every slide of the deck a usable identity', () => {
    const source = ['---', 'layout: cover', '---', '', '# One', '', '---', '', '# Two', ''].join(
      '\n',
    )
    const extracted = extractSlidevFile(planSlideIds(source, { sectionId: SECTION }).text)
    expect(extracted.slides.map((slide) => slide.slideId)).toEqual(['s05-pod-one', 's05-pod-two'])
  })

  it('keeps CRLF line endings when it inserts', () => {
    const source = ['---', 'layout: cover', '---', '', '# One', ''].join('\r\n')
    const plan = planSlideIds(source, { sectionId: SECTION })
    expect(plan.text).toBe(
      ['---', 'slideId: s05-pod-one', 'layout: cover', '---', '', '# One', ''].join('\r\n'),
    )
  })

  it('carries a deck diagnostic through instead of editing a file it cannot read', () => {
    const source = ['---', 'layout: cover', '', '# Never closed', ''].join('\n')
    const plan = planSlideIds(source, { sectionId: SECTION })
    expect(plan.diagnostics.map((d) => d.code)).toContain('unclosed-frontmatter')
  })
})

describe('proposeSlideId', () => {
  const propose = (
    heading: string | undefined,
    taken: readonly string[] = [],
    sectionId = SECTION,
  ) => proposeSlideId(heading, { sectionId, taken: new Set(taken) })

  it('derives a readable id from section and heading', () => {
    expect(propose('What runs your container?')).toBe('s05-pod-what-runs-your-container')
  })

  it('folds non-ASCII down to a safe ASCII slug', () => {
    expect(propose('Zwei Bereiche × zwei Objekte — die RBAC 2×2')).toBe(
      's05-pod-zwei-bereiche-zwei-objekte-die-rbac-2-2',
    )
  })

  it('falls back to a stable stem when there is no heading at all', () => {
    expect(propose(undefined)).toBe('s05-pod-slide')
    expect(propose('   ')).toBe('s05-pod-slide')
  })

  it('suffixes rather than collides', () => {
    expect(propose('Pods', ['s05-pod-pods'])).toBe('s05-pod-pods-2')
    expect(propose('Pods', ['s05-pod-pods', 's05-pod-pods-2'])).toBe('s05-pod-pods-3')
  })

  it('escapes a heading that slugifies to a name no file system can hold', () => {
    // `con`, `nul`, `aux`, `prn` are Windows device names; a container id becomes a file.
    for (const reserved of ['CON', 'Aux', 'nul', 'PRN', 'lpt1']) {
      const id = propose(reserved, [], '')
      expect(isSafeContainerId(id)).toBe(true)
      expect(id).not.toBe(reserved.toLowerCase())
    }
  })

  it('always proposes an id core will accept', () => {
    for (const heading of ['...', '///', '🐳 🐳', '-- --', 'a'.repeat(400), '2001']) {
      expect(isSafeContainerId(propose(heading))).toBe(true)
    }
  })
})

describe('collectSlideIds and checkSlideIds', () => {
  const missing = ['---', 'layout: cover', '---', '', '# One', ''].join('\n')
  const duplicated = [
    '---',
    'slideId: twice',
    '---',
    '',
    '# One',
    '',
    '---',
    'slideId: twice',
    '---',
    '',
    '# Two',
    '',
  ].join('\n')

  it('records every slide with its identity and location', () => {
    const records = collectSlideIds(duplicated)
    expect(records.map((record) => record.slideId)).toEqual(['twice', 'twice'])
    expect(records.map((record) => record.line)).toEqual([1, 7])
  })

  it('reports a slide with no identity', () => {
    const issues = checkSlideIds([{ path: 'pages/S05-pod/index.md', source: missing }])
    expect(issues.map((issue) => issue.code)).toEqual(['missing-slide-id'])
    expect(issues[0]?.locations).toEqual([
      { path: 'pages/S05-pod/index.md', slideIndex: 0, line: 1, column: 1 },
    ])
  })

  it('names both places when two slides claim one identity (AS-3)', () => {
    const issues = checkSlideIds([{ path: 'a.md', source: duplicated }])
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate-slide-id'])
    expect(issues[0]?.slideId).toBe('twice')
    expect(issues[0]?.locations.map((location) => location.line)).toEqual([1, 7])
  })

  it('catches a duplicate spread across two files', () => {
    const one = ['---', 'slideId: shared', '---', '', '# One', ''].join('\n')
    const two = ['---', 'slideId: shared', '---', '', '# Two', ''].join('\n')
    const issues = checkSlideIds([
      { path: 'a.md', source: one },
      { path: 'b.md', source: two },
    ])
    expect(issues[0]?.locations.map((location) => location.path)).toEqual(['a.md', 'b.md'])
  })

  it('passes once init-ids has run (FR-002)', () => {
    const applied = planSlideIds(missing, { sectionId: SECTION }).text
    expect(checkSlideIds([{ path: 'a.md', source: applied }])).toEqual([])
  })

  it('reports an identity that is unsafe as a file name', () => {
    const source = ['---', "slideId: '../escape'", '---', '', '# One', ''].join('\n')
    expect(checkSlideIds([{ path: 'a.md', source }]).map((issue) => issue.code)).toEqual([
      'unsafe-slide-id',
    ])
  })
})

describe('planSlideIds keeps proposals unique across a deck', () => {
  it('does not reuse an id already taken elsewhere', () => {
    const source = ['---', 'layout: cover', '---', '', '# Pods', ''].join('\n')
    const plan = planSlideIds(source, { sectionId: SECTION, taken: ['s05-pod-pods'] })
    expect(plan.insertions[0]?.slideId).toBe('s05-pod-pods-2')
  })

  it('does not reuse an id already present in the same file', () => {
    const source = [
      '---',
      'slideId: s05-pod-pods',
      '---',
      '',
      '# One',
      '',
      '---',
      '',
      '# Pods',
      '',
    ].join('\n')
    const plan = planSlideIds(source, { sectionId: SECTION })
    expect(plan.insertions[0]?.slideId).toBe('s05-pod-pods-2')
  })
})
