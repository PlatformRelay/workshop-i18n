/**
 * Which files each declared surface covers.
 *
 * The walk is the part of the CLI that meets the consumer's tree directly, so it is
 * conservative by construction:
 *
 * - it starts at each glob's literal base, never above it;
 * - it **never follows a symlink** — a linked file or directory is reported and skipped,
 *   because a link is the one way a path lexically inside the repository reads outside
 *   it;
 * - it never enters `.git`/`node_modules` (anywhere) or the tool's own trees at the root,
 *   `i18n/` and `.localization/`: an override under `i18n/<locale>/overrides/` is
 *   translated content, and extracting it as English would be a silent disaster that a
 *   broad `**\/*.md` glob would otherwise walk straight into;
 * - output is sorted by path, so everything downstream is deterministic.
 */

import type { Surface } from '@workshop-i18n/core'
import { CliError, EXIT } from './exit-codes.js'
import { compileGlob, type Glob, GlobError } from './glob.js'
import { assertNoSymlink, insideRoot, repoJoin } from './paths.js'
import { compareStrings } from './report.js'
import type { Workspace } from './workspace.js'

/** Directory names never entered, at any depth. */
const SKIPPED_ANYWHERE: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/** Directories at the repository root that belong to this tool, never to the source. */
export const RESERVED_ROOT_DIRECTORIES: ReadonlySet<string> = new Set(['i18n', '.localization'])

/** One source file a surface covers. */
export interface SurfaceFile {
  readonly surface: Surface
  /** Repository-relative POSIX path. */
  readonly path: string
  /** Literal base of the first include glob that matched, e.g. `labs`. */
  readonly base: string
}

/** The result of discovery. */
export interface Discovery {
  readonly files: readonly SurfaceFile[]
  /** Human-readable findings that do not stop the run. */
  readonly warnings: readonly string[]
}

/**
 * Every regular file under `base` (repository-relative, `''` for the root), plus the
 * symlinks met on the way — reported, never followed. A missing base yields nothing.
 *
 * @throws {CliError} (`DATA`) when `base` itself, or a directory above it, is a symlink.
 */
export function walkFiles(
  workspace: Workspace,
  base: string,
): { readonly files: readonly string[]; readonly links: readonly string[] } {
  const files: string[] = []
  const links: string[] = []
  const { fs, root } = workspace
  if (base !== '') {
    assertNoSymlink(fs, root, base)
    if (fs.kind(insideRoot(root, base)) !== 'directory') return { files, links }
  }
  const pending: string[] = [base]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    const absolute = directory === '' ? root : insideRoot(root, directory)
    for (const name of fs.readDirectory(absolute)) {
      if (SKIPPED_ANYWHERE.has(name)) continue
      if (directory === '' && RESERVED_ROOT_DIRECTORIES.has(name)) continue
      const path = repoJoin(directory, name)
      const kind = fs.kind(insideRoot(root, path))
      if (kind === 'symlink') links.push(path)
      else if (kind === 'directory') pending.push(path)
      else if (kind === 'file') files.push(path)
    }
  }
  return { files, links }
}

/** Compile a manifest glob, turning a refusal into an error naming the manifest entry. */
function compileManifestGlob(pattern: string, entry: string): Glob {
  try {
    return compileGlob(pattern)
  } catch (error) {
    if (error instanceof GlobError) throw new CliError(EXIT.DATA, `${entry}: ${error.message}`)
    throw error
  }
}

/** The longest of the glob's bases that contains `path` — what init-ids stems ids from. */
function baseOf(glob: Glob, path: string): string {
  let best = ''
  for (const base of glob.bases) {
    if (base.length > best.length && path.startsWith(`${base}/`)) best = base
  }
  return best
}

/**
 * Resolve the manifest's globs to files.
 *
 * @throws {CliError} (`DATA`) when a glob base is a symlink, or one file is claimed by
 *   two surfaces — which catalog would own its units is then undefined.
 */
export function discoverSurfaceFiles(workspace: Workspace): Discovery {
  const warnings = new Set<string>()
  const owner = new Map<string, SurfaceFile>()

  for (const spec of workspace.manifest.surfaces) {
    const excludes = spec.exclude.map((pattern, index) =>
      compileManifestGlob(pattern, `surfaces.${spec.surface}.exclude[${index}]`),
    )
    spec.include.forEach((pattern, index) => {
      const entry = `surfaces.${spec.surface}.include[${index}]`
      const matcher = compileManifestGlob(pattern, entry)
      let matched = 0
      for (const base of matcher.bases) {
        const { files, links } = walkFiles(workspace, base)
        for (const path of files) {
          if (!matcher.test(path) || excludes.some((exclude) => exclude.test(path))) continue
          const previous = owner.get(path)
          if (previous !== undefined && previous.surface !== spec.surface) {
            throw new CliError(
              EXIT.DATA,
              `${path} is claimed by both surfaces.${previous.surface} and surfaces.${spec.surface}; exclude it from one of them`,
            )
          }
          matched += 1
          if (previous === undefined) {
            owner.set(path, { surface: spec.surface, path, base: baseOf(matcher, path) })
          }
        }
        for (const link of links) {
          if (excludes.some((exclude) => exclude.test(link))) continue
          warnings.add(`${link} is a symlink and was not followed`)
        }
      }
      if (matched === 0) {
        warnings.add(`${entry} ${JSON.stringify(pattern)} matches no files`)
      }
    })
  }

  const order = new Map(workspace.manifest.surfaces.map((spec, index) => [spec.surface, index]))
  const files = [...owner.values()].sort(
    (a, b) =>
      (order.get(a.surface) ?? 0) - (order.get(b.surface) ?? 0) || compareStrings(a.path, b.path),
  )
  return { files, warnings: [...warnings].sort(compareStrings) }
}
