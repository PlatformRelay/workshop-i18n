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
 *   what the page *does* (a new tag, a Vue interpolation, a comment that could end a
 *   speaker note), or its length says it is almost certainly not this unit's text.
 * - **Warnings** (`code-span-divergence`, `link-divergence`) — translators legitimately
 *   rephrase around inline code and point links at localized docs. Refusing those would
 *   discard good work; the draft carries the warning into the report instead.
 */

import type { SeedLimits, SeedMissReason, SeedWarningCode } from './types.js'

/** Outcome of {@link checkTranslation}. */
export interface TranslationCheck {
  /** Set when the pair must not be seeded. */
  readonly miss: SeedMissReason | undefined
  readonly warnings: readonly SeedWarningCode[]
}

/** An HTML/Vue tag opener or closer, or an HTML comment opener. */
const TAG = /<(!--|\/?\s*[A-Za-z][A-Za-z0-9:_.-]*)/g
const MUSTACHE = /\{\{/g
/** An inline code span: a backtick run, content, and a run of the same length. */
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g
/** An inline link or image target. */
const LINK_TARGET = /\]\(\s*([^)\s]+)/g

function tagNames(text: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of text.matchAll(TAG)) {
    names.add((match[1] ?? '').replace(/^\/\s*/, '').toLowerCase())
  }
  return names
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function multiset(text: string, pattern: RegExp, group: number): string {
  return [...text.matchAll(pattern)]
    .map((match) => match[group] ?? '')
    .sort()
    .join('\u0000')
}

/** True when `translation` introduces markup `source` does not carry. */
export function hasMarkupDivergence(source: string, translation: string): boolean {
  const allowed = tagNames(source)
  for (const name of tagNames(translation)) {
    if (!allowed.has(name)) return true
  }
  return count(translation, MUSTACHE) > count(source, MUSTACHE)
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
  if (multiset(source, CODE_SPAN, 2) !== multiset(translation, CODE_SPAN, 2)) {
    warnings.push('code-span-divergence')
  }
  if (multiset(source, LINK_TARGET, 1) !== multiset(translation, LINK_TARGET, 1)) {
    warnings.push('link-divergence')
  }
  return { miss: undefined, warnings }
}
