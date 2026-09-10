/** Reading the discovered source files, once, before anything is decided or written. */

import { type Discovery, discoverSurfaceFiles, type SurfaceFile } from './discover.js'
import { readText, type Workspace } from './workspace.js'

/** One source file and its decoded text. */
export interface SourceFile extends SurfaceFile {
  readonly text: string
}

/** Every covered file, read. */
export interface Sources {
  readonly files: readonly SourceFile[]
  readonly warnings: Discovery['warnings']
}

/**
 * Discover and read every surface file. All reads happen before any command writes, so
 * a file that cannot be read (invalid UTF-8, a symlink) aborts the run with the tree
 * untouched.
 */
export function readSources(workspace: Workspace): Sources {
  const discovery = discoverSurfaceFiles(workspace)
  const files = discovery.files.map((file) => ({
    ...file,
    // The byte-order mark is kept: it is a byte of the source, and every extractor
    // offset indexes the decoded string.
    text: readText(workspace.fs, workspace.root, file.path, { keepBom: true }),
  }))
  return { files, warnings: discovery.warnings }
}

/** Only the files of one surface. */
export function ofSurface(
  sources: Sources,
  surface: SurfaceFile['surface'],
): readonly SourceFile[] {
  return sources.files.filter((file) => file.surface === surface)
}
