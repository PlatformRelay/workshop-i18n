/** The command table, bound to the runner. */

import { initIdsCommand } from './init-ids.js'
import type { CliIo } from './io.js'
import { type Command, runWith } from './run.js'

/** Every command, in the order `--help` lists them. */
export const COMMANDS: readonly Command[] = Object.freeze([initIdsCommand])

/**
 * Run the CLI against an injected world. Pure apart from `io`; returns the exit code and
 * never throws (see `exit-codes.ts` for the contract).
 */
export function run(argv: readonly string[], io: CliIo): number {
  return runWith(COMMANDS, argv, io)
}
