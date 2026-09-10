/** Small formatting helpers shared by the commands. */

/** The diagnostic shape every extractor package shares. */
export interface LocatedDiagnostic {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly line: number
  readonly column: number
}

/**
 * `path:line:column: severity: message [code]` — the compiler convention, so editors and
 * CI annotators can jump straight to the slide.
 */
export function formatDiagnostic(path: string, diagnostic: LocatedDiagnostic): string {
  return `${path}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity}: ${diagnostic.message} [${diagnostic.code}]`
}

/** `1 file`, `2 files`. */
export function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`
}

/** Code-unit string order: locale-independent, so output is identical on every machine. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
