import { dirname, posix } from 'node:path'
import { run } from '../src/cli.js'
import type { CliIo, EntryKind, FileSystem } from '../src/io.js'

/**
 * An in-memory tree with real symlink semantics: a link is an entry of its own, reported
 * as `symlink` and never followed, which is exactly the contract the real adapter keeps.
 * Any read or write *through* a link throws, so a test proves the CLI never asks to.
 */
export class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, Uint8Array>()
  readonly directories = new Set<string>(['/'])
  readonly links = new Map<string, string>()
  /** Every path written, in order — so a test can assert "wrote nothing". */
  readonly writes: string[] = []
  readonly removals: string[] = []

  constructor(files: Readonly<Record<string, string | Uint8Array>> = {}) {
    for (const [path, content] of Object.entries(files)) this.put(path, content)
  }

  /** Create or replace a file, with its parents, without recording a write. */
  put(path: string, content: string | Uint8Array): void {
    this.makeDirectory(dirname(path))
    this.files.set(path, typeof content === 'string' ? new TextEncoder().encode(content) : content)
  }

  link(path: string, target: string): void {
    this.makeDirectory(dirname(path))
    this.links.set(path, target)
  }

  text(path: string): string {
    const bytes = this.files.get(path)
    if (bytes === undefined) throw new Error(`no such file in memory tree: ${path}`)
    return new TextDecoder().decode(bytes)
  }

  /** Every file under `prefix`, as `{relative path: text}`. */
  tree(prefix: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const path of [...this.files.keys()].sort()) {
      if (path.startsWith(`${prefix}/`)) out[path.slice(prefix.length + 1)] = this.text(path)
    }
    return out
  }

  kind(path: string): EntryKind | undefined {
    if (this.links.has(path)) return 'symlink'
    if (this.files.has(path)) return 'file'
    if (this.directories.has(path)) return 'directory'
    return undefined
  }

  readFile(path: string): Uint8Array {
    this.assertNoLinkOnTheWay(path)
    const bytes = this.files.get(path)
    if (bytes === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return bytes
  }

  readDirectory(path: string): readonly string[] {
    this.assertNoLinkOnTheWay(path)
    if (!this.directories.has(path)) {
      throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: 'ENOTDIR' })
    }
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set<string>()
    for (const candidate of [...this.files.keys(), ...this.directories, ...this.links.keys()]) {
      if (candidate === path || !candidate.startsWith(prefix)) continue
      const rest = candidate.slice(prefix.length)
      if (rest !== '' && !rest.includes('/')) names.add(rest)
    }
    return [...names]
  }

  writeFile(path: string, data: string): void {
    this.assertNoLinkOnTheWay(path)
    if (!this.directories.has(dirname(path))) {
      throw Object.assign(new Error(`ENOENT: ${dirname(path)}`), { code: 'ENOENT' })
    }
    this.writes.push(path)
    this.files.set(path, new TextEncoder().encode(data))
  }

  makeDirectory(path: string): void {
    this.assertNoLinkOnTheWay(path)
    let current = path
    while (current !== '/' && !this.directories.has(current)) {
      this.directories.add(current)
      current = dirname(current)
    }
  }

  removeFile(path: string): void {
    this.removals.push(path)
    this.files.delete(path)
  }

  removeDirectory(path: string): void {
    this.assertNoLinkOnTheWay(path)
    if (!this.directories.has(path)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    }
    if (this.readDirectory(path).length > 0) {
      throw Object.assign(new Error(`ENOTEMPTY: ${path}`), { code: 'ENOTEMPTY' })
    }
    this.removals.push(path)
    this.directories.delete(path)
  }

  /** The CLI must never traverse a link; make any attempt loud. */
  private assertNoLinkOnTheWay(path: string): void {
    let current = path
    while (current !== '/') {
      if (this.links.has(current)) throw new Error(`test tree: CLI traversed symlink ${current}`)
      current = posix.dirname(current)
    }
  }
}

/** The result of one CLI invocation against a memory tree. */
export interface Invocation {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the CLI in `/repo` of `fs`. */
export function invoke(fs: MemoryFileSystem, argv: readonly string[], cwd = '/repo'): Invocation {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    cwd,
    fs,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  }
  const code = run(argv, io)
  return { code, stdout, stderr }
}
