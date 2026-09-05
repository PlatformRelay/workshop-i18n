/**
 * Tool-owned extracted comments: the source reference and the source hash that spec 002
 * FR-002 requires next to every entry.
 *
 * These two `#.` lines are the only comments this package writes or rewrites. Everything
 * else on an entry — translator notes, `#:` references a TMS added, comment classes we
 * do not model — is translator-owned and survives verbatim (FR-001).
 *
 * Rewriting happens *in place*: the refreshed lines go back at the index the old ones
 * occupied, so a run that changes nothing produces the same bytes (FR-005) and a run
 * that moves a file changes exactly two lines.
 */

import { isSourceHash } from '@workshop-i18n/core'
import type { PoComment } from './po-file.js'

/** `#.` key carrying the human-readable pointer to where the unit was extracted from. */
export const SOURCE_COMMENT_KEY = 'workshop-i18n-source'

/** `#.` key carrying the staleness anchor, in `sourceHash` form. */
export const HASH_COMMENT_KEY = 'workshop-i18n-hash'

/** What the tool recorded about an entry last time it wrote one. */
export interface Provenance {
  readonly reference: string | undefined
  /**
   * The recorded anchor, or `undefined` when absent *or malformed*. Catalogs are
   * hand-editable, so a value that is not shaped like a `sourceHash` is treated as no
   * anchor at all rather than compared against and silently read as "changed".
   */
  readonly sourceHash: string | undefined
}

function keyValue(comment: PoComment): readonly [string, string] | undefined {
  if (comment.marker !== '.') return undefined
  const colon = comment.text.indexOf(':')
  if (colon < 0) return undefined
  return [comment.text.slice(0, colon).trim(), comment.text.slice(colon + 1).trim()]
}

function isProvenanceComment(comment: PoComment): boolean {
  const pair = keyValue(comment)
  return pair !== undefined && (pair[0] === SOURCE_COMMENT_KEY || pair[0] === HASH_COMMENT_KEY)
}

/** Read what the tool recorded on this entry, ignoring anything malformed. */
export function readProvenance(comments: readonly PoComment[]): Provenance {
  let reference: string | undefined
  let hash: string | undefined
  for (const comment of comments) {
    const pair = keyValue(comment)
    if (pair === undefined) continue
    if (pair[0] === SOURCE_COMMENT_KEY && reference === undefined) reference = pair[1]
    if (pair[0] === HASH_COMMENT_KEY && hash === undefined && isSourceHash(pair[1])) hash = pair[1]
  }
  return { reference, sourceHash: hash }
}

/**
 * Return `comments` with the tool-owned lines replaced by fresh ones, at the position
 * the first tool-owned line already occupied (or at the front when there was none).
 */
export function withProvenance(
  comments: readonly PoComment[],
  reference: string | undefined,
  sourceHash: string,
): readonly PoComment[] {
  const firstOwned = comments.findIndex(isProvenanceComment)
  const insertAt = firstOwned < 0 ? 0 : firstOwned
  const kept = comments.filter((comment) => !isProvenanceComment(comment))

  const fresh: PoComment[] = []
  if (reference !== undefined) {
    fresh.push({ marker: '.', text: ` ${SOURCE_COMMENT_KEY}: ${reference}` })
  }
  fresh.push({ marker: '.', text: ` ${HASH_COMMENT_KEY}: ${sourceHash}` })

  return [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)]
}
