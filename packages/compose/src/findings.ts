/**
 * Gate results: machine-readable findings at file and unit coordinates (spec 003 "Gate
 * result").
 *
 * Findings carry no exit code, for the same reason core's `PolicyEvaluation` does not
 * (ADR 0003: exit codes carry policy, and policy is the CLI's to apply). `error` means
 * "this must not ship"; `warning` means "a human should look".
 */

/**
 * How a locale is composed.
 *
 * `preview` (the default) renders every unit it can: missing, fuzzy and stale units, and
 * translations a content gate refused, fall back to English carrying the visible
 * fallback marker; `needs-review` drafts render translated. `strict` is release mode
 * (ADR 0009): it fails closed on any unit the core `release` policy gates and on any
 * content-gate failure, and then emits no files at all.
 */
export type ComposeMode = 'preview' | 'strict'

/** Thrown for input that makes a composition ill-defined — a caller or configuration bug. */
export class ComposeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ComposeInputError'
  }
}

/** How bad a finding is. */
export type FindingSeverity = 'error' | 'warning'

/** Machine-readable finding kinds, so a CLI can group and filter them. */
export type FindingCode =
  /** An extractor diagnostic for the English source (its own code is in `detail`). */
  | 'extraction'
  /** A unit the release policy gates is not shipping-grade (strict mode). */
  | 'policy'
  /** The catalog translated a different English than the source now holds. */
  | 'stale-translation'
  /** The extractor refused to splice the translation (it would break out of its hole). */
  | 'unspliceable'
  /** The translation's markup, placeholders or URLs differ from the English unit's. */
  | 'markup-parity'
  /** A protected term the English uses is missing from the translation. */
  | 'protected-term'
  /** The translation exceeds the length budget of its layout — likely overflow. */
  | 'length-budget'
  /** The composed file's protected skeleton is not byte-identical to the English. */
  | 'skeleton-mismatch'
  /** The fallback marker could not be placed, so the unit shows plain English. */
  | 'marker-omitted'
  /** A composed file meant for release still shows marked English fallback. */
  | 'fallback-in-release'

/** One finding. */
export interface Finding {
  readonly severity: FindingSeverity
  readonly code: FindingCode
  /** The file, as the caller named it. */
  readonly path: string
  /** The formatted unit id, when the finding is about one unit. */
  readonly unitId?: string
  /** 1-based line in the file the finding points at, when known. */
  readonly line?: number
  /** A sub-code, e.g. the extractor diagnostic code or the splice refusal reason. */
  readonly detail?: string
  /** Human-readable, already naming what is wrong and what to do. */
  readonly message: string
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Findings in a stable order — path, then unit, then line, then code — for diffable reports. */
export function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.unitId ?? '', b.unitId ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.message, b.message),
  )
}

/** True when any finding is an error. */
export function hasErrorFindings(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'error')
}

/**
 * Quote hostile text for a message: JSON escaping keeps control characters and line
 * breaks from a translation out of a terminal, and long tokens are cut so one pasted
 * payload cannot bury the report.
 */
export function quote(text: string, limit = 60): string {
  const cut = [...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text
  return JSON.stringify(cut)
}
