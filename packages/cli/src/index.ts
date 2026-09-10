/**
 * The workshop-i18n CLI as a library: `run(argv, io)` is the whole command line as a
 * pure function over an injected file system and output streams. `bin.ts` binds it to
 * the real process. Commands: `init-ids`, `extract`, `status` (specs 001, 002).
 */

export { COMMANDS, run } from './cli.js'
export { CliError, EXIT, type ExitCode } from './exit-codes.js'
export { type CliIo, type EntryKind, type FileSystem, nodeFileSystem } from './io.js'
export { CLI_NAME, type Command, type CommandContext } from './run.js'
export { MANIFEST_PATH } from './workspace.js'
