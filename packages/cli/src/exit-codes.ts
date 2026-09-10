/**
 * The CLI's exit codes — a documented, stable contract, because CI in the consumer
 * repository branches on them (ADR 0003: exit codes carry policy).
 *
 * `1` is reserved for exactly one meaning: *the command worked and the tree failed the
 * gate it enforces* — `init-ids --check` found missing or duplicate ids, `status
 * --policy` found gating units, `extract --check` found stale catalogs. Everything that
 * stops a command from producing an answer at all uses a `sysexits.h` code instead, so a
 * CI script can tell "translations are not ready" from "the manifest is broken" without
 * parsing stderr.
 */
export const EXIT = Object.freeze({
  /** Success; the gate, if any, passed. */
  OK: 0,
  /** The command ran and the gate it enforces failed. */
  FAILED: 1,
  /** `EX_USAGE`: unknown command, unknown option, bad option value. */
  USAGE: 64,
  /**
   * `EX_DATAERR`: input that cannot be processed as written — an invalid manifest, a
   * source the extractors refuse, a PO file with broken syntax, a path that escapes the
   * repository, a symlink where a file must be.
   */
  DATA: 65,
  /** `EX_NOINPUT`: the manifest does not exist. */
  NO_INPUT: 66,
  /** `EX_SOFTWARE`: an unexpected internal error — a bug in this tool. */
  SOFTWARE: 70,
  /** `EX_IOERR`: the file system refused a read or a write. */
  IO: 74,
} as const)

/** One of {@link EXIT}. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** A failure a command reports to the operator, with the exit code it maps to. */
export class CliError extends Error {
  readonly exitCode: ExitCode

  constructor(exitCode: ExitCode, message: string) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}
