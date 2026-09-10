import { createTranslationUnit, formatUnitId, type TranslationUnit } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { alignContainer, scopeOf } from '../src/align-container.js'
import { DEFAULT_SEED_LIMITS } from '../src/types.js'

const unit = (key: string, source: string): TranslationUnit =>
  createTranslationUnit({ surface: 'slides', containerId: 's1', unitKey: key }, source)

const t = (unitKey: string, source: string) => ({ unitKey, source })

function align(english: readonly TranslationUnit[], translated: ReturnType<typeof t>[]) {
  return alignContainer('s1', english, translated, DEFAULT_SEED_LIMITS)
}

describe('scopeOf', () => {
  it.each([
    ['fm/title', 'fm/title'],
    ['body/p-1', 'body'],
    ['body/h1-1/title', 'body/h1-1'],
    ['body/h1-1/h2-3/p-2', 'body/h1-1/h2-3'],
    ['body/h1-1/l-2/li-3/p-1', 'body/h1-1'],
    ['note/l-1/li-1/p-1', 'note'],
    ['prompt', 'prompt'],
    ['option/a/text', 'option/a/text'],
  ])('%s belongs to scope %s', (key, scope) => {
    expect(scopeOf(key)).toBe(scope)
  })
})

describe('alignContainer', () => {
  it('pairs every unit of a structurally identical container by key', () => {
    const result = align(
      [unit('fm/title', 'Pods'), unit('body/h1-1/title', 'One Pod'), unit('body/h1-1/p-1', 'Hi')],
      [t('fm/title', 'Pods!'), t('body/h1-1/title', 'Um Pod'), t('body/h1-1/p-1', 'Oi')],
    )
    expect(result.misses).toEqual([])
    expect(result.drafts.map((draft) => [draft.id.unitKey, draft.translation])).toEqual([
      ['fm/title', 'Pods!'],
      ['body/h1-1/title', 'Um Pod'],
      ['body/h1-1/p-1', 'Oi'],
    ])
    expect(result.drafts[0]?.source).toBe('Pods')
  })

  it('misses a heading scope whose block structure diverged, and keeps its siblings', () => {
    const result = align(
      [
        unit('body/h1-1/title', 'A'),
        unit('body/h1-1/p-1', 'one'),
        unit('body/h1-2/title', 'B'),
        unit('body/h1-2/p-1', 'two'),
      ],
      [
        t('body/h1-1/title', 'Á'),
        t('body/h1-1/p-1', 'um'),
        t('body/h1-1/p-2', 'extra'),
        t('body/h1-2/title', 'B!'),
        t('body/h1-2/p-1', 'dois'),
      ],
    )
    expect(result.drafts.map((draft) => draft.id.unitKey)).toEqual([
      'body/h1-2/title',
      'body/h1-2/p-1',
    ])
    expect(result.misses).toEqual([
      {
        reason: 'structure-diverged',
        containerId: 's1',
        unitIds: ['slides:s1:body/h1-1/p-1', 'slides:s1:body/h1-1/title'],
        detail: expect.stringContaining('body/h1-1'),
      },
    ])
  })

  it('misses a whole root when its heading structure diverged — later scopes are re-keyed, never guessed', () => {
    // The translator added a heading: English h1-2 is now translated h1-3. The key sets
    // of `body/h1-2` happen to agree, but pairing them would attach B's text to C.
    const result = align(
      [unit('body/h1-1/title', 'A'), unit('body/h1-2/title', 'B'), unit('note/p-1', 'say hi')],
      [
        t('body/h1-1/title', 'Á'),
        t('body/h1-2/title', 'Novo'),
        t('body/h1-3/title', 'B!'),
        t('note/p-1', 'diga oi'),
      ],
    )
    expect(result.drafts.map((draft) => draft.id.unitKey)).toEqual(['note/p-1'])
    expect(result.misses).toHaveLength(1)
    expect(result.misses[0]?.reason).toBe('structure-diverged')
    expect(result.misses[0]?.unitIds).toEqual([
      'slides:s1:body/h1-1/title',
      'slides:s1:body/h1-2/title',
    ])
  })

  it('aggregates unit-level refusals into one miss per reason', () => {
    const result = align(
      [unit('body/p-1', 'kubectl'), unit('body/p-2', 'helm'), unit('body/p-3', 'Run')],
      [t('body/p-1', 'kubectl'), t('body/p-2', 'helm'), t('body/p-3', '<script>x</script>')],
    )
    expect(result.drafts).toEqual([])
    expect(result.misses.map((miss) => [miss.reason, miss.unitIds])).toEqual([
      ['markup-divergence', ['slides:s1:body/p-3']],
      ['identical-to-source', ['slides:s1:body/p-1', 'slides:s1:body/p-2']],
    ])
  })

  it('never echoes translated text into a miss detail', () => {
    const result = align([unit('body/p-1', 'Run')], [t('body/p-1', '<img src=x onerror=alert(1)>')])
    expect(JSON.stringify(result.misses)).not.toContain('onerror')
  })

  it('accounts for every English unit exactly once', () => {
    const english = [
      unit('fm/title', 'T'),
      unit('body/h1-1/title', 'A'),
      unit('body/h1-1/p-1', 'same'),
      unit('body/h1-1/p-2', 'x'),
      unit('note/p-1', 'n'),
    ]
    const result = align(english, [
      t('fm/title', 'T!'),
      t('body/h1-1/title', 'Á'),
      t('body/h1-1/p-1', 'same'),
      t('body/h1-1/p-2', 'xx'),
    ])
    const accounted = [
      ...result.drafts.map((draft) => formatUnitId(draft.id)),
      ...result.misses.flatMap((miss) => miss.unitIds),
    ].sort()
    expect(accounted).toEqual(english.map((item) => formatUnitId(item.id)).sort())
  })
})
