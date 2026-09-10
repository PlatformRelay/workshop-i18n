/**
 * The demotion loop's two defensive paths, which no well-behaved extractor reaches: a
 * marker that cannot be placed, and a skeleton failure no single unit explains. Both are
 * driven by wrapping a real located file, so everything but the injected fault is real.
 */

import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { FALLBACK_MARKER } from '../src/marker.js'
import { type SplicePlan, spliceWithDemotion } from '../src/splice.js'
import { type LocatedFile, locateFile, SpliceRefusedError } from '../src/surface.js'
import { DECK } from './helpers.js'

const located = locateFile('slides', DECK)

function plansFor(stage: SplicePlan['stage']): SplicePlan[] {
  return located.holes.map((hole) => ({ hole, stage, translation: `DE ${hole.source}` }))
}

describe('spliceWithDemotion', () => {
  it('passes a clean plan through untouched', () => {
    const plans = plansFor('translation')
    const outcome = spliceWithDemotion(located, plans, {})
    expect(outcome.demotions).toEqual([])
    expect(plans.every((plan) => plan.stage === 'translation')).toBe(true)
    expect(outcome.text).toContain('# DE Second slide')
  })

  it('demotes a marker the extractor refuses to plain English, and says so', () => {
    const victim = 'slides:second:body/h1-1/title'
    const refusing: LocatedFile = {
      ...located,
      compose: (replacements) => {
        if (replacements.get(victim)?.startsWith(FALLBACK_MARKER)) {
          throw new SpliceRefusedError([{ id: victim, reason: 'test', message: 'refused' }])
        }
        return located.compose(replacements)
      },
    }
    const plans = plansFor('marker')
    const outcome = spliceWithDemotion(refusing, plans, {})
    expect(outcome.demotions).toEqual([
      { id: victim, from: 'marker', cause: 'unspliceable', reason: 'test', message: 'refused' },
    ])
    expect(plans.find((plan) => formatUnitId(plan.hole.id) === victim)?.stage).toBe('none')
    expect(outcome.text).toContain('\n# Second slide\n')
    expect(outcome.text).toContain(`${FALLBACK_MARKER}A Pod is the smallest unit.`)
  })

  it('falls back to the English file when a mismatch needs two units together', () => {
    // An injected interaction: the file only breaks when both replacements are present.
    const [first, second] = located.holes.slice(0, 2).map((hole) => formatUnitId(hole.id))
    const interacting: LocatedFile = {
      ...located,
      compose: (replacements) => {
        const text = located.compose(replacements)
        return replacements.has(first ?? '') && replacements.has(second ?? '')
          ? `${text}<script>x</script>\n`
          : text
      },
    }
    const plans = plansFor('translation')
    const outcome = spliceWithDemotion(interacting, plans, {})
    expect(outcome.text).toBe(DECK)
    expect(outcome.unattributedMismatch).toBeDefined()
    expect(plans.every((plan) => plan.stage === 'none')).toBe(true)
  })
})
