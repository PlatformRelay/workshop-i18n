import { describe, expect, it } from 'vitest'
import {
  createTranslationUnit,
  isUnitState,
  parseUnitId,
  sourceHash,
  UNIT_STATES,
  UnitIdError,
} from '../src/index.js'

describe('unit states', () => {
  it('lists every state worst-to-best', () => {
    expect(UNIT_STATES).toEqual(['missing', 'fuzzy', 'needs-review', 'reviewed'])
  })

  it('guards states read out of a catalog or JSON', () => {
    expect(isUnitState('needs-review')).toBe(true)
    expect(isUnitState('translated')).toBe(false)
    expect(isUnitState(undefined)).toBe(false)
  })
})

describe('createTranslationUnit', () => {
  const id = parseUnitId('slides:s01-pods:body/1')

  it('anchors the unit on the hash of its exact source', () => {
    const unit = createTranslationUnit(id, 'A Pod is a group of containers.')
    expect(unit).toEqual({
      id,
      source: 'A Pod is a group of containers.',
      sourceHash: sourceHash('A Pod is a group of containers.'),
    })
  })

  it('refuses an unsafe identity — extraction is where hostile ids get caught', () => {
    expect(() => createTranslationUnit({ ...id, containerId: '../etc' }, 'text')).toThrow(
      UnitIdError,
    )
  })
})
