/**
 * Everything the CLI touches outside its own memory, as one injected value.
 *
 * The commands are pure functions of `(argv, io)`: they read the tree through
 * {@link FileSystem}, report through `stdout`/`stderr`, and return an exit code. Nothing
 * reaches for `process` or `node:fs` directly, so every behaviour — including path
 * containment and symlink refusal — is testable against an in-memory tree, and the one
 * place that binds the real process is `bin.ts` (constitution IV: same input, same output).
 *
 * The file system is deliberately small and synchronous. The CLI reads a working tree,
 * computes, and writes a handful of catalogs; there is no concurrency to exploit and a
 * sync interface keeps every command a straight line.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

/** What a path is, read without following a symlink. */
export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

/** The file operations the CLI needs, on absolute paths. */
export interface FileSystem {
  /**
   * What `path` is, with `lstat` semantics — a symlink reports as `symlink`, never as
   * what it points to. `undefined` when nothing exists there.
   */
  kind(path: string): EntryKind | undefined
  readFile(path: string): Uint8Array
  /** Entry names of a directory, in no particular order. */
  readDirectory(path: string): readonly string[]
  writeFile(path: string, data: string): void
  /** Create a directory and any missing parents. */
  makeDirectory(path: string): void
  removeFile(path: string): void
  /** Remove an empty directory; fails on one that is not empty. */
  removeDirectory(path: string): void
}

/** The injected world a command runs in. */
export interface CliIo {
  /** Absolute working directory; the default repository root. */
  readonly cwd: string
  readonly fs: FileSystem
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** The real file system. */
export function nodeFileSystem(): FileSystem {
  return {
    kind(path) {
      let stats: ReturnType<typeof lstatSync>
      try {
        stats = lstatSync(path)
      } catch (error) {
        // ENOENT/ENOTDIR mean "nothing there", which is an answer, not a failure.
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
        throw error
      }
      if (stats.isSymbolicLink()) return 'symlink'
      if (stats.isFile()) return 'file'
      if (stats.isDirectory()) return 'directory'
      return 'other'
    },
    readFile: (path) => readFileSync(path),
    readDirectory: (path) => readdirSync(path),
    writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
    makeDirectory: (path) => {
      mkdirSync(path, { recursive: true })
    },
    removeFile: (path) => unlinkSync(path),
    removeDirectory: (path) => rmdirSync(path),
  }
}
