/**
 * The length-budget heuristic (ADR 0009, spec 003 FR-004): the cheap overflow tier.
 *
 * A translation noticeably longer than its English is the most common way a localized
 * slide overflows a tight layout. Rendering every click state to find out is deferred
 * (ADR 0009), so this measures the target/source ratio and flags it against the budget
 * the manifest declares for the slide's layout (`lengthBudgetFor`). It is a warning, not
 * an error: it will both miss real overflow and flag slides that fit, and visual PR
 * review of the composed deck is what bounds that residual risk.
 *
 * Lengths are counted in code points, so an emoji is one character rather than two
 * UTF-16 units. CJK and RTL semantics are explicitly out of scope for v1 (spec 003).
 */

/** One measurement. */
export interface LengthMeasurement {
  /** Code points in the translation divided by code points in the English. */
  readonly ratio: number
  readonly budget: number
  /** True when {@link LengthMeasurement.ratio} is strictly greater than the budget. */
  readonly exceeded: boolean
}

function codePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Measure `translation` against `english` under `budget`. */
export function measureLength(
  english: string,
  translation: string,
  budget: number,
): LengthMeasurement {
  const source = codePoints(english)
  const target = codePoints(translation)
  const ratio = source === 0 ? (target === 0 ? 1 : Number.POSITIVE_INFINITY) : target / source
  return { ratio, budget, exceeded: ratio > budget }
}
