/**
 * Protected-term integrity (spec 003 FR-004, ADR 0007).
 *
 * The manifest's `protectedTerms` are API kinds, tool names and product names that must
 * reach every locale exactly as English spells them — `kubectl`, `Pod`, `Gateway API`.
 * The gate is presence, not count: every term the English unit uses must appear
 * unaltered in the translation at least once. Counting would reject honest German that
 * merges two mentions into one sentence; presence still catches the failures that
 * matter — a translated, re-cased or dropped term.
 *
 * Matching is case-sensitive and whole-word at each edge of the term that is itself a
 * word character, so `Pod` is not found inside `Podcast` (or `Pods`), while a term that
 * ends in punctuation (`C++`) and a hyphenated German compound (`Pod-Netzwerk`) both
 * work. "Word character" is Unicode-aware, so an umlaut counts as a letter.
 */

const WORD = /[\p{L}\p{N}_]/u

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function termPattern(term: string): RegExp {
  const first = term.charAt(0)
  const last = term.charAt(term.length - 1)
  const before = WORD.test(first) ? '(?<![\\p{L}\\p{N}_])' : ''
  const after = WORD.test(last) ? '(?![\\p{L}\\p{N}_])' : ''
  return new RegExp(`${before}${escapeRegExp(term)}${after}`, 'u')
}

/** True when `text` contains `term` under the matching rules above. */
export function containsTerm(text: string, term: string): boolean {
  return termPattern(term).test(text)
}

/**
 * The protected terms the English unit uses that its translation does not carry, in
 * manifest order. Empty means the gate passes.
 */
export function missingProtectedTerms(
  english: string,
  translation: string,
  terms: readonly string[],
): readonly string[] {
  return terms.filter((term) => containsTerm(english, term) && !containsTerm(translation, term))
}
