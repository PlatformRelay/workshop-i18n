/**
 * The PO document model: a faithful, format-level view of a catalog file.
 *
 * This layer knows nothing about unit ids, source hashes or review states — it is the
 * gettext format and nothing else. Our conventions on top of it (`msgctxt` is the unit
 * id, `#.` carries provenance) live in `catalog.ts`, so the codec can stay total over
 * PO files this tool did not write.
 *
 * Everything a catalog can carry has a home here, including the parts we never
 * interpret. That is the losslessness bar from ADR 0013: a TMS that annotates entries
 * must find its annotations still there after the next `extract`.
 */

/**
 * One comment line, minus the leading `#`.
 *
 * `marker` is the class character (`.` extracted, `:` reference, `''` translator or an
 * unmodelled class), and `text` is the raw remainder including its leading space. Raw,
 * not trimmed: re-emitting `#` + marker + text is byte-exact, so a comment style we do
 * not recognise survives untouched instead of being reformatted into ours.
 */
export interface PoComment {
  readonly marker: '' | '.' | ':'
  readonly text: string
}

/**
 * Previous source recorded by `#|` (or `#~|` on an obsolete entry) — the diff context a
 * translator needs after an English edit (spec 002 FR-003). `gettext-parser` drops this
 * entirely, which is one of the reasons ADR 0013 rejects it.
 */
export interface PoPrevious {
  readonly msgctxt?: string | undefined
  readonly msgid?: string | undefined
  readonly msgidPlural?: string | undefined
}

/** One PO entry, live or obsolete. */
export interface PoEntry {
  /** Translator, extracted and reference comments, in the order they were read. */
  readonly comments: readonly PoComment[]
  /** `#,` flags in order, de-duplicated. */
  readonly flags: readonly string[]
  readonly previous?: PoPrevious | undefined
  readonly msgctxt?: string | undefined
  readonly msgid: string
  /** Present only on plural entries. Parsed and preserved; never synthesized (ADR 0013). */
  readonly msgidPlural?: string | undefined
  /** One element for a singular entry; one per plural form otherwise. */
  readonly msgstr: readonly string[]
  /** `#~` — a unit that left the English source. Its translation is kept, not deleted. */
  readonly obsolete: boolean
  /** 1-based line the entry starts on in its source file; `0` for entries built in memory. */
  readonly line: number
}

/** A parsed catalog file. The header is the entry with an empty `msgid` and no `msgctxt`. */
export interface PoFile {
  readonly entries: readonly PoEntry[]
}

/** True for the header pseudo-entry, whose `msgstr` carries the `Key: value` block. */
export function isHeaderEntry(entry: PoEntry): boolean {
  return entry.msgctxt === undefined && entry.msgid === '' && !entry.obsolete
}
