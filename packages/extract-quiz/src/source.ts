/**
 * Reading consumer bytes into a string without losing any of them.
 *
 * Every offset in this package indexes a decoded source string, and the round-trip
 * property (ADR 0012) is only byte-exact if decoding is reversible. `readFileSync(path,
 * 'utf8')` is not: it replaces every invalid byte sequence with U+FFFD, so a file with
 * one bad byte would compose back to a *different* file with a green round-trip test —
 * the exact silent corruption constitution III exists to prevent.
 *
 * {@link decodeSource} therefore refuses invalid UTF-8 instead of repairing it. The
 * byte-order mark is deliberately *not* stripped: it is a byte of the source like any
 * other, and dropping it here would make composition lose it.
 *
 * This module is a deliberate copy of the one in `@workshop-i18n/extract-markdown` (and
 * `extract-slidev` before it). The extractors are separate published packages that must
 * not depend on each other, and the shared home for it is `@workshop-i18n/core`;
 * promoting it there is a follow-up that belongs in core's own change, not here.
 */

/** Thrown by {@link decodeSource} when the bytes are not valid UTF-8. */
export class SourceDecodeError extends Error {
  /** Caller-supplied label for the file, if any. */
  readonly source: string | undefined

  constructor(message: string, source?: string) {
    super(message)
    this.name = 'SourceDecodeError'
    this.source = source
  }
}

/**
 * Decode UTF-8 bytes, failing closed on anything that is not valid UTF-8.
 *
 * @throws {SourceDecodeError} when `bytes` is not valid UTF-8.
 */
export function decodeSource(bytes: Uint8Array, source?: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    const where = source === undefined ? 'source' : `source ${source}`
    throw new SourceDecodeError(
      `${where} is not valid UTF-8; localization only handles UTF-8 text`,
      source,
    )
  }
}

/** A 1-based line/column position, for diagnostics a human has to act on. */
export interface Position {
  readonly line: number
  readonly column: number
}

/**
 * The 1-based line and column of `offset` in `text`.
 *
 * Linear in `offset`, which is fine because it runs once per diagnostic rather than once
 * per unit; keeping it allocation-free avoids building a line table for files that
 * produce no diagnostics at all.
 */
export function positionAt(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lineStart = 0
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: clamped - lineStart + 1 }
}
