/**
 * The CLI as a pure function: `run(argv, io)` parses arguments, dispatches to a command,
 * and turns every failure into a documented exit code (see `exit-codes.ts`). `bin.ts`
 * is the only place that binds this to the real process.
 */

import { resolve } from 'node:path'
import { type ParseArgsConfig, parseArgs } from 'node:util'
import { CliError, EXIT } from './exit-codes.js'
import type { CliIo } from './io.js'

/** The command name, as users type it. */
export const CLI_NAME = 'workshop-i18n'

type OptionsConfig = NonNullable<ParseArgsConfig['options']>

/** Parsed option values, as `node:util` returns them. */
export type OptionValues = Readonly<Record<string, string | boolean | undefined>>

/** What a command receives. */
export interface CommandContext {
  readonly io: CliIo
  /** Absolute repository root (`--root`, else the working directory). */
  readonly root: string
  readonly values: OptionValues
}

/** One subcommand. */
export interface Command {
  readonly name: string
  readonly summary: string
  /** Option lines for `<command> --help`, already formatted. */
  readonly help: string
  readonly options: OptionsConfig
  execute(context: CommandContext): number
}

const COMMON_OPTIONS: OptionsConfig = {
  root: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
}

const COMMON_HELP = [
  '  --root <dir>   repository root holding .localization/workshop.yaml (default: cwd)',
  '  -h, --help     show this help',
].join('\n')

function usage(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((command) => command.name.length))
  return [
    `Usage: ${CLI_NAME} <command> [options]`,
    '',
    'Commands:',
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    `Run "${CLI_NAME} <command> --help" for a command's options.`,
    '',
    'Exit codes: 0 ok, 1 gate failed, 64 usage, 65 bad input, 66 no manifest,',
    '            70 internal error, 74 I/O error.',
    '',
  ].join('\n')
}

function commandHelp(command: Command): string {
  return [
    `Usage: ${CLI_NAME} ${command.name} [options]`,
    '',
    command.summary,
    '',
    'Options:',
    command.help,
    COMMON_HELP,
    '',
  ].join('\n')
}

/** Run one invocation. Never throws: every outcome is an exit code. */
export function runWith(commands: readonly Command[], argv: readonly string[], io: CliIo): number {
  const [name, ...rest] = argv
  if (name === undefined) {
    io.stderr(usage(commands))
    return EXIT.USAGE
  }
  if (name === '--help' || name === '-h' || name === 'help') {
    io.stdout(usage(commands))
    return EXIT.OK
  }
  const command = commands.find((candidate) => candidate.name === name)
  if (command === undefined) {
    io.stderr(`${CLI_NAME}: unknown command ${JSON.stringify(name)}\n\n${usage(commands)}`)
    return EXIT.USAGE
  }

  let values: OptionValues
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: { ...COMMON_OPTIONS, ...command.options },
      strict: true,
      allowPositionals: false,
    })
    values = parsed.values as OptionValues
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    io.stderr(`${CLI_NAME} ${command.name}: ${detail}\n\n${commandHelp(command)}`)
    return EXIT.USAGE
  }
  if (values.help === true) {
    io.stdout(commandHelp(command))
    return EXIT.OK
  }

  const root = typeof values.root === 'string' ? resolve(io.cwd, values.root) : io.cwd
  try {
    return command.execute({ io, root, values })
  } catch (error) {
    return reportFailure(io, command.name, error)
  }
}

function reportFailure(io: CliIo, name: string, error: unknown): number {
  if (error instanceof CliError) {
    io.stderr(`${CLI_NAME} ${name}: ${error.message}\n`)
    return error.exitCode
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
    io.stderr(`${CLI_NAME} ${name}: file system error: ${(error as Error).message}\n`)
    return EXIT.IO
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  io.stderr(`${CLI_NAME} ${name}: internal error — this is a bug in ${CLI_NAME}:\n${detail}\n`)
  return EXIT.SOFTWARE
}
