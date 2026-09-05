import { formatUnitId } from '@workshop-i18n/core'
import { describe, expect, it } from 'vitest'
import { extractLabFile, LabExtractionError, locateLabFile } from '../src/extract.js'
import { composeSkeleton } from '../src/skeleton.js'

const LAB = [
  '# Lab 05 — Pod (S05)',
  '',
  '<!-- labId: day-1-05-pod -->',
  '',
  '## Objective',
  '',
  'Author, run, and delete a **Pod**.',
  '',
  '```bash',
  "cat > pod.yaml <<'EOF'",
  'apiVersion: v1',
  '---',
  'kind: Service',
  'EOF',
  '```',
  '',
  '<details><summary>Solution / expected output</summary>',
  '',
  'The selector no longer matches.',
  '',
  '</details>',
  '',
].join('\n')

describe('extractLabFile', () => {
  const extraction = extractLabFile(LAB)

  it('addresses every unit as labs:<labId>:<unitKey>', () => {
    expect(extraction.labId).toBe('day-1-05-pod')
    expect(extraction.units.map((unit) => formatUnitId(unit.id))).toEqual([
      'labs:day-1-05-pod:body/h1-1/h2-1/html-1/summary-1',
      'labs:day-1-05-pod:body/h1-1/h2-1/p-1',
      'labs:day-1-05-pod:body/h1-1/h2-1/p-2',
      'labs:day-1-05-pod:body/h1-1/h2-1/title',
      'labs:day-1-05-pod:body/h1-1/title',
    ])
  })

  it('anchors every unit on a source hash', () => {
    expect(extraction.units.every((unit) => unit.sourceHash.startsWith('sha256:'))).toBe(true)
  })

  it('never emits the heredoc or its document separator as translatable text', () => {
    const all = extraction.units.map((unit) => unit.source).join('\n')
    expect(all).not.toContain('apiVersion')
    expect(all).not.toContain('EOF')
    expect(all).not.toContain('---')
  })

  it('reproduces the file byte-for-byte from an empty catalog', () => {
    expect(composeSkeleton(extraction.skeleton, {})).toBe(LAB)
  })

  it('leaves the fence byte-identical when every unit is translated', () => {
    const translations = Object.fromEntries(
      extraction.units.map((unit, index) => [formatUnitId(unit.id), `uebersetzt-${index}`]),
    )
    const composed = composeSkeleton(extraction.skeleton, translations)
    expect(composed).toContain("cat > pod.yaml <<'EOF'\napiVersion: v1\n---\nkind: Service\nEOF")
    expect(composed).toContain('<details><summary>uebersetzt-0</summary>')
    expect(composed).not.toBe(LAB)
  })

  it('is deterministic', () => {
    expect(extractLabFile(LAB)).toEqual(extractLabFile(LAB))
  })

  it('fails closed when the lab carries no identity', () => {
    const orphan = '# Lab 05\n\nProse.\n'
    expect(() => extractLabFile(orphan, 'labs/day-1/05-pod.md')).toThrow(LabExtractionError)
    expect(() => extractLabFile(orphan, 'labs/day-1/05-pod.md')).toThrow(/labs\/day-1\/05-pod\.md/)
    expect(() => extractLabFile(orphan)).toThrow(/init-ids/)
  })

  it('fails closed when the identity is unsafe', () => {
    expect(() => extractLabFile('<!-- labId: ../escape -->\n\nProse.\n')).toThrow(
      LabExtractionError,
    )
  })

  it('fails closed when two markers disagree', () => {
    expect(() => extractLabFile('<!-- labId: a -->\n\n<!-- labId: b -->\n\nProse.\n')).toThrow(
      LabExtractionError,
    )
  })
})

describe('locateLabFile', () => {
  it('reports rather than throws, and still reproduces a refused file byte-for-byte', () => {
    const orphan = '# Lab 05\n\nProse.\n'
    const located = locateLabFile(orphan)
    expect(located.diagnostics.map((item) => item.code)).toEqual(['missing-lab-id'])
    expect(located.units).toEqual([])
    expect(composeSkeleton(located.skeleton, {})).toBe(orphan)
  })

  it('surfaces a coverage gap as a warning without failing extraction', () => {
    const source = '<!-- labId: x -->\n\n<div>\n  Trapped prose that nobody translates.\n</div>\n'
    const located = locateLabFile(source)
    expect(located.diagnostics.map((item) => item.code)).toEqual(['prose-in-html-block'])
    expect(() => extractLabFile(source)).not.toThrow()
  })
})
