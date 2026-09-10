/**
 * Path containment: every path this CLI reads or writes stays inside the repository root.
 *
 * The manifest and the tree are untrusted input (SECURITY.md). Core already refuses a
 * manifest glob that is absolute or contains `..`; this module is the second wall, applied
 * where a relative path actually becomes an absolute one, plus the one core cannot build:
 * **symlinks are never followed.** A link is how a path that is lexically inside the
 * repository resolves outside it — `i18n -> /etc` turns a catalog write into an arbitrary
 * file overwrite — so a symlink anywhere on a path the CLI touches is a hard error, not
 * something to resolve and re-check.
 */

import { isAbsolute, join, relative, sep } from 'node:path'
import { CliError, EXIT } from './exit-codes.js'
import type { FileSystem } from './io.js'

/**
 * Turn a repository-relative POSIX path into an absolute one, refusing anything that
 * could land outside `root`.
 *
 * @throws {CliError} (`DATA`) for an absolute path, a `..` segment, a backslash or a
 *   control character, or a result that is not lexically inside `root`.
 */
export function insideRoot(root: string, repoPath: string): string {
  if (
    repoPath === '' ||
    repoPath.startsWith('/') ||
    repoPath.includes('\\') ||
    repoPath.split('/').some((segment) => segment === '..' || segment === '') ||
    hasControlCharacter(repoPath)
  ) {
    throw new CliError(EXIT.DATA, `refusing unsafe repository path ${JSON.stringify(repoPath)}`)
  }
  const absolute = join(root, ...repoPath.split('/'))
  const back = relative(root, absolute)
  if (back === '' || back.startsWith(`..${sep}`) || back === '..' || isAbsolute(back)) {
    throw new CliError(EXIT.DATA, `path ${JSON.stringify(repoPath)} escapes the repository root`)
  }
  return absolute
}

/**
 * Refuse when any existing component of `repoPath` — the final one included — is a
 * symlink. Components that do not exist yet are fine: they are about to be created as
 * real directories.
 *
 * @throws {CliError} (`DATA`) naming the first symlinked component.
 */
export function assertNoSymlink(fs: FileSystem, root: string, repoPath: string): void {
  const segments = repoPath.split('/')
  for (let count = 1; count <= segments.length; count += 1) {
    const prefix = segments.slice(0, count).join('/')
    const kind = fs.kind(insideRoot(root, prefix))
    if (kind === undefined) return
    if (kind === 'symlink') {
      throw new CliError(
        EXIT.DATA,
        `${prefix} is a symlink; workshop-i18n never follows symlinks, so it cannot read or write ${repoPath}`,
      )
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Posix-join repository-relative segments. */
export function repoJoin(...segments: readonly string[]): string {
  return segments.filter((segment) => segment !== '').join('/')
}
