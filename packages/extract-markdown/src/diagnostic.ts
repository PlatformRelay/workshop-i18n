/**
 * What the locator found that it could not translate safely.
 *
 * A locator that silently skips content it does not understand produces a lab that
 * ships half-translated with a green build, which is the failure mode spec 001 names
 * ("never a silent mangle"). Every construct this package declines to handle therefore
 * leaves a diagnostic behind, carrying the offset *and* the line/column so a CLI can
 * point a human at the line.
 *
 * Severity splits the two kinds: `error` means the file cannot be extracted correctly as
 * written and extraction fails closed on it; `warning` means extraction is lossless but
 * some prose stayed English — a coverage gap the operator should see and decide about.
 */

import { positionAt } from './source.js'

/** How bad a finding is. `error` fails extraction; `warning` reports a coverage gap. */
export type DiagnosticSeverity = 'error' | 'warning'

/** Machine-readable finding kinds, so a CLI can group and filter them. */
export type DiagnosticCode =
  /** A lab carries no `labId` marker; run `init-ids` (ADR 0005, spec 001 FR-001). */
  | 'missing-lab-id'
  /** A file declares more than one `labId`, so its identity is ambiguous. */
  | 'duplicate-lab-id'
  /** A `labId` in the source is not a safe container id. */
  | 'unsafe-lab-id'
  /** A unit key derived from the document structure is not a safe unit key. */
  | 'unsafe-unit-key'
  /** Prose inside a raw HTML block, which stays protected skeleton. */
  | 'prose-in-html-block'

/** One finding, located in the source. */
export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly severity: DiagnosticSeverity
  /** Human-readable, already naming what is wrong and what to do. */
  readonly message: string
  /** Inclusive start offset of the offending span. */
  readonly start: number
  /** Exclusive end offset of the offending span. */
  readonly end: number
  /** 1-based line of {@link Diagnostic.start}. */
  readonly line: number
  /** 1-based column of {@link Diagnostic.start}. */
  readonly column: number
}

/** Build a diagnostic, resolving its line and column against `source`. */
export function diagnostic(
  source: string,
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  message: string,
  start: number,
  end: number,
): Diagnostic {
  const { line, column } = positionAt(source, start)
  return { code, severity, message, start, end, line, column }
}

/** True when any diagnostic is fatal. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === 'error')
}
