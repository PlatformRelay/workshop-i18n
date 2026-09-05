/**
 * What the locator found that it could not extract safely.
 *
 * A locator that silently skips content it does not understand produces a quiz that
 * ships half-translated with a green build, which is the failure mode spec 001 names
 * ("never a silent mangle"). Every construct this package declines to handle therefore
 * leaves a diagnostic behind, carrying the offset *and* the line/column so a CLI can
 * point a human at the line of the bank.
 *
 * Every code here is an `error`: a quiz bank is structured data, so there is no
 * equivalent of the Markdown extractor's "lossless but some prose stayed English"
 * coverage gap — either a string is at a known path in a known shape or the file is not
 * a bank this release understands.
 */

import { positionAt } from './source.js'

/** How bad a finding is. Today every quiz finding is fatal; the type keeps the shape. */
export type DiagnosticSeverity = 'error' | 'warning'

/** Machine-readable finding kinds, so a CLI can group and filter them. */
export type DiagnosticCode =
  /** The file is not well-formed JSON at all. */
  | 'malformed-json'
  /** The file matches no known quiz schema variant (spec 001 edge case). */
  | 'unknown-quiz-schema'
  /** A question id is not usable as a container id, or not the shape the schema declares. */
  | 'unsafe-question-id'
  /** Two questions claim the same id. */
  | 'duplicate-question-id'
  /** An option id would not survive as a unit-key segment. */
  | 'unsafe-option-id'
  /** Two options of one question claim the same id. */
  | 'duplicate-option-id'

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
