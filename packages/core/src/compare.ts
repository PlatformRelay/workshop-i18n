/**
 * Compare two strings by UTF-16 code unit — the order `Array.prototype.sort()` applies
 * when it is given no comparator, made explicit.
 *
 * Deliberately not `localeCompare`: that order depends on the host's locale and ICU data,
 * so the same catalog would serialize differently on two machines and every diff would
 * churn (constitution IV, deterministic output). Uppercase therefore precedes lowercase,
 * and any non-ASCII letter follows both. Pass it wherever a list of strings is sorted,
 * so the intent survives a reader (and a linter) who cannot tell a deliberate default
 * from a forgotten comparator.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
