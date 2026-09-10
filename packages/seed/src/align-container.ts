/**
 * Aligning one container's units: "unit position within matched containers" (spec 004
 * FR-001), made precise enough to refuse rather than guess.
 *
 * By the time this runs the container itself is already matched — a slide paired by its
 * transplanted `slideId`, a lab by its `labId`, a quiz question by its explicit id — and
 * both sides have been through the *same* extractor, so both carry structural unit keys
 * (`body/h1-1/l-2/li-3/p-1`). The question is which keys may be paired.
 *
 * ## Why not simply "same key, same unit"
 *
 * ADR 0005's amendment spells out that keys are ordinal within a heading scope: a block
 * inserted into a scope re-keys its later siblings, and a heading inserted anywhere
 * re-keys every later scope *and everything nested under it*. So a key that exists on
 * both sides is not evidence the two texts correspond — after an inserted heading,
 * translated `body/h1-3/p-1` holds what English calls `body/h1-2/p-1`, and plain key
 * equality would seed each section's prose into its neighbour.
 *
 * ## The rule
 *
 * 1. Units are grouped into **roots**: each frontmatter field is its own root, and the
 *    slide body and speaker note are one root each (their counters are independent, so a
 *    divergence in the note cannot re-key the body).
 * 2. Within a markdown root, the **heading skeleton** must be identical — the same set of
 *    heading scopes on both sides. If it is not, every scope after the divergence may be
 *    re-keyed, and nothing in the keys says which; the whole root is missed.
 * 3. With the heading skeleton fixed, each **scope** (the units whose innermost heading
 *    is the same) is compared as a set of keys. A block inserted or removed only re-keys
 *    siblings in its own scope, so an equal key set means the scope's blocks line up, and
 *    an unequal one misses that scope alone.
 *
 * The residue is a translator who restructures a scope without changing its key set —
 * merging two paragraphs and splitting a third. Structure cannot see that; the per-unit
 * code-span and link warnings often can, and every draft is `needs-review` regardless.
 */

import { formatUnitId, type TranslationUnit } from '@workshop-i18n/core'
import {
  SEED_MISS_REASONS,
  type SeedDraft,
  type SeedLimits,
  type SeedMiss,
  type SeedMissReason,
} from './types.js'
import { checkTranslation } from './unit-checks.js'

/** A translated unit: only its structural key and text matter; its container id is not trusted. */
export interface TranslatedUnit {
  readonly unitKey: string
  readonly source: string
}

/** Drafts and misses for one container. */
export interface ContainerAlignment {
  /** In the order the English units were given. */
  readonly drafts: readonly SeedDraft[]
  /** At most one miss per reason, in {@link SEED_MISS_REASONS} order. */
  readonly misses: readonly SeedMiss[]
}

const HEADING_SEGMENT = /^h[1-6]-\d+$/
const MARKDOWN_ROOTS: ReadonlySet<string> = new Set(['body', 'note'])

/**
 * The scope a unit key is aligned within: its innermost heading scope for markdown
 * prose (`body/h1-1/h2-3/p-2` → `body/h1-1/h2-3`), and the key itself otherwise.
 */
export function scopeOf(unitKey: string): string {
  const segments = unitKey.split('/')
  if (!MARKDOWN_ROOTS.has(segments[0] ?? '')) return unitKey
  let last = 0
  for (let index = 1; index < segments.length; index += 1) {
    if (HEADING_SEGMENT.test(segments[index] ?? '')) last = index
  }
  return segments.slice(0, last + 1).join('/')
}

/** The root a unit key belongs to: `body`, `note`, or the key itself. */
function rootOf(unitKey: string): string {
  const first = unitKey.split('/')[0] ?? ''
  return MARKDOWN_ROOTS.has(first) ? first : unitKey
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const name = key(item)
    const group = groups.get(name)
    if (group === undefined) groups.set(name, [item])
    else group.push(item)
  }
  return groups
}

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Align one matched container. See the module doc for the rule. */
export function alignContainer(
  containerId: string,
  english: readonly TranslationUnit[],
  translated: readonly TranslatedUnit[],
  limits: SeedLimits,
): ContainerAlignment {
  const translatedByKey = new Map<string, string>()
  for (const unit of translated) translatedByKey.set(unit.unitKey, unit.source)

  const missed = new Map<SeedMissReason, { ids: string[]; scopes: Set<string> }>()
  const miss = (reason: SeedMissReason, unit: TranslationUnit, scope: string): void => {
    const entry = missed.get(reason) ?? { ids: [], scopes: new Set<string>() }
    entry.ids.push(formatUnitId(unit.id))
    entry.scopes.add(scope)
    missed.set(reason, entry)
  }

  const translatedRoots = groupBy(translated, (unit) => rootOf(unit.unitKey))
  /** Diverged English unit keys, each with the scope label its miss is reported under. */
  const diverged = new Map<string, string>()
  for (const [root, units] of groupBy(english, (unit) => rootOf(unit.id.unitKey))) {
    const theirs = translatedRoots.get(root) ?? []
    if (MARKDOWN_ROOTS.has(root)) {
      const headingScopes = (keys: readonly string[]) =>
        keys.map(scopeOf).filter((scope) => scope !== root)
      if (
        !sameSet(
          headingScopes(units.map((unit) => unit.id.unitKey)),
          headingScopes(theirs.map((unit) => unit.unitKey)),
        )
      ) {
        for (const unit of units) diverged.set(unit.id.unitKey, `${root} (heading structure)`)
        continue
      }
    }
    const theirScopes = groupBy(theirs, (unit) => scopeOf(unit.unitKey))
    for (const [scope, scoped] of groupBy(units, (unit) => scopeOf(unit.id.unitKey))) {
      const keys = (theirScopes.get(scope) ?? []).map((unit) => unit.unitKey)
      if (
        !sameSet(
          scoped.map((unit) => unit.id.unitKey),
          keys,
        )
      ) {
        for (const unit of scoped) diverged.set(unit.id.unitKey, scope)
      }
    }
  }

  const drafts: SeedDraft[] = []
  for (const unit of english) {
    const key = unit.id.unitKey
    const translation = translatedByKey.get(key)
    const scope = diverged.get(key)
    if (scope !== undefined || translation === undefined) {
      miss('structure-diverged', unit, scope ?? key)
      continue
    }
    const check = checkTranslation(unit.source, translation, limits)
    if (check.miss !== undefined) {
      miss(check.miss, unit, key)
      continue
    }
    drafts.push({ id: unit.id, source: unit.source, translation, warnings: check.warnings })
  }

  const misses: SeedMiss[] = []
  for (const reason of SEED_MISS_REASONS) {
    const entry = missed.get(reason)
    if (entry === undefined) continue
    const scopes = [...entry.scopes].sort()
    misses.push({
      reason,
      containerId,
      unitIds: entry.ids.sort(),
      detail:
        reason === 'structure-diverged'
          ? `unit structure differs from the English in ${scopes.join(', ')}`
          : `${entry.ids.length} unit(s) refused: ${reason}`,
    })
  }
  return { drafts, misses }
}
