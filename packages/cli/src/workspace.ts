/**
 * The consumer repository as the commands see it: a root, a validated manifest, and a
 * way to read files that cannot be tricked into leaving the root.
 */

import { type Manifest, ManifestError, parseManifest } from '@workshop-i18n/core'
import { CliError, EXIT } from './exit-codes.js'
import type { CliIo, FileSystem } from './io.js'
import { assertNoSymlink, insideRoot } from './paths.js'

/** Where the manifest lives, relative to the repository root (ADR 0003). */
export const MANIFEST_PATH = '.localization/workshop.yaml'

/** A loaded consumer repository. */
export interface Workspace {
  /** Absolute repository root. */
  readonly root: string
  readonly manifest: Manifest
  readonly fs: FileSystem
}

/**
 * Decode UTF-8 strictly. `readFileSync(path, 'utf8')` would replace an invalid byte with
 * U+FFFD, and a tool whose contract is byte-exactness must refuse that file instead of
 * quietly translating a different one.
 */
export function decodeUtf8(bytes: Uint8Array, repoPath: string, keepBom: boolean): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: keepBom }).decode(bytes)
  } catch {
    throw new CliError(
      EXIT.DATA,
      `${repoPath}: is not valid UTF-8; workshop-i18n only handles UTF-8 text`,
    )
  }
}

/**
 * Read a repository file as text, refusing symlinks on the way.
 *
 * Source files keep a byte-order mark (`keepBom`), because it is a byte of the source and
 * extraction offsets index the decoded string; catalogs drop it (ADR 0013).
 */
export function readText(
  fs: FileSystem,
  root: string,
  repoPath: string,
  options: { readonly keepBom: boolean },
): string {
  assertNoSymlink(fs, root, repoPath)
  return decodeUtf8(fs.readFile(insideRoot(root, repoPath)), repoPath, options.keepBom)
}

/**
 * Resolve the root and load the manifest.
 *
 * @throws {CliError} `NO_INPUT` when the manifest is absent, `DATA` when it is a symlink,
 *   not valid UTF-8, or not a valid manifest (every issue is listed, each naming its path).
 */
export function loadWorkspace(io: CliIo, root: string): Workspace {
  const rootKind = io.fs.kind(root)
  if (rootKind !== 'directory') {
    throw new CliError(EXIT.NO_INPUT, `repository root ${root} is not a directory`)
  }
  assertNoSymlink(io.fs, root, MANIFEST_PATH)
  const kind = io.fs.kind(insideRoot(root, MANIFEST_PATH))
  if (kind === undefined) {
    throw new CliError(
      EXIT.NO_INPUT,
      `no manifest at ${MANIFEST_PATH} under ${root}; create one (see the workshop-i18n README) or pass --root`,
    )
  }
  if (kind !== 'file') {
    throw new CliError(EXIT.DATA, `${MANIFEST_PATH} is not a regular file`)
  }
  const text = readText(io.fs, root, MANIFEST_PATH, { keepBom: false })
  try {
    return { root, manifest: parseManifest(text, { source: MANIFEST_PATH }), fs: io.fs }
  } catch (error) {
    if (error instanceof ManifestError) {
      throw new CliError(
        EXIT.DATA,
        [
          `invalid manifest ${MANIFEST_PATH}:`,
          ...error.issues.map((issue) => `  ${issue.message}`),
        ].join('\n'),
      )
    }
    throw error
  }
}
