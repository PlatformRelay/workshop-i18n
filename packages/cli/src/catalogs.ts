/**
 * The catalog layout and the per-locale update plan (spec 002 US-1).
 *
 * ## Layout: one catalog per English source file
 *
 * `i18n/<locale>/<source path with its extension replaced by .po>`:
 *
 * ```text
 * pages/S05-pod/index.md    -> i18n/pt-BR/pages/S05-pod/index.po
 * labs/day-1/05-pod.md      -> i18n/pt-BR/labs/day-1/05-pod.po
 * quiz/questions.json       -> i18n/pt-BR/quiz/questions.po
 * ```
 *
 * Spec 002 left per-surface vs per-section splitting to the plan phase; ADR 0014 decides
 * it. Per file is bounded (one section or one lab, never the whole deck — a 5 000-entry
 * `slides.po` is a merge-conflict magnet and a slow TMS component), needs no naming scheme
 * beyond the path the author already chose, and cannot collide except by two sources
 * differing only in extension (refused). In Weblate it is one component per catalog file,
 * via component discovery (`i18n/(?P<language>[^/]+)/(?P<component>.+)\.po`).
 *
 * ## Paths are where entries live, not who they are
 *
 * ADR 0005 promises that moving a slide to another file is free, and a layout keyed by
 * path would quietly break that: the old catalog would obsolete the slide's entries and
 * the new one would start them as `missing`. So a locale's catalogs are treated as **one
 * logical catalog, partitioned by current source file**. Every existing entry is pooled
 * by unit id; each source file's catalog is then built from whichever pooled entries its
 * units name — wherever they lived before. An entry follows its unit; only a unit that
 * left the English source entirely becomes obsolete (FR-004), in the catalog it was last
 * in. A catalog left with no entries at all — every unit moved away — is removed, and a
 * source that yields no units gets no catalog: a catalog file exists iff it has entries.
 *
 * Everything here is planning. Nothing is written; `extract` writes the plan and
 * `status` reads it, so both see exactly the same catalogs.
 */

import { dirname, posix } from 'node:path'
import {
  type Catalog,
  type CatalogEntry,
  CatalogError,
  type CatalogIdentity,
  emptyCatalog,
  PoSyntaxError,
  parseCatalog,
  serializeCatalog,
  type UpdateSummary,
  updateCatalog,
} from '@workshop-i18n/catalog-po'
import { formatUnitId } from '@workshop-i18n/core'
import { walkFiles } from './discover.js'
import { CliError, EXIT } from './exit-codes.js'
import { assertNoSymlink, insideRoot, repoJoin } from './paths.js'
import { compareStrings } from './report.js'
import type { ExtractedFile, Extraction } from './units.js'
import { readText, type Workspace } from './workspace.js'

/** Where catalogs live, relative to the repository root (ADR 0003). */
export const CATALOG_ROOT = 'i18n'

/** The catalog a source file's units are written to, for one locale. */
export function catalogPathFor(locale: string, sourcePath: string): string {
  const extension = posix.extname(sourcePath)
  const stem = extension === '' ? sourcePath : sourcePath.slice(0, -extension.length)
  return repoJoin(CATALOG_ROOT, locale, `${stem}.po`)
}

/** One catalog file after the plan. */
export interface PlannedCatalog {
  /** Repository-relative catalog path. */
  readonly path: string
  /** The English source file it belongs to, or `undefined` for an orphan. */
  readonly sourcePath: string | undefined
  readonly catalog: Catalog
  /** The canonical bytes, or `undefined` when the file must not exist. */
  readonly text: string | undefined
  /** The text on disk before the plan, or `undefined` when there was no file. */
  readonly previousText: string | undefined
  readonly summary: UpdateSummary
}

/** What `extract` would do to one locale. */
export interface LocalePlan {
  readonly locale: string
  readonly catalogs: readonly PlannedCatalog[]
}

/** Is this catalog's file going to change? */
export function isChanged(planned: PlannedCatalog): boolean {
  return planned.text !== planned.previousText
}

interface Pooled {
  readonly path: string
  readonly entry: CatalogEntry
}

function identityFor(locale: string, catalogPath: string): CatalogIdentity {
  const prefix = `${repoJoin(CATALOG_ROOT, locale)}/`
  return { locale, name: catalogPath.slice(prefix.length).replace(/\.po$/, '') }
}

/** Read every existing `.po` file of a locale, refusing anything it cannot trust. */
function readExisting(
  workspace: Workspace,
  locale: string,
): {
  readonly catalogs: ReadonlyMap<string, { catalog: Catalog; text: string }>
  readonly pool: ReadonlyMap<string, Pooled>
} {
  const directory = repoJoin(CATALOG_ROOT, locale)
  const { files, links } = walkFiles(workspace, directory)
  // Any link under a locale directory is refused, not just a linked `.po`: a linked
  // directory is where a later write would land outside the repository.
  const [link] = links
  if (link !== undefined) {
    throw new CliError(
      EXIT.DATA,
      `${link} is a symlink; workshop-i18n never follows symlinks, so it will neither read nor write through it`,
    )
  }

  const catalogs = new Map<string, { catalog: Catalog; text: string }>()
  const pool = new Map<string, Pooled>()
  for (const path of files.filter((file) => file.endsWith('.po')).sort(compareStrings)) {
    // Kept with any byte-order mark so the no-change comparison sees it: ADR 0013 drops a
    // BOM on write, and a file that still has one is a file `extract` must rewrite.
    const text = readText(workspace.fs, workspace.root, path, { keepBom: true })
    let catalog: Catalog
    try {
      catalog = parseCatalog(text.replace(/^\uFEFF/, ''), {
        identity: identityFor(locale, path),
        fileName: path,
      })
    } catch (error) {
      // PO syntax and catalog-convention failures already name `<file>:<line>`. A broken
      // catalog is never rewritten: it is somebody's translation work (spec 002 edge case).
      if (error instanceof PoSyntaxError || error instanceof CatalogError) {
        throw new CliError(
          EXIT.DATA,
          `${error.message}\nfix the catalog by hand; nothing was written`,
        )
      }
      throw error
    }
    catalogs.set(path, { catalog, text })
    for (const entry of [...catalog.entries, ...catalog.obsolete]) {
      const key = formatUnitId(entry.id)
      const previous = pool.get(key)
      if (previous !== undefined) {
        throw new CliError(
          EXIT.DATA,
          `unit id ${JSON.stringify(key)} is in both ${previous.path}:${previous.entry.po.line} and ${path}:${entry.po.line}; delete one of the two entries by hand`,
        )
      }
      pool.set(key, { path, entry })
    }
  }
  return { catalogs, pool }
}

/**
 * Refuse two source files that would write one catalog (`a.md` and `a.json`).
 *
 * @throws {CliError} (`DATA`) naming both.
 */
export function assertDistinctCatalogs(extraction: Extraction): void {
  const owners = new Map<string, string>()
  for (const { file } of extraction.files) {
    const path = catalogPathFor('_', file.path)
    const owner = owners.get(path)
    if (owner !== undefined) {
      throw new CliError(
        EXIT.DATA,
        `${owner} and ${file.path} would share the catalog ${catalogPathFor('<locale>', file.path)}; rename one of them or exclude it from its surface`,
      )
    }
    owners.set(path, file.path)
  }
}

function plan(
  path: string,
  sourcePath: string | undefined,
  identity: CatalogIdentity,
  existing: { catalog: Catalog; text: string } | undefined,
  previous: Catalog,
  units: ExtractedFile['units'],
): PlannedCatalog {
  const { catalog, summary } = updateCatalog({ identity, units, previous })
  const empty = catalog.entries.length === 0 && catalog.obsolete.length === 0
  return {
    path,
    sourcePath,
    catalog,
    text: empty ? undefined : serializeCatalog(catalog),
    previousText: existing?.text,
    summary,
  }
}

/**
 * Plan the catalogs of one locale against a fresh extraction.
 *
 * @throws {CliError} (`DATA`) on a symlink under `i18n/<locale>/`, a catalog that does
 *   not parse, or one unit id held by two catalogs.
 */
export function planLocale(
  workspace: Workspace,
  extraction: Extraction,
  locale: string,
): LocalePlan {
  assertNoSymlink(workspace.fs, workspace.root, repoJoin(CATALOG_ROOT, locale))
  const { catalogs: existing, pool } = readExisting(workspace, locale)

  const live = new Set<string>()
  for (const file of extraction.files) {
    for (const unit of file.units) live.add(formatUnitId(unit.id))
  }

  /** Entries of `path` whose unit left the English source entirely. */
  const leftovers = (path: string) => {
    const catalog = existing.get(path)?.catalog
    const gone = (entry: CatalogEntry) => !live.has(formatUnitId(entry.id))
    return {
      entries: catalog?.entries.filter(gone) ?? [],
      obsolete: catalog?.obsolete.filter(gone) ?? [],
    }
  }

  const planned: PlannedCatalog[] = []
  const targets = new Set<string>()
  for (const file of extraction.files) {
    const path = catalogPathFor(locale, file.file.path)
    targets.add(path)
    const identity = identityFor(locale, path)
    const ownExisting = existing.get(path)
    const kept = leftovers(path)
    const entries: CatalogEntry[] = [...kept.entries]
    const obsolete: CatalogEntry[] = [...kept.obsolete]
    let donor: string | undefined
    for (const unit of file.units) {
      const pooled = pool.get(formatUnitId(unit.id))
      if (pooled === undefined) continue
      donor ??= pooled.path
      ;(pooled.entry.obsolete ? obsolete : entries).push(pooled.entry)
    }
    // A new catalog whose entries came from elsewhere (a moved or renamed file) inherits
    // that catalog's header, so fields a TMS wrote there are not silently dropped.
    const header =
      ownExisting?.catalog.header ??
      (donor === undefined ? undefined : existing.get(donor)?.catalog.header) ??
      emptyCatalog(identity).header
    const previous: Catalog = { identity, header, entries, obsolete }
    planned.push(plan(path, file.file.path, identity, ownExisting, previous, file.units))
  }

  for (const [path, own] of existing) {
    if (targets.has(path)) continue
    const identity = identityFor(locale, path)
    const kept = leftovers(path)
    const previous: Catalog = { identity, header: own.catalog.header, ...kept }
    planned.push(plan(path, undefined, identity, own, previous, []))
  }

  planned.sort((a, b) => compareStrings(a.path, b.path))
  return { locale, catalogs: planned }
}

/**
 * Write a plan: every changed catalog, and removal of every catalog that must not exist,
 * along with any directory that removal leaves empty (below `i18n/<locale>/`, which
 * stays). Every target is checked for symlinks before the first write.
 */
export function writePlans(workspace: Workspace, plans: readonly LocalePlan[]): void {
  const changed = plans.flatMap((locale) =>
    locale.catalogs.filter(isChanged).map((planned) => ({ locale: locale.locale, planned })),
  )
  for (const { planned } of changed) {
    assertNoSymlink(workspace.fs, workspace.root, planned.path)
  }
  for (const { planned } of changed) {
    const absolute = insideRoot(workspace.root, planned.path)
    if (planned.text === undefined) {
      workspace.fs.removeFile(absolute)
      continue
    }
    workspace.fs.makeDirectory(dirname(absolute))
    workspace.fs.writeFile(absolute, planned.text)
  }
  // After every write, so a directory a new catalog is about to fill is never removed.
  for (const { locale, planned } of changed) {
    if (planned.text === undefined) removeEmptyParents(workspace, locale, planned.path)
  }
}

/** Remove the directories above `catalogPath` that are now empty, stopping at the locale. */
function removeEmptyParents(workspace: Workspace, locale: string, catalogPath: string): void {
  const localeRoot = repoJoin(CATALOG_ROOT, locale)
  let directory = posix.dirname(catalogPath)
  while (directory.startsWith(`${localeRoot}/`)) {
    const absolute = insideRoot(workspace.root, directory)
    if (workspace.fs.kind(absolute) !== 'directory') return
    if (workspace.fs.readDirectory(absolute).length > 0) return
    workspace.fs.removeDirectory(absolute)
    directory = posix.dirname(directory)
  }
}

/**
 * Locale directories under `i18n/` the manifest does not declare. Spec 002: a catalog for
 * an undeclared locale is a warning and is excluded from policy — never read, never
 * written, never silently adopted.
 */
export function undeclaredLocales(workspace: Workspace): readonly string[] {
  assertNoSymlink(workspace.fs, workspace.root, CATALOG_ROOT)
  const absolute = insideRoot(workspace.root, CATALOG_ROOT)
  if (workspace.fs.kind(absolute) !== 'directory') return []
  const declared = new Set(workspace.manifest.locales.targets)
  const isDirectory = (name: string) =>
    workspace.fs.kind(insideRoot(workspace.root, repoJoin(CATALOG_ROOT, name))) === 'directory'
  return workspace.fs
    .readDirectory(absolute)
    .filter((name) => !declared.has(name) && isDirectory(name))
    .sort(compareStrings)
}

/** A unit whose key now holds English that another key's translation was made from. */
export interface ShiftedUnit {
  /** The unit id that now carries the English. */
  readonly id: string
  /** The unit id whose translation was made against that English. */
  readonly from: string
}

/** One container whose unit keys look re-keyed by a structural edit in this run. */
export interface RekeyedContainer {
  /** `<surface>:<containerId>`. */
  readonly container: string
  readonly added: number
  readonly fuzzied: number
  readonly obsoleted: number
  /** Pairs proven by exact English: `id` now holds the text `from` was translated from. */
  readonly shifted: readonly ShiftedUnit[]
  /**
   * `true` when a shift is proven, or units were added and obsoleted together (ADR 0005's
   * amendment); `false` for added plus fuzzy with no proven shift — an edit plus an
   * insertion looks the same as a shift combined with an edit.
   */
  readonly certain: boolean
}

/**
 * Containers whose unit keys shifted in this run — the residue ADR 0005's 2026-09-05
 * amendment names. Inserting a block re-keys its later siblings, so their translations
 * stay on keys that now hold *different* English: the common symptom is not "removed plus
 * added" but "fuzzy plus added", with each fuzzy entry's `#| msgid` reappearing as the
 * English of a neighbouring key.
 *
 * Exact-text matches are **reported, never acted on.** Moving a translation to the key
 * whose English matches would be identity by content hash, which ADR 0005 and
 * constitution II forbid, and it would re-attach a reviewed translation with no human
 * action (constitution V). The report tells a reviewer exactly which pairs to confirm in
 * the TMS, where translation memory turns each one into a match-and-confirm.
 */
export function rekeyedContainers(plan: LocalePlan): readonly RekeyedContainer[] {
  // Surfaces and container ids never contain ':', so the container is the first two fields.
  const containerOf = (id: string) => id.slice(0, id.indexOf(':', id.indexOf(':') + 1))
  const entries = new Map<string, CatalogEntry>()
  for (const planned of plan.catalogs) {
    for (const entry of [...planned.catalog.entries, ...planned.catalog.obsolete]) {
      entries.set(formatUnitId(entry.id), entry)
    }
  }
  interface Tally {
    added: string[]
    fuzzied: string[]
    obsoleted: string[]
  }
  const tallies = new Map<string, Tally>()
  const tallyOf = (id: string): Tally => {
    const container = containerOf(id)
    let tally = tallies.get(container)
    if (tally === undefined) {
      tally = { added: [], fuzzied: [], obsoleted: [] }
      tallies.set(container, tally)
    }
    return tally
  }
  for (const planned of plan.catalogs) {
    for (const id of planned.summary.added) tallyOf(id).added.push(id)
    for (const id of planned.summary.fuzzied) tallyOf(id).fuzzied.push(id)
    for (const id of planned.summary.obsoleted) tallyOf(id).obsoleted.push(id)
  }

  const result: RekeyedContainer[] = []
  for (const [container, tally] of [...tallies].sort(([a], [b]) => compareStrings(a, b))) {
    // English a translation was made from: a fuzzy entry's previous source, or an
    // obsoleted entry's msgid.
    const madeFrom = new Map<string, string>()
    for (const id of [...tally.fuzzied].sort(compareStrings)) {
      const previous = entries.get(id)?.previousSource
      if (previous !== undefined && !madeFrom.has(previous)) madeFrom.set(previous, id)
    }
    for (const id of [...tally.obsoleted].sort(compareStrings)) {
      const source = entries.get(id)?.source
      if (source !== undefined && !madeFrom.has(source)) madeFrom.set(source, id)
    }
    const shifted: ShiftedUnit[] = []
    for (const id of [...tally.added, ...tally.fuzzied].sort(compareStrings)) {
      const source = entries.get(id)?.source
      const from = source === undefined ? undefined : madeFrom.get(source)
      if (from !== undefined && from !== id) shifted.push({ id, from })
    }
    const certain = shifted.length > 0 || (tally.added.length > 0 && tally.obsoleted.length > 0)
    const possible = tally.added.length > 0 && tally.fuzzied.length > 0
    if (!certain && !possible) continue
    result.push({
      container,
      added: tally.added.length,
      fuzzied: tally.fuzzied.length,
      obsoleted: tally.obsoleted.length,
      shifted,
      certain,
    })
  }
  return result
}
