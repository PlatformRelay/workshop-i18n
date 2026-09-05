/**
 * What the locator found that it could not translate safely.
 *
 * A locator that silently skips content it does not understand produces a deck that
 * ships half-translated with a green build, which is the failure mode spec 001 names
 * ("never a silent mangle"). Every construct this package declines to handle therefore
 * leaves a diagnostic behind, carrying the offset *and* the line/column so a CLI can
 * point a human at the slide.
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
  /** A frontmatter block was opened and never closed — Slidev would swallow the slide. */
  | 'unclosed-frontmatter'
  /** A frontmatter block is not valid YAML, or is not a mapping. */
  | 'malformed-frontmatter'
  /** A slide carries no `slideId`; run `init-ids` (ADR 0005, spec 001 FR-001). */
  | 'missing-slide-id'
  /** Two slides claim the same `slideId`. */
  | 'duplicate-slide-id'
  /** A `slideId` in the source is not a safe container id. */
  | 'unsafe-slide-id'
  /** A declared text field holds something other than a string scalar. */
  | 'non-scalar-text-field'
  /** A separator that is not exactly `---`; it splits the slide, which is rarely intended. */
  | 'ambiguous-separator'
  /** A `---` inside a tilde fence: Slidev splits the slide there, cutting the code in half. */
  | 'separator-in-tilde-fence'
  /** A fence with no closing line, which makes later slide boundaries depend on later content. */
  | 'unclosed-fence'
  /** Slidev's frontmatter regex reads a block on a slide whose scanner opened none. */
  | 'phantom-frontmatter'
  /** Prose inside a raw HTML block or Vue island, which stays protected skeleton. */
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
