/**
 * The staleness anchor (spec 002 FR-003, ADR 0012).
 *
 * `extract` records `sourceHash(unit.source)` next to every catalog entry; the next
 * `extract` compares it against the freshly read source and flips exactly the entries
 * whose hash moved to `fuzzy`. It is the one place where "has the English changed?" is
 * decided, so its definition is a contract, not an implementation detail.
 *
 * ## No normalization before hashing — deliberately
 *
 * The hash covers the exact unit text, byte for byte as UTF-8: no trimming, no
 * whitespace collapsing, no line-ending folding, no Unicode NFC. Three reasons:
 *
 * 1. **It matches what composition does.** ADR 0012 splices the unit's exact source
 *    bytes into the skeleton. A hash that ignores a difference composition preserves
 *    would call a translation current for a source it no longer matches — silent
 *    drift, which is the failure this tool exists to prevent.
 * 2. **Whitespace is meaningful in markdown.** Two spaces before a newline is a hard
 *    break; leading spaces open a code block; a collapsed run changes rendered output.
 *    An "insignificant" whitespace edit is not reliably insignificant.
 * 3. **False fuzzies are cheap; false currents are not.** The worst case of hashing
 *    exactly is a translator revalidating a unit whose English only moved a space
 *    (one click). The worst case of normalizing is shipping a stale translation with
 *    a green gate. Constitution V puts the cost on the reversible side.
 *
 * Callers that genuinely want a whitespace-insensitive comparison normalize *before*
 * calling — that decision belongs to the caller, where it is visible, not baked in here.
 *
 * ## Shape
 *
 * `sha256:` plus the first 16 hex characters (64 bits) of the SHA-256 digest: stable on
 * every machine and Node version, and short enough to sit in a PO comment next to a
 * source reference. 64 bits is ample here — the anchor compares one unit against its own
 * previous value, so a collision would have to occur between two revisions of the same
 * unit; even treating a 10,000-unit corpus as one birthday space leaves the odds around
 * 1 in 4x10^11. The `sha256:` prefix keeps the algorithm swappable without ambiguity.
 */

import { createHash } from 'node:crypto'

/** Algorithm prefix on every value {@link sourceHash} returns. */
export const SOURCE_HASH_PREFIX = 'sha256:'

/** Hex characters of the digest retained after the prefix. */
export const SOURCE_HASH_DIGEST_LENGTH = 16

const SOURCE_HASH_PATTERN = new RegExp(
  `^${SOURCE_HASH_PREFIX}[0-9a-f]{${SOURCE_HASH_DIGEST_LENGTH}}$`,
)

/**
 * Hash a unit's source text. Pure and deterministic: same string in, same string out,
 * on every machine. See the module doc for why nothing is normalized first.
 */
export function sourceHash(text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex')
  return SOURCE_HASH_PREFIX + digest.slice(0, SOURCE_HASH_DIGEST_LENGTH)
}

/**
 * True when `value` has the exact shape {@link sourceHash} produces. Catalog comments
 * are hand-editable, so a malformed anchor must be detectable rather than compared
 * against and quietly treated as "changed".
 */
export function isSourceHash(value: string): boolean {
  return SOURCE_HASH_PATTERN.test(value)
}
