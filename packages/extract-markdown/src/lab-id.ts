/**
 * The lab identity scheme, and `init-ids` for it (spec 001 User Story 1, FR-001/FR-002).
 *
 * ## Why labs needed an identity scheme invented for them
 *
 * Slides carry `slideId` in Slidev frontmatter. Labs do not: a lab is one plain
 * Markdown file (consumer ADR 0012, superseding 0009) with no frontmatter at all, and
 * nothing in it is an identity. Its title (`# Lab 05 — Pod (S05)`) is prose that gets
 * reworded, its path is a path, and its position in `labs/day-N/` is an ordinal —
 * constitution II forbids all three as an address. So the scheme is defined here rather
 * than worked around.
 *
 * **A lab declares its identity in an HTML comment on its own line:**
 *
 * ```markdown
 * # Lab 05 — Pod (S05)
 *
 * <!-- labId: day-1-05-pod -->
 * ```
 *
 * Three reasons for that spelling rather than YAML frontmatter:
 *
 * 1. **The corpus already models it.** 26 of Kubernetes-Workshop's 28 participant labs
 *    carry `<!-- lab-contract:v1 -->` on the line after the H1 — exactly this position
 *    and exactly this spelling. (The two exceptions are `00-setup.md` and the deferred
 *    `24-kubebuilder.md` stub; the solution companions and all 61 OpenTofu labs carry no
 *    marker at all, so for those this convention is being introduced rather than
 *    followed.) A contributor who has seen one recognises the other without being taught.
 * 2. **It is invisible everywhere a lab is read.** A lab is a standalone file a
 *    participant reads on GitHub, in MkDocs, or in a text editor. GitHub renders YAML
 *    frontmatter in a `.md` file as a visible table; an HTML comment renders as nothing
 *    in all three. That keeps constitution I's "no machinery in the authoring surface"
 *    as close to true as an explicit identity can be.
 * 3. **It cannot change how the file parses.** Adding frontmatter to a file that had
 *    none changes what the first block of the document is; a comment does not.
 *
 * ## Where a proposed id comes from
 *
 * From the file's repo-relative path stem (`labs/day-1/05-pod` → `day-1-05-pod`, with
 * the caller choosing how much of the path to hand over), falling back to the H1 title
 * and then to a fixed stem. Deriving the *proposal* from the path is not addressing by
 * path: the id is written into the file once and never recomputed, so moving or renaming
 * the file afterwards leaves it untouched. Uniqueness is enforced against ids already
 * taken, and every candidate must pass core's container-id gate, so a stem that
 * slugifies to a Windows device name (`con`, `aux`) or to nothing at all still yields a
 * usable id instead of an unwritable file name.
 *
 * Everything here is pure: the caller reads and writes files. `planLabId` returns the
 * edit *and* the resulting text, so a `--check` run and an apply run share one code path
 * and cannot drift.
 */

import { isSafeContainerId, MAX_CONTAINER_ID_LENGTH } from '@workshop-i18n/core'
import { type Diagnostic, diagnostic } from './diagnostic.js'
import { positionAt } from './source.js'

/** The marker key a lab declares its identity under. */
export const LAB_ID_KEY = 'labId'

/** Stem used when a lab offers nothing to name it after. */
const FALLBACK_STEM = 'lab'

/** Room reserved for a `-2`, `-3` … disambiguating suffix. */
const SUFFIX_HEADROOM = 8

/**
 * A whole line that is nothing but the identity marker.
 *
 * The optional leading `﻿` is not decoration. A byte-order mark is a byte of the file
 * like any other — `decodeSource` deliberately keeps it — so on the first line it sits
 * *before* whatever else is there. A marker `init-ids` writes but `collectLabIds` cannot
 * read back makes the codemod non-idempotent, and every re-run leaves another dead
 * comment behind in English source.
 */
const LAB_ID_LINE = /^﻿?[ \t]*<!--[ \t]*labId:[ \t]*(\S+)[ \t]*-->[ \t]*$/
/** Fence delimiters, so a marker written inside a code sample is not an identity. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** An ATX heading, used to find the title a marker is inserted after. */
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/

/** Render the marker line a lab declares `labId` with. */
export function renderLabIdMarker(labId: string): string {
  return `<!-- ${LAB_ID_KEY}: ${labId} -->`
}

/** Options for {@link proposeLabId}. */
export interface LabIdProposalOptions {
  /** Repo-relative path with the extension removed, e.g. `labs/day-1/05-pod`. */
  readonly pathStem: string
  /** Ids already in use anywhere in the corpus. */
  readonly taken?: ReadonlySet<string>
}

/** Options for {@link planLabId}. */
export interface LabIdPlanOptions {
  readonly pathStem: string
  /** Ids already in use in *other* files. */
  readonly taken?: Iterable<string>
}

/** The `labId` marker one run would add. */
export interface LabIdInsertion {
  /** Offset in the *original* source at which {@link LabIdInsertion.text} is inserted. */
  readonly offset: number
  /** Exactly the bytes added. Nothing else changes. */
  readonly text: string
}

/** The result of an `init-ids` run over one lab file. */
export interface LabIdPlan {
  /** The source with the insertion applied. Equal to the input when nothing is missing. */
  readonly text: string
  /** The identity the file carries after the run, or `undefined` when it cannot get one. */
  readonly labId: string | undefined
  /** The edit, or `undefined` when the file was already adopted or must not be touched. */
  readonly insertion: LabIdInsertion | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/** One declared identity, with its location. */
export interface LabIdRecord {
  readonly labId: string
  /** Inclusive start offset of the marker line. */
  readonly start: number
  /** Exclusive end offset of the marker line, excluding its line break. */
  readonly end: number
  readonly line: number
  readonly column: number
  /** True when the declared id is not usable as a file name. */
  readonly unsafe: boolean
}

/** One file handed to {@link checkLabIds}. */
export interface LabIdFile {
  readonly path: string
  readonly source: string
}

/** Where one lab sits, for `--check` reporting. */
export interface LabIdLocation {
  readonly path: string
  readonly line: number
  readonly column: number
}

/** Why `init-ids --check` would fail. */
export interface LabIdIssue {
  readonly code: 'missing-lab-id' | 'duplicate-lab-id' | 'unsafe-lab-id'
  /** The offending identity, when there is one. */
  readonly labId: string | undefined
  readonly message: string
  /** Every place involved — two or more for a duplicate. */
  readonly locations: readonly LabIdLocation[]
}

/**
 * Fold arbitrary text into an id segment: ASCII letters and digits, `-` between runs.
 *
 * Diacritics are decomposed and dropped rather than transliterated, so `Bereiche` and
 * `Bereíche` fold to the same stem and nothing depends on a locale-sensitive mapping.
 */
function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Propose a stable, readable, unique identity for one lab.
 *
 * @throws {Error} when no unique candidate can be found, which needs a pathological
 *   number of collisions and would otherwise loop forever.
 */
export function proposeLabId(title: string | undefined, options: LabIdProposalOptions): string {
  const taken = options.taken ?? new Set<string>()
  const stem = slugify(options.pathStem) || slugify(title ?? '') || FALLBACK_STEM
  const trimmed =
    stem.slice(0, MAX_CONTAINER_ID_LENGTH - SUFFIX_HEADROOM).replace(/-+$/, '') || FALLBACK_STEM
  // A stem of "CON" or "aux" slugifies to a Windows device name, which core rejects
  // because a container id becomes a file. The escape is a word, not a number: `con-2`
  // reads as "the second lab called con", which is a different and misleading claim.
  const base = isSafeContainerId(trimmed) ? trimmed : `${trimmed}-${FALLBACK_STEM}`

  let candidate = base
  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    if (!taken.has(candidate) && isSafeContainerId(candidate)) return candidate
    candidate = `${base}-${attempt}`
  }
  throw new Error(`cannot propose a unique labId from ${JSON.stringify(base)}`)
}

/** One line outside a fence: its text, its range, and where the next line starts. */
interface SourceLine {
  readonly text: string
  /** Inclusive start offset of the line. */
  readonly start: number
  /** Exclusive end offset of the line's text, before any `\r` or `\n`. */
  readonly end: number
  /** Offset of the first byte of the next line — past the whole line break. */
  readonly next: number
}

/** Iterate the lines of `source` that are outside any fenced code block. */
function* unfencedLines(source: string): Generator<SourceLine> {
  let fence: { marker: string; length: number } | undefined
  let offset = 0
  for (const raw of source.split('\n')) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const start = offset
    offset += raw.length + 1
    const next = Math.min(offset, source.length)
    const match = FENCE.exec(text)
    const run = match?.[1]
    if (fence === undefined) {
      // An opening backtick fence may not carry a backtick in its info string.
      if (run !== undefined && (run[0] !== '`' || !(match?.[2] ?? '').includes('`'))) {
        fence = { marker: run[0] as string, length: run.length }
        continue
      }
      yield { text, start, end: start + text.length, next }
      continue
    }
    if (
      run !== undefined &&
      run[0] === fence.marker &&
      run.length >= fence.length &&
      (match?.[2] ?? '').trim() === ''
    ) {
      fence = undefined
    }
  }
}

/** Read every identity the file declares, in source order. */
export function collectLabIds(source: string): readonly LabIdRecord[] {
  const records: LabIdRecord[] = []
  for (const line of unfencedLines(source)) {
    const labId = LAB_ID_LINE.exec(line.text)?.[1]
    if (labId === undefined) continue
    const { line: row, column } = positionAt(source, line.start)
    records.push({
      labId,
      start: line.start,
      end: line.end,
      line: row,
      column,
      unsafe: !isSafeContainerId(labId),
    })
  }
  return records
}

/** Collect the identity problems of one file, so plan and extract agree on them. */
function identityDiagnostics(
  source: string,
  records: readonly LabIdRecord[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const first = records[0]
  if (records.length > 1) {
    const second = records[1] as LabIdRecord
    diagnostics.push(
      diagnostic(
        source,
        'duplicate-lab-id',
        'error',
        `this file declares ${LAB_ID_KEY} more than once (line ${first?.line} and line ${second.line}); a lab has exactly one identity`,
        second.start,
        second.end,
      ),
    )
    return diagnostics
  }
  if (first?.unsafe) {
    diagnostics.push(
      diagnostic(
        source,
        'unsafe-lab-id',
        'error',
        `${LAB_ID_KEY} ${JSON.stringify(first.labId)} is not usable as a container id: it becomes a file name and a PO msgctxt, so it must start with a letter or digit and use only letters, digits, ".", "_" and "-"`,
        first.start,
        first.end,
      ),
    )
  }
  return diagnostics
}

/** The line break used at `offset`, so an insertion matches the file it lands in. */
function lineBreakAt(source: string, offset: number): string {
  const next = source.indexOf('\n', offset)
  if (next === -1) return source.includes('\r\n') ? '\r\n' : '\n'
  return source.charAt(next - 1) === '\r' ? '\r\n' : '\n'
}

/**
 * Where the marker goes: after the file's opening H1 when it has one, otherwise at the
 * very top — but always *after* a byte-order mark, which must stay the first bytes.
 */
function insertionPoint(source: string): { offset: number; afterHeading: boolean } {
  const bom = source.startsWith('﻿') ? 1 : 0
  for (const line of unfencedLines(source)) {
    // The mark shares line 0 with the heading, so it is sliced off the *text* rather
    // than used to skip the line — skipping it hid the file's H1 from this scan, and the
    // marker then landed above the title instead of below it.
    const text = line.start === 0 ? line.text.slice(bom) : line.text
    if (text.trim() === '') continue
    if (ATX_HEADING.test(text)) return { offset: line.next, afterHeading: true }
    break
  }
  return { offset: bom, afterHeading: false }
}

/**
 * Plan and apply the `labId` marker one file needs.
 *
 * A file that already declares an identity is left untouched, which is what makes a
 * second run a no-op (spec 001 AS-2). An identity that is present but unsafe is a human
 * decision, not something to overwrite: it is reported, not replaced.
 */
export function planLabId(source: string, options: LabIdPlanOptions): LabIdPlan {
  const records = collectLabIds(source)
  const diagnostics = identityDiagnostics(source, records)
  const declared = records[0]
  if (declared !== undefined) {
    return {
      text: source,
      labId: declared.unsafe || records.length > 1 ? undefined : declared.labId,
      insertion: undefined,
      diagnostics,
    }
  }

  const { offset, afterHeading } = insertionPoint(source)
  const title = afterHeading ? headingTextAt(source, offset) : undefined
  const labId = proposeLabId(title, {
    pathStem: options.pathStem,
    taken: new Set(options.taken ?? []),
  })
  const eol = lineBreakAt(source, offset)
  const marker = renderLabIdMarker(labId)
  const text = afterHeading ? `${eol}${marker}${eol}` : `${marker}${eol}${eol}`
  return {
    text: source.slice(0, offset) + text + source.slice(offset),
    labId,
    insertion: { offset, text },
    diagnostics,
  }
}

/** The text of the heading immediately before `offset`, with its `#` run removed. */
function headingTextAt(source: string, offset: number): string | undefined {
  const line = source
    .slice(0, Math.max(0, offset - 1))
    .split('\n')
    .at(-1)
  return (
    line
      ?.replace(/^ {0,3}#{1,6}[ \t]*/, '')
      .replace(/[ \t]*#*[ \t]*$/, '')
      .trim() || undefined
  )
}

/**
 * The CI lint behind `init-ids --check` (FR-002): every lab must declare a safe, unique
 * identity. Returns an empty array when the corpus is adopted; a non-empty one is what
 * makes the command exit non-zero.
 */
export function checkLabIds(files: readonly LabIdFile[]): readonly LabIdIssue[] {
  const issues: LabIdIssue[] = []
  const byId = new Map<string, LabIdLocation[]>()

  for (const file of files) {
    const records = collectLabIds(file.source)
    const first = records[0]
    if (first === undefined) {
      issues.push({
        code: 'missing-lab-id',
        labId: undefined,
        message: `${file.path}: file declares no ${LAB_ID_KEY}; run init-ids to give it a stable identity`,
        locations: [{ path: file.path, line: 1, column: 1 }],
      })
      continue
    }
    const locations = records.map((record) => ({
      path: file.path,
      line: record.line,
      column: record.column,
    }))
    if (records.length > 1) {
      issues.push({
        code: 'duplicate-lab-id',
        labId: undefined,
        message: `${file.path}: declares ${LAB_ID_KEY} on lines ${records
          .map((record) => record.line)
          .join(' and ')}; a lab has exactly one identity`,
        locations,
      })
      continue
    }
    if (first.unsafe) {
      issues.push({
        code: 'unsafe-lab-id',
        labId: first.labId,
        message: `${file.path}:${first.line}: ${LAB_ID_KEY} ${JSON.stringify(first.labId)} is not usable as a file name`,
        locations: [locations[0] as LabIdLocation],
      })
      continue
    }
    const places = byId.get(first.labId) ?? []
    places.push(locations[0] as LabIdLocation)
    byId.set(first.labId, places)
  }

  for (const [labId, locations] of byId) {
    if (locations.length < 2) continue
    issues.push({
      code: 'duplicate-lab-id',
      labId,
      message: `${LAB_ID_KEY} ${JSON.stringify(labId)} is declared in ${locations
        .map((location) => `${location.path}:${location.line}`)
        .join(' and ')}`,
      locations,
    })
  }

  return issues
}
