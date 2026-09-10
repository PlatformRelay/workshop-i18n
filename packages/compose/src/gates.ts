/**
 * The per-unit gates (spec 003 FR-004), assembled in one place so `compose` and `verify`
 * judge a translation by exactly the same rules.
 *
 * Content gates — markup parity and protected terms — decide whether a translation may
 * be emitted at all. The length budget never decides that; it only asks a human to look.
 */

import { quote } from './findings.js'
import { measureLength } from './length.js'
import { checkMarkupParity, type MarkupToken } from './markup.js'
import { missingProtectedTerms } from './terms.js'

/** A content gate a translation failed. */
export interface ContentGateFailure {
  readonly code: 'markup-parity' | 'protected-term'
  readonly message: string
}

function describeTokens(tokens: readonly MarkupToken[]): string {
  return tokens.map((token) => `${token.kind} ${quote(token.text)}`).join(', ')
}

/**
 * Every content gate `translation` fails against `english`, in a fixed order. Empty
 * means the translation may be emitted.
 */
export function contentGateFailures(
  english: string,
  translation: string,
  protectedTerms: readonly string[],
): readonly ContentGateFailure[] {
  const failures: ContentGateFailure[] = []
  const parity = checkMarkupParity(english, translation)
  if (!parity.ok) {
    const parts: string[] = []
    if (parity.added.length > 0) parts.push(`adds ${describeTokens(parity.added)}`)
    if (parity.removed.length > 0) parts.push(`drops ${describeTokens(parity.removed)}`)
    failures.push({
      code: 'markup-parity',
      message: `translation ${parts.join(' and ')}; code spans, tags, {{ }} expressions, URLs and character references must match the English exactly`,
    })
  }
  const missing = missingProtectedTerms(english, translation, protectedTerms)
  if (missing.length > 0) {
    failures.push({
      code: 'protected-term',
      message: `translation is missing protected term${missing.length === 1 ? '' : 's'} ${missing.map((term) => quote(term)).join(', ')}, which must appear exactly as in English`,
    })
  }
  return failures
}

/** A length-budget warning message, or `undefined` when the translation is within budget. */
export function lengthBudgetWarning(
  english: string,
  translation: string,
  budget: number,
  layout: string | undefined,
): string | undefined {
  const measured = measureLength(english, translation, budget)
  if (!measured.exceeded) return undefined
  const where =
    layout === undefined ? 'the default budget' : `the budget for layout ${quote(layout)}`
  return `translation is ${measured.ratio.toFixed(2)}× the English length, over ${where} (${budget}); the slide may overflow — shorten it or split the slide`
}
