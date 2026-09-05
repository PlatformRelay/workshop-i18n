/**
 * The typed view of a catalog: PO entries read as translation units.
 *
 * `parse.ts` knows the gettext format; this module knows *our conventions on top of it*
 * — `msgctxt` is the stable unit id (spec 002 FR-002, ADR 0005), `#.` carries provenance,
 * `#~` preserves work for units that left the English source (FR-004).
 *
 * Everything read here is untrusted. A catalog is a file in a consumer repository that
 * humans hand-edit and a TMS writes to, so an id coming *out* of one gets the same
 * safety gate as an id coming out of content (`parseSafeUnitId`), and a recorded hash is
 * validated against `isSourceHash` rather than compared blindly.
 *
 * The catalog's *identity* — which locale, which catalog — is a parameter. This package
 * deliberately does not know the directory layout: spec 002's own Assumptions leave
 * per-surface vs per-section splitting to the plan phase, so inventing a path convention
 * here would be inventing the answer to an open question.
 */

import {
  compareUnitIds,
  formatUnitId,
  parseSafeUnitId,
  type UnitId,
  UnitIdError,
  type UnitState,
  type UnitStatus,
} from '@workshop-i18n/core'
import { type PoLocation, UnsupportedPoError } from './errors.js'
import { parsePo } from './parse.js'
import { isHeaderEntry, type PoEntry, type PoFile } from './po-file.js'
import { readProvenance } from './provenance.js'
import { serializePo } from './serialize.js'
import { unitStateOf } from './state.js'

/**
 * Which catalog this is. `name` is the catalog's own identifier (a surface or a section)
 * — a name, not a path. Turning it into a file location is the CLI's job.
 */
export interface CatalogIdentity {
  /** Target locale, e.g. `de` or `pt-BR`. */
  readonly locale: string
  /** The catalog's name, used as the `section` in status reports. */
  readonly name: string
}

/** A catalog entry, read as a translation unit. */
export interface CatalogEntry {
  readonly id: UnitId
  /** The English source, i.e. `msgid`. */
  readonly source: string
  /** The translation, i.e. `msgstr[0]`; empty when untranslated. */
  readonly translation: string
  readonly state: UnitState
  /** `true` for a `#~` entry: the unit left the English source but its work is kept. */
  readonly obsolete: boolean
  /** The recorded staleness anchor, or `undefined` when absent or malformed. */
  readonly recordedHash: string | undefined
  /** The recorded source reference, or `undefined`. */
  readonly reference: string | undefined
  /** `#| msgid` — the source this translation was last made against. */
  readonly previousSource: string | undefined
  /**
   * The underlying PO entry. Everything not modelled above lives here and is what makes
   * the round-trip lossless; treat it as the source of truth and these fields as a view.
   */
  readonly po: PoEntry
}

/** A whole catalog: its identity, its header, and its entries. */
export interface Catalog {
  readonly identity: CatalogIdentity
  /** The header entry, verbatim apart from the fields {@link readCatalog} guarantees. */
  readonly header: PoEntry
  /** Live entries, ordered by `compareUnitIds`. */
  readonly entries: readonly CatalogEntry[]
  /** Obsolete entries, ordered by `compareUnitIds`. */
  readonly obsolete: readonly CatalogEntry[]
}

/** A catalog that violates this tool's conventions, as opposed to gettext's grammar. */
export class CatalogError extends Error {
  readonly fileName: string | undefined
  readonly line: number | undefined

  constructor(at: PoLocation | undefined, detail: string) {
    super(at === undefined ? detail : `${at.fileName}:${at.line}: ${detail}`)
    this.name = 'CatalogError'
    this.fileName = at?.fileName
    this.line = at?.line
  }
}

/**
 * One unit id used by two entries — spec 002's "unit id collisions after a bad manual
 * edit" edge case. Both entries are named by line so the offending pair is findable.
 */
export class DuplicateCatalogEntryError extends CatalogError {
  readonly unitId: string
  readonly lines: readonly [number, number]

  constructor(at: PoLocation, unitId: string, lines: readonly [number, number]) {
    super(
      at,
      `duplicate unit id ${JSON.stringify(unitId)}: entries at lines ${lines[0]} and ${lines[1]}`,
    )
    this.name = 'DuplicateCatalogEntryError'
    this.unitId = unitId
    this.lines = lines
  }
}

/** Options for {@link parseCatalog} and {@link readCatalog}. */
export interface ReadCatalogOptions {
  readonly identity: CatalogIdentity
  /** Catalog path, used only to name the file in error messages. */
  readonly fileName: string
}

const HEADER_LINES = (locale: string): readonly string[] => [
  `Language: ${locale}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: 8bit',
  // No version: a generator string that moves on every release would make every catalog
  // churn on every upgrade, which is exactly what FR-005 is about.
  'X-Generator: workshop-i18n',
]

function headerLines(entry: PoEntry): readonly string[] {
  const block = entry.msgstr[0] ?? ''
  const lines = block.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function headerEntry(lines: readonly string[]): PoEntry {
  return {
    comments: [],
    flags: [],
    msgctxt: undefined,
    msgid: '',
    msgstr: [lines.map((line) => `${line}\n`).join('')],
    obsolete: false,
    line: 0,
  }
}

function fieldValue(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}:`
  for (const line of lines) {
    if (line.toLowerCase().startsWith(prefix.toLowerCase())) return line.slice(prefix.length).trim()
  }
  return undefined
}

/**
 * Guarantee the two header fields this tool depends on, changing nothing else. A TMS
 * writes its own `X-*` fields into the header; preserving them (and their order) is what
 * keeps a no-change run a zero-byte diff against a TMS-managed catalog.
 */
function ensureHeader(entry: PoEntry, locale: string, at: PoLocation | undefined): PoEntry {
  const lines = [...headerLines(entry)]

  const contentType = fieldValue(lines, 'Content-Type')
  if (contentType !== undefined) {
    const charset = /charset\s*=\s*([^\s;]+)/i.exec(contentType)?.[1]
    if (charset !== undefined && charset.toLowerCase() !== 'utf-8') {
      throw new CatalogError(
        at,
        `catalog declares charset ${JSON.stringify(charset)}; this tool reads and writes UTF-8 only`,
      )
    }
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8')
  }

  const language = fieldValue(lines, 'Language')
  if (language === undefined) {
    lines.unshift(`Language: ${locale}`)
  } else if (language !== locale) {
    const index = lines.findIndex((line) => line.toLowerCase().startsWith('language:'))
    lines[index] = `Language: ${locale}`
  }

  const rebuilt = headerEntry(lines)
  return rebuilt.msgstr[0] === entry.msgstr[0] ? entry : { ...entry, msgstr: rebuilt.msgstr }
}

/** Build the typed view of one PO entry. */
export function toCatalogEntry(po: PoEntry, id: UnitId): CatalogEntry {
  const provenance = readProvenance(po.comments)
  return {
    id,
    source: po.msgid,
    translation: po.msgstr[0] ?? '',
    state: unitStateOf(po),
    obsolete: po.obsolete,
    recordedHash: provenance.sourceHash,
    reference: provenance.reference,
    previousSource: po.previous?.msgid,
    po,
  }
}

/** An empty catalog for a locale that has none yet. */
export function emptyCatalog(identity: CatalogIdentity): Catalog {
  return {
    identity,
    header: headerEntry(HEADER_LINES(identity.locale)),
    entries: [],
    obsolete: [],
  }
}

/**
 * Read a parsed PO file as a catalog, validating every identity it contains.
 *
 * @throws {CatalogError} for a non-header entry without a `msgctxt`, an id that fails
 *   the safety gate, or a header that declares a charset other than UTF-8.
 * @throws {DuplicateCatalogEntryError} when one id is used by two entries.
 * @throws {UnsupportedPoError} for a plural entry carrying a unit id — plurals are
 *   parsed and preserved by the codec, but the unit model has no plural forms in v1 and
 *   guessing one would be a silent drop.
 */
export function readCatalog(file: PoFile, options: ReadCatalogOptions): Catalog {
  const { identity, fileName } = options
  const entries: CatalogEntry[] = []
  const obsolete: CatalogEntry[] = []
  const seen = new Map<string, number>()

  const first = file.entries[0]
  const header =
    first !== undefined && isHeaderEntry(first)
      ? ensureHeader(first, identity.locale, { fileName, line: first.line })
      : headerEntry(HEADER_LINES(identity.locale))

  let headerLine: number | undefined
  for (const po of file.entries) {
    if (isHeaderEntry(po)) {
      // Two header entries are two messages with the same (empty) msgid and no context.
      // msgfmt refuses that, and silently keeping the first would drop whichever header
      // fields the second one carried.
      if (headerLine !== undefined) {
        throw new CatalogError(
          { fileName, line: po.line },
          `catalog has two header entries, at lines ${headerLine} and ${po.line}`,
        )
      }
      headerLine = po.line
      continue
    }
    const at: PoLocation = { fileName, line: po.line }

    if (po.msgctxt === undefined) {
      throw new CatalogError(at, 'entry has no msgctxt; msgctxt carries the stable unit id')
    }
    if (po.msgidPlural !== undefined) {
      throw new UnsupportedPoError(
        at,
        `entry ${JSON.stringify(po.msgctxt)} uses plural forms, which this tool preserves but does not translate`,
      )
    }

    let id: UnitId
    try {
      id = parseSafeUnitId(po.msgctxt)
    } catch (error) {
      if (error instanceof UnitIdError) {
        throw new CatalogError(at, `invalid unit id in msgctxt — ${error.message}`)
      }
      throw error
    }

    const key = formatUnitId(id)
    const previousLine = seen.get(key)
    if (previousLine !== undefined) {
      throw new DuplicateCatalogEntryError(at, key, [previousLine, po.line])
    }
    seen.set(key, po.line)
    ;(po.obsolete ? obsolete : entries).push(toCatalogEntry(po, id))
  }

  const byId = (a: CatalogEntry, b: CatalogEntry) => compareUnitIds(a.id, b.id)
  return {
    identity,
    header,
    entries: entries.sort(byId),
    obsolete: obsolete.sort(byId),
  }
}

/** Parse catalog text. Syntax failures surface as {@link PoSyntaxError}. */
export function parseCatalog(text: string, options: ReadCatalogOptions): Catalog {
  return readCatalog(parsePo(text, { fileName: options.fileName }), options)
}

/** Render a catalog in its canonical spelling. */
export function serializeCatalog(catalog: Catalog): string {
  return serializePo({
    entries: [
      catalog.header,
      ...catalog.entries.map((entry) => entry.po),
      ...catalog.obsolete.map((entry) => entry.po),
    ],
  })
}

/**
 * Project a catalog onto core's {@link UnitStatus} shape, for `status` and policy.
 *
 * **Only `state` comes from the catalog.** `section` is this catalog's name and `locale`
 * its locale; `required` is deliberately never set, because requiredness is an operator
 * decision and must not be derivable from catalog content (constitution V). Core's
 * `statusesForLocale` enforces the same boundary from the other side, and joining
 * against the English unit set there — not here — is what makes an absent catalog report
 * `missing` rather than nothing at all.
 *
 * Obsolete entries are excluded: they describe content that no longer exists in English
 * and must not count toward a gate.
 */
export function catalogStatuses(catalog: Catalog): readonly UnitStatus[] {
  return catalog.entries.map((entry) => ({
    id: entry.id,
    locale: catalog.identity.locale,
    section: catalog.identity.name,
    state: entry.state,
  }))
}
