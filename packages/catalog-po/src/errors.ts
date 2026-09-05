/**
 * Read-side failures. ADR 0013 makes the codec *total on read*: every malformed or
 * unsupported construct raises one of these, naming the file and line, rather than
 * degrading into a partial parse or a silent rewrite. Spec 002 lists the hand-edited
 * catalog as an edge case precisely because the alternative — quietly dropping what we
 * could not understand — destroys translator work.
 */

/** Where in a catalog something went wrong. Line numbers are 1-based. */
export interface PoLocation {
  readonly fileName: string
  readonly line: number
}

/** A catalog that does not parse. The message always starts `<file>:<line>: `. */
export class PoSyntaxError extends Error {
  readonly fileName: string
  readonly line: number

  constructor(at: PoLocation, detail: string) {
    super(`${at.fileName}:${at.line}: ${detail}`)
    this.name = 'PoSyntaxError'
    this.fileName = at.fileName
    this.line = at.line
  }
}

/**
 * A construct that is valid gettext but outside this codec's v1 scope — an explicit
 * error, never a quiet drop (ADR 0013). Kept a subclass of {@link PoSyntaxError} because
 * callers treat both the same way: refuse to touch the file and tell the operator where.
 */
export class UnsupportedPoError extends PoSyntaxError {
  constructor(at: PoLocation, detail: string) {
    super(at, detail)
    this.name = 'UnsupportedPoError'
  }
}
