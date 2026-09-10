/** The command table, bound to the runner. */

import { extractCommand } from './extract.js'
import { initIdsCommand } from './init-ids.js'
import type { CliIo } from './io.js'
import { type Command, runWith } from './run.js'
import { statusCommand } from './status.js'

/** Every command, in the order `--help` lists them. */
export const COMMANDS: readonly Command[] = Object.freeze([
  initIdsCommand,
  extractCommand,
  statusCommand,
])

/**
 * Run the CLI against an injected world. Pure apart from `io`; returns the exit code and
 * never throws (see `exit-codes.ts` for the contract).
 */
export function run(argv: readonly string[], io: CliIo): number {
  return runWith(COMMANDS, argv, io)
}
