import { isUnitState, type UnitState } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import type { CatalogIdentity, PoComment, PoEntry } from '../src/index.js'
import {
  FUZZY_FLAG,
  NEEDS_REVIEW_FLAG,
  parseCatalog,
  serializePo,
  toCatalogEntry,
  unitStateOf,
} from '../src/index.js'

/**
 * The two invariants constitution V actually rests on, defended as properties rather
 * than as a list of strings.
 *
 * An enumeration of flags that must not promote only defends the flags someone thought
 * of: a promotion keyed on `qa-passed`, or on the *text of a comment*, walks straight
 * through it. And pinning the rule in `unitStateOf` is not enough on its own, because
 * `toCatalogEntry` is a second producer of the same value — a promotion injected there
 * bypasses the mapping entirely and every state test with it.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/**
 * Deliberately loaded with strings a careless implementation might treat as permission,
 * in several spellings and casings, plus ordinary format flags and random tokens. None
 * of them may change the answer.
 */
const FLAG_POOL = [
  'approved',
  'qa-passed',
  'reviewed',
  'accepted',
  'signed-off',
  'sign-off',
  'verified',
  'final',
  'ok',
  'no-review',
  'skip-review',
  'APPROVED',
  'Approved',
  'approved!',
  'weblate-approved',
  'needs-review-done',
  'c-format',
  'python-brace-format',
  'max-length:80',
  'ignore-check',
]

const COMMENT_POOL: readonly PoComment[] = [
  { marker: '', text: ' approved by QA on the 2026-08 pass' },
  { marker: '', text: ' required: false' },
  { marker: '.', text: ' state: reviewed' },
  { marker: '.', text: ' approved' },
  { marker: ':', text: ' approved.md:1' },
  { marker: '', text: ' fuzzy' },
]

function randomToken(random: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz-_0123456789'
  const length = 1 + Math.floor(random() * 12)
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? 'a'
  }
  return out
}

function randomNoise(random: () => number): string[] {
  const count = Math.floor(random() * 4)
  return Array.from({ length: count }, () => {
    const pick = random()
    if (pick < 0.7) return FLAG_POOL[Math.floor(random() * FLAG_POOL.length)] ?? 'approved'
    return randomToken(random)
  })
}

function randomComments(random: () => number): PoComment[] {
  const count = Math.floor(random() * 3)
  return Array.from(
    { length: count },
    () => COMMENT_POOL[Math.floor(random() * COMMENT_POOL.length)] ?? COMMENT_POOL[0],
  ).filter((comment): comment is PoComment => comment !== undefined)
}

function entry(
  flags: readonly string[],
  msgstr: readonly string[],
  comments: PoComment[],
): PoEntry {
  return {
    comments,
    flags,
    msgctxt: 'slides:s01:body/1',
    msgid: 'A Pod.',
    msgstr,
    obsolete: false,
    line: 0,
  }
}

/** Shuffle so the gating flag is never reliably first or last. */
function shuffled(values: readonly string[], random: () => number): string[] {
  const out = [...values]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const a = out[index]
    const b = out[swap]
    if (a !== undefined && b !== undefined) {
      out[index] = b
      out[swap] = a
    }
  }
  return out
}

describe('unitStateOf — the promotion invariant, as a property', () => {
  const CASES = 400

  it('never promotes a needs-review entry, whatever else is on it', () => {
    const random = makeRandom(20260905)
    for (let index = 0; index < CASES; index += 1) {
      const noise = randomNoise(random).filter((flag) => flag !== FUZZY_FLAG)
      const flags = shuffled([...noise, NEEDS_REVIEW_FLAG], random)
      const comments = randomComments(random)
      const state = unitStateOf(entry(flags, ['Eine Übersetzung.'], comments))
      expect(state, `flags [${flags.join(', ')}]`).toBe('needs-review')
    }
  })

  it('never promotes a fuzzy entry, whatever else is on it', () => {
    const random = makeRandom(777)
    for (let index = 0; index < CASES; index += 1) {
      const flags = shuffled([...randomNoise(random), FUZZY_FLAG], random)
      const comments = randomComments(random)
      const state = unitStateOf(entry(flags, ['Eine Übersetzung.'], comments))
      expect(state, `flags [${flags.join(', ')}]`).toBe('fuzzy')
    }
  })

  it('never invents a translation for an empty msgstr, whatever else is on it', () => {
    const random = makeRandom(31337)
    for (let index = 0; index < CASES; index += 1) {
      const flags = shuffled(randomNoise(random), random)
      const state = unitStateOf(entry(flags, [''], randomComments(random)))
      expect(state, `flags [${flags.join(', ')}]`).toBe('missing')
    }
  })

  it('reaches reviewed exactly when no gating flag is present', () => {
    const random = makeRandom(4242)
    for (let index = 0; index < CASES; index += 1) {
      const flags = shuffled(
        randomNoise(random).filter((flag) => flag !== FUZZY_FLAG && flag !== NEEDS_REVIEW_FLAG),
        random,
      )
      const state = unitStateOf(entry(flags, ['Eine Übersetzung.'], randomComments(random)))
      expect(state, `flags [${flags.join(', ')}]`).toBe('reviewed')
      expect(isUnitState(state)).toBe(true)
    }
  })
})

describe('toCatalogEntry — the second state producer', () => {
  /**
   * `CatalogEntry.state` is what every consumer reads; `unitStateOf` is only where the
   * rule is written down. Nothing forced the two to agree, so a promotion injected into
   * `toCatalogEntry` bypassed `state.ts` and the whole state suite with it. This is the
   * seam, pinned directly.
   */
  it('never disagrees with unitStateOf, for any entry', () => {
    const random = makeRandom(9001)
    for (let index = 0; index < 400; index += 1) {
      const flags = shuffled(randomNoise(random), random)
      const msgstr = random() < 0.5 ? [''] : ['Eine Übersetzung.']
      const po = entry(flags, msgstr, randomComments(random))
      const view = toCatalogEntry(po, {
        surface: 'slides',
        containerId: 's01',
        unitKey: 'body/1',
      })
      expect(view.state, `flags [${flags.join(', ')}]`).toBe(unitStateOf(po))
    }
  })

  it('agrees with unitStateOf for every entry of a catalog read from bytes', () => {
    const identity: CatalogIdentity = { locale: 'de', name: '03-pods' }
    const random = makeRandom(5150)
    const header: PoEntry = {
      comments: [],
      flags: [],
      msgctxt: undefined,
      msgid: '',
      msgstr: ['Language: de\nContent-Type: text/plain; charset=UTF-8\n'],
      obsolete: false,
      line: 0,
    }
    const entries: PoEntry[] = [header]
    for (let index = 0; index < 60; index += 1) {
      const flags = shuffled(randomNoise(random), random)
      const gate = random()
      if (gate < 0.33) flags.push(NEEDS_REVIEW_FLAG)
      else if (gate < 0.66) flags.push(FUZZY_FLAG)
      entries.push({
        comments: randomComments(random),
        flags,
        msgctxt: `slides:s${String(index).padStart(3, '0')}:body/1`,
        msgid: `English ${index}`,
        msgstr: random() < 0.4 ? [''] : [`Deutsch ${index}`],
        obsolete: false,
        line: 0,
      })
    }
    const catalog = parseCatalog(serializePo({ entries }), {
      identity,
      fileName: 'i18n/de/03-pods.po',
    })
    expect(catalog.entries).toHaveLength(60)
    const states = new Set<UnitState>()
    for (const view of catalog.entries) {
      expect(view.state, `entry ${view.id.containerId}`).toBe(unitStateOf(view.po))
      states.add(view.state)
    }
    // The corpus must actually exercise the gated states, or the equality is vacuous.
    expect(states.has('needs-review')).toBe(true)
    expect(states.has('fuzzy')).toBe(true)
  })
})
