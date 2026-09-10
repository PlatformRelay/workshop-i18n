#!/usr/bin/env node
/**
 * The only module that touches the real process: it binds `run` to `process.argv`, the
 * working directory, the real file system and the standard streams, and hands the exit
 * code back. Everything else is testable without it.
 */
import { run } from './cli.js'
import { nodeFileSystem } from './io.js'

process.exitCode = run(process.argv.slice(2), {
  cwd: process.cwd(),
  fs: nodeFileSystem(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
