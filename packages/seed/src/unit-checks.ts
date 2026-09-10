/**
 * Per-unit checks on an aligned pair: is this translated string safe and plausible to
 * offer as a draft of that English unit?
 *
 * The translated tree is untrusted input. Alignment can only establish *where* a string
 * belongs; these checks decide whether the string itself is something a reviewer should
 * be handed. They are deliberately a first line, not the gate: `compose`/`verify` own
 * the hard markup and fence-identity gates on everything that ships. What this refuses
 * never reaches a catalog, so a reviewer skimming a Weblate queue cannot accept it by
 * accident.
 *
 * Two tiers, on purpose:
 *
 * - **Refusals** (`markup-divergence`, `length-divergence`, …) — the string would change
 *   what the page *does* (a tag, attribute or Vue directive the English does not carry, a
 *   `{{ }}` interpolation, a comment that could end a speaker note, a `javascript:` or
 *   `data:` link), or its length says it is almost certainly not this unit's text.
 * - **Warnings** (`code-span-divergence`, `link-divergence`) — translators legitimately
 *   rephrase around inline code and point links at localized docs. Refusing those would
 *   discard good work; the draft carries the warning into the report instead.
 */

import { findCodeSpans, findMustaches } from './inline-scan.js'
import type { SeedLimits, SeedMissReason, SeedWarningCode } from './types.js'

/** Outcome of {@link checkTranslation}. */
export interface TranslationCheck {
  /** Set when the pair must not be seeded. */
  readonly miss: SeedMissReason | undefined
  readonly warnings: readonly SeedWarningCode[]
}

/**
 * An HTML/Vue tag opener or closer (a letter must follow `<` or `</`, as in HTML, so a
 * comparison like `a < b` is not a tag), an autolink, or an HTML comment opener.
 */
const TAG = /<!--|<\/?[A-Za-z][^<>]*>?/g
/** An inline link or image target. */
const LINK_TARGET = /\]\(\s*([^)\s]+)/g
/** URL schemes that execute or embed rather than navigate. */
const ACTIVE_SCHEME = /^\s*(?:javascript|vbscript|data|file):/i

/** Tags and interpolations are compared by their whole text, whitespace-collapsed. */
function tokens(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0].replace(/\s+/g, ' ').toLowerCase())
}

/** True when every token of `theirs` occurs in `ours` at least as often. */
function isSubMultiset(theirs: readonly string[], ours: readonly string[]): boolean {
  const budget = new Map<string, number>()
  for (const token of ours) budget.set(token, (budget.get(token) ?? 0) + 1)
  for (const token of theirs) {
    const left = budget.get(token) ?? 0
    if (left === 0) return false
    budget.set(token, left - 1)
  }
  return true
}

function multiset(text: string, pattern: RegExp, group: number): string {
  return [...text.matchAll(pattern)]
    .map((match) => match[group] ?? '')
    .sort()
    .join('\u0000')
}

/** True when `translation` introduces markup `source` does not carry. */
export function hasMarkupDivergence(source: string, translation: string): boolean {
  // Tags are compared whole: an attribute or a Vue directive added to a tag the English
  // already has changes what the page does as much as a new tag would.
  if (!isSubMultiset(tokens(translation, TAG), tokens(source, TAG))) return true
  const ours = findMustaches(source)
  const theirs = findMustaches(translation)
  const normal = (list: readonly string[]) => list.map((token) => token.replace(/\s+/g, ' '))
  if (!isSubMultiset(normal(theirs.complete), normal(ours.complete))) return true
  if (theirs.openers > ours.openers) return true
  const ourTargets = new Set([...source.matchAll(LINK_TARGET)].map((match) => match[1]))
  return [...translation.matchAll(LINK_TARGET)].some(
    (match) => ACTIVE_SCHEME.test(match[1] ?? '') && !ourTargets.has(match[1]),
  )
}

/**
 * Decide whether `translation` may be offered as a draft of `source`.
 *
 * Pure and total: any pair of strings yields a result, and nothing in either string is
 * interpreted beyond pattern matching.
 */
export function checkTranslation(
  source: string,
  translation: string,
  limits: SeedLimits,
): TranslationCheck {
  const refuse = (miss: SeedMissReason): TranslationCheck => ({ miss, warnings: [] })
  if (translation === '') return refuse('empty-translation')
  if (translation === source) return refuse('identical-to-source')
  if (translation.length > limits.lengthRatio * source.length + limits.lengthSlack) {
    return refuse('length-divergence')
  }
  if (hasMarkupDivergence(source, translation)) return refuse('markup-divergence')

  const warnings: SeedWarningCode[] = []
  const spans = (text: string) =>
    findCodeSpans(text)
      .map((span) => span.content)
      .sort()
      .join('\u0000')
  if (spans(source) !== spans(translation)) {
    warnings.push('code-span-divergence')
  }
  if (multiset(source, LINK_TARGET, 1) !== multiset(translation, LINK_TARGET, 1)) {
    warnings.push('link-divergence')
  }
  return { miss: undefined, warnings }
}
