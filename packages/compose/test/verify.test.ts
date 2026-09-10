/**
 * `verifyComposedFile`: the gates run on a composed file the verifier did not produce —
 * the shape a `workshop-i18n verify` over a generated tree takes (spec 003 FR-004).
 */

import { describe, expect, it } from 'vitest'
import { markFallback } from '../src/marker.js'
import { locateFile } from '../src/surface.js'
import { verifyComposedFile } from '../src/verify.js'
import { DECK, LAB, MANIFEST } from './helpers.js'

/** Compose by hand, through the extractor, so the verifier is judged independently. */
function composeDeck(replacements: Record<string, string>): string {
  return locateFile('slides', DECK).compose(new Map(Object.entries(replacements)))
}

function verifyDeck(composed: string, mode: 'preview' | 'strict' = 'preview') {
  return verifyComposedFile({
    manifest: MANIFEST,
    path: 'slides/intro.md',
    surface: 'slides',
    english: DECK,
    composed,
    mode,
  })
}

describe('verifyComposedFile', () => {
  it('passes the untouched English, reporting every unit as source', () => {
    const result = verifyDeck(DECK)
    expect(result.findings).toEqual([])
    expect(new Set(result.units.map((unit) => unit.rendering))).toEqual(new Set(['source']))
  })

  it('passes a clean translation and classifies it', () => {
    const result = verifyDeck(composeDeck({ 'slides:second:body/h1-1/title': 'Zweite Folie' }))
    expect(result.findings).toEqual([])
    expect(result.units).toContainEqual({
      id: 'slides:second:body/h1-1/title',
      rendering: 'translation',
    })
  })

  it('recognizes a marked fallback, and refuses it in release output', () => {
    const composed = composeDeck({
      'slides:second:body/h1-1/title': markFallback('Second slide'),
    })
    expect(verifyDeck(composed).findings).toEqual([])
    expect(verifyDeck(composed).units).toContainEqual({
      id: 'slides:second:body/h1-1/title',
      rendering: 'fallback',
    })
    expect(verifyDeck(composed, 'strict').findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'fallback-in-release',
        unitId: 'slides:second:body/h1-1/title',
      }),
    ])
  })

  it('fails a hand-edited generated file whose translation adds a script', () => {
    const composed = composeDeck({
      'slides:second:body/h1-1/p-1':
        'Führe `kubectl apply` im <v-click>Lab</v-click> aus. <script>alert(1)</script>',
    })
    const findings = verifyDeck(composed).findings.filter((item) => item.severity === 'error')
    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'markup-parity',
        unitId: 'slides:second:body/h1-1/p-1',
      }),
    ])
    expect(findings[0]?.message).toMatch(/<script>/)
  })

  it('fails a translation that drops a protected term', () => {
    const findings = verifyDeck(
      composeDeck({ 'slides:intro:body/p-1': 'Eine Kapsel ist die kleinste Einheit.' }),
    ).findings.filter((item) => item.severity === 'error')
    expect(findings).toEqual([
      expect.objectContaining({ severity: 'error', code: 'protected-term' }),
    ])
    expect(findings[0]?.message).toMatch(/"Pod"/)
  })

  it('warns when a translation exceeds its layout budget, naming the layout', () => {
    const findings = verifyDeck(
      composeDeck({ 'slides:intro:fm/heading': 'Herzlich willkommen im Kubernetes-Workshop' }),
    ).findings
    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'length-budget',
        unitId: 'slides:intro:fm/heading',
      }),
    ])
    expect(findings[0]?.message).toMatch(/"statement" \(1\.2\)/)
  })

  it('uses the default budget on a slide without a configured layout', () => {
    // 1.33x: over the statement budget, within the default 1.4.
    const findings = verifyDeck(
      composeDeck({ 'slides:second:body/h1-1/title': 'Zweite Folie!!!!' }),
    ).findings
    expect(findings).toEqual([])
  })

  it('fails a generated file whose fence was edited, naming the line', () => {
    const tampered = DECK.replace('kubectl get pods', 'kubectl delete pods --all')
    expect(verifyDeck(tampered).findings).toEqual([
      expect.objectContaining({ severity: 'error', code: 'skeleton-mismatch', line: 10 }),
    ])
  })

  it('does not apply the slide length budget to labs', () => {
    const lab = locateFile('labs', LAB)
    const id = 'labs:lab-one:body/h1-1/p-1'
    expect(lab.holes.map((hole) => hole.id.unitKey)).toContain('body/h1-1/p-1')
    const composed = lab.compose(
      new Map([[id, 'Erledige die Sache mit kubectl, ausführlich und sehr gründlich erklärt.']]),
    )
    const result = verifyComposedFile({
      manifest: MANIFEST,
      path: 'labs/one.md',
      surface: 'labs',
      english: LAB,
      composed,
    })
    expect(result.findings).toEqual([])
  })

  it('reports an English source that cannot be extracted', () => {
    const broken = DECK.replace('slideId: second\n', '')
    const result = verifyComposedFile({
      manifest: MANIFEST,
      path: 'slides/intro.md',
      surface: 'slides',
      english: broken,
      composed: broken,
    })
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'extraction',
        detail: 'missing-slide-id',
      }),
    )
  })
})
