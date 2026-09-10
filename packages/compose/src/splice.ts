/**
 * Splicing one file's planned replacements, with demotion instead of failure.
 *
 * Every unit arrives here at one of three stages: its translation, the marked English
 * fallback, or nothing (plain English). Two things can refuse a stage after planning:
 * the extractor's splice validation, and the output-side skeleton gate. Either way the
 * unit is **demoted one stage** — translation to marked fallback, marked fallback to
 * plain English — and the file is spliced again. Plain English is the source bytes, so
 * the loop always terminates, and it always terminates in a file that passed both.
 *
 * Demotion is how preview mode stays useful on hostile input; strict mode uses the same
 * loop and turns every translation demotion into an error, so nothing about the release
 * path depends on the demotion being correct — only on it being recorded.
 */

import { formatUnitId } from '@workshop-i18n/core'
import { quote } from './findings.js'
import { markFallback } from './marker.js'
import {
  compareSkeletons,
  type LocateContext,
  type LocatedFile,
  type LocatedHole,
  locateFile,
  SpliceRefusedError,
} from './surface.js'

/** What a unit is currently rendered as. */
export type SpliceStage = 'translation' | 'marker' | 'none'

/** One unit's plan: its hole, its stage, and the translation if it has one. */
export interface SplicePlan {
  readonly hole: LocatedHole
  stage: SpliceStage
  readonly translation: string | undefined
}

/** Why a unit was demoted, for the caller to turn into a finding. */
export interface Demotion {
  readonly id: string
  /** The stage the unit was demoted *from*. */
  readonly from: 'translation' | 'marker'
  readonly cause: 'unspliceable' | 'skeleton-mismatch'
  /** The extractor's refusal reason, for `unspliceable`. */
  readonly reason?: string
  readonly message: string
}

/** The outcome of splicing one file. */
export interface SpliceOutcome {
  readonly text: string
  /** {@link SpliceOutcome.text}, located afresh — the evidence the skeleton gate judged. */
  readonly located: LocatedFile
  readonly demotions: readonly Demotion[]
  /**
   * Set when the skeleton gate failed on a combination of units no single one of which
   * fails it alone; every unit was then demoted to plain English. Never expected — it is
   * the fail-closed answer to an interaction the per-unit search cannot attribute.
   */
  readonly unattributedMismatch?: { readonly line: number; readonly message: string }
}

function replacementOf(plan: SplicePlan): string | undefined {
  if (plan.stage === 'translation') return plan.translation
  if (plan.stage === 'marker') return markFallback(plan.hole.source)
  return undefined
}

function replacementsOf(plans: readonly SplicePlan[]): Map<string, string> {
  const replacements = new Map<string, string>()
  for (const plan of plans) {
    const text = replacementOf(plan)
    if (text !== undefined) replacements.set(formatUnitId(plan.hole.id), text)
  }
  return replacements
}

function demote(
  plan: SplicePlan,
  cause: Demotion['cause'],
  message: string,
  reason?: string,
): Demotion | undefined {
  if (plan.stage === 'none') return undefined
  const from = plan.stage
  plan.stage = from === 'translation' ? 'marker' : 'none'
  return {
    id: formatUnitId(plan.hole.id),
    from,
    cause,
    message,
    ...(reason === undefined ? {} : { reason }),
  }
}

/** Splice `replacements`, or return the extractor's refusals. */
function trySplice(
  located: LocatedFile,
  replacements: ReadonlyMap<string, string>,
): { readonly text: string } | { readonly refusals: SpliceRefusedError['refusals'] } {
  try {
    return { text: located.compose(replacements) }
  } catch (error) {
    if (error instanceof SpliceRefusedError) return { refusals: error.refusals }
    throw error
  }
}

/** True when `text` passes the skeleton gate against `located`. */
function skeletonHolds(located: LocatedFile, text: string, context: LocateContext): boolean {
  return compareSkeletons(located, locateFile(located.surface, text, context)) === undefined
}

/**
 * Splice `plans` into `located`, demoting whatever the extractor or the skeleton gate
 * refuses until the file passes both. `plans` is mutated: each plan's final `stage` is
 * what was actually emitted.
 */
export function spliceWithDemotion(
  located: LocatedFile,
  plans: readonly SplicePlan[],
  context: LocateContext,
): SpliceOutcome {
  const demotions: Demotion[] = []
  const byId = new Map(plans.map((plan) => [formatUnitId(plan.hole.id), plan]))

  for (;;) {
    const attempt = trySplice(located, replacementsOf(plans))
    if ('refusals' in attempt) {
      let demoted = false
      for (const refusal of attempt.refusals) {
        const plan = byId.get(refusal.id)
        if (plan === undefined) continue
        const demotion = demote(plan, 'unspliceable', refusal.message, refusal.reason)
        if (demotion !== undefined) {
          demotions.push(demotion)
          demoted = true
        }
      }
      // A refusal naming no planned unit cannot be resolved by demotion; that is a bug in
      // the extractor contract, and looping on it would never end.
      if (!demoted)
        throw new Error(
          `splice refused without naming a planned unit: ${quote(String(attempt.refusals[0]?.message))}`,
        )
      continue
    }

    const composed = locateFile(located.surface, attempt.text, context)
    const mismatch = compareSkeletons(located, composed)
    if (mismatch === undefined) return { text: attempt.text, located: composed, demotions }

    // Attribute the mismatch: splice each replacement on its own and keep the ones that
    // fail alone. Only runs when the gate already failed, so the common path pays nothing.
    const culprits = plans.filter((plan) => {
      const text = replacementOf(plan)
      if (text === undefined) return false
      const single = trySplice(located, new Map([[formatUnitId(plan.hole.id), text]]))
      return 'refusals' in single || !skeletonHolds(located, single.text, context)
    })
    if (culprits.length === 0) {
      for (const plan of plans) plan.stage = 'none'
      return { text: located.source, located, demotions, unattributedMismatch: mismatch }
    }
    for (const plan of culprits) {
      const demotion = demote(
        plan,
        'skeleton-mismatch',
        plan.stage === 'translation'
          ? 'translation changes the structure around it (for example a blank line that splits the unit, or a line that starts a list or heading) — keep it to running text'
          : 'the fallback marker changes the structure around this unit',
      )
      if (demotion !== undefined) demotions.push(demotion)
    }
  }
}
