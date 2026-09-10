import { describe, expect, it } from 'vitest'
import { measureLength } from '../src/length.js'
import { missingProtectedTerms } from '../src/terms.js'

describe('missingProtectedTerms (FR-004 protected-term integrity)', () => {
  const terms = ['Pod', 'kubectl', 'Gateway API', 'C++']

  it('passes when every term the English uses survives unaltered', () => {
    expect(
      missingProtectedTerms(
        'A Pod is scheduled by kubectl apply.',
        'Ein Pod wird per kubectl apply geplant.',
        terms,
      ),
    ).toEqual([])
  })

  it('names a term the translation translated, re-cased or dropped', () => {
    expect(
      missingProtectedTerms(
        'Use the Gateway API from kubectl.',
        'Nutze die Gateway-API über Kubectl.',
        terms,
      ),
    ).toEqual(['kubectl', 'Gateway API'])
  })

  it('ignores terms the English unit does not use', () => {
    expect(missingProtectedTerms('Hello', 'Hallo', terms)).toEqual([])
  })

  it('matches whole words, so "Pods" in English does not demand "Pod"', () => {
    expect(missingProtectedTerms('Two Pods run.', 'Zwei Pods laufen.', terms)).toEqual([])
    expect(missingProtectedTerms('One Pod runs.', 'Ein Podcast läuft.', terms)).toEqual(['Pod'])
  })

  it('accepts a term glued to non-word punctuation, as in a German compound with a hyphen', () => {
    expect(missingProtectedTerms('The Pod network', 'Das Pod-Netzwerk', terms)).toEqual([])
  })

  it('handles terms that end in punctuation', () => {
    expect(
      missingProtectedTerms('Written in C++ today', 'Heute in C++ geschrieben', terms),
    ).toEqual([])
    expect(missingProtectedTerms('Written in C++ today', 'Heute in C geschrieben', terms)).toEqual([
      'C++',
    ])
  })
})

describe('measureLength (ADR 0009 length-budget heuristic)', () => {
  it('reports the target/source ratio in code points, not UTF-16 units', () => {
    const result = measureLength('abcd', '🚀🚀🚀🚀🚀', 1.4)
    expect(result.ratio).toBe(1.25)
    expect(result.exceeded).toBe(false)
  })

  it('flags a translation over budget', () => {
    const result = measureLength('Short text', 'Ein deutlich längerer deutscher Text', 1.35)
    expect(result.exceeded).toBe(true)
    expect(result.budget).toBe(1.35)
  })

  it('treats exactly-at-budget as within budget', () => {
    expect(measureLength('abcdefghij', 'abcdefghijklmn', 1.4).exceeded).toBe(false)
  })
})
