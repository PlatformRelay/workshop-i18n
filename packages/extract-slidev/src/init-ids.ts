/**
 * `init-ids` as a library (spec 001 User Story 1, FR-001/FR-002).
 *
 * This is the one codemod allowed to write English (constitution I), so it is built to
 * be *only* an insertion: every edit adds a `slideId:` line and, where a slide has no
 * frontmatter at all, the two delimiters around it. No existing byte moves, changes or
 * disappears, which is what makes the diff hand-reviewable across ~400 slides (SC-001)
 * and what the tests assert by deleting the recorded insertions and getting the original
 * file back.
 *
 * Everything here is pure: the caller reads and writes files. `planSlideIds` returns the
 * edits *and* the resulting text, so a `--check` run and an apply run share one code
 * path and cannot drift.
 *
 * ## Where a proposed id comes from
 *
 * Section plus heading, exactly as ADR 0005 schedules it: readable, derived once, and
 * then immutable — the id is written into the source and never recomputed, so later
 * heading edits do not move it. Uniqueness is enforced against ids already in the deck
 * and ids already proposed in this run, and every candidate must pass core's container-id
 * gate, so a heading that slugifies to a Windows device name (`con`, `aux`) or to nothing
 * at all still yields a usable id instead of an unwritable file name.
 */

import { isSafeContainerId, MAX_CONTAINER_ID_LENGTH } from '@workshop-i18n/core'
import { isSlideSeparatorLine, parseSlidevDeck, type SlideRange } from './deck.js'
import { type Diagnostic, diagnostic } from './diagnostic.js'
import { locateFrontmatter, SLIDE_ID_KEY } from './frontmatter.js'
import { locateProse } from './prose.js'
import { positionAt } from './source.js'

/** Frontmatter keys consulted, in order, for a slide's human title. */
const DEFAULT_HEADING_KEYS: readonly string[] = Object.freeze(['title', 'heading', 'kicker'])

/** Stem used when a slide offers nothing to name it after. */
const FALLBACK_STEM = 'slide'

/** Room reserved for a `-2`, `-3` … disambiguating suffix. */
const SUFFIX_HEADROOM = 8

/** Slidev's `RE_YAML_CODEBLOCK`: the frontmatter form that is a fence rather than a block. */
const YAML_CODEBLOCK_FRONTMATTER = /^\s*```ya?ml/

/** Options for {@link proposeSlideId}. */
export interface SlideIdProposalOptions {
  /** Slug identifying the file's section, e.g. `s19-rbac`; the CLI derives it from the path. */
  readonly sectionId: string
  /** Ids already in use anywhere in the deck. */
  readonly taken?: ReadonlySet<string>
}

/** Options for {@link planSlideIds}. */
export interface SlideIdPlanOptions extends Omit<SlideIdProposalOptions, 'taken'> {
  /** Ids already in use in *other* files; ids in this file are collected automatically. */
  readonly taken?: Iterable<string>
  /** Frontmatter keys to read a slide's title from. Defaults to `title`, `heading`, `kicker`. */
  readonly headingKeys?: readonly string[]
}

/** One `slideId` this run would add. */
export interface SlideIdInsertion {
  readonly slideIndex: number
  readonly slideId: string
  /** Offset in the *original* source at which {@link SlideIdInsertion.text} is inserted. */
  readonly offset: number
  /** Exactly the bytes added. Nothing else changes. */
  readonly text: string
}

/** The result of an `init-ids` run over one file. */
export interface SlideIdPlan {
  /** The source with every insertion applied. Equal to the input when nothing is missing. */
  readonly text: string
  /** Insertions in ascending offset order. Empty means the file is already adopted. */
  readonly insertions: readonly SlideIdInsertion[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Where one slide sits, for `--check` reporting. */
export interface SlideIdLocation {
  readonly path: string
  readonly slideIndex: number
  readonly line: number
  readonly column: number
}

/** One slide's identity as the source declares it. */
export interface SlideIdRecord {
  readonly slideIndex: number
  /** The declared identity, or `undefined` when it is missing or unsafe. */
  readonly slideId: string | undefined
  /** True when a `slideId` is present but not usable as a file name. */
  readonly unsafe: boolean
  readonly offset: number
  readonly line: number
  readonly column: number
}

/** One file handed to {@link checkSlideIds}. */
export interface SlideIdFile {
  readonly path: string
  readonly source: string
}

/** Why `init-ids --check` would fail. */
export interface SlideIdIssue {
  readonly code: 'missing-slide-id' | 'duplicate-slide-id' | 'unsafe-slide-id'
  /** The offending identity, when there is one. */
  readonly slideId: string | undefined
  readonly message: string
  /** Every place involved — two or more for a duplicate. */
  readonly locations: readonly SlideIdLocation[]
}

/**
 * Fold arbitrary prose into an id segment: ASCII letters and digits, `-` between runs.
 *
 * Diacritics are decomposed and dropped rather than transliterated, so `Bereiche` and
 * `Bereíche` fold to the same stem and nothing depends on a locale-sensitive mapping.
 */
function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Propose a stable, readable, unique identity for one slide.
 *
 * @throws {Error} when no unique candidate can be found, which needs a pathological
 *   number of collisions and would otherwise loop forever.
 */
export function proposeSlideId(
  heading: string | undefined,
  options: SlideIdProposalOptions,
): string {
  const taken = options.taken ?? new Set<string>()
  const section = slugify(options.sectionId)
  const stem = slugify(heading ?? '') || FALLBACK_STEM
  const joined = section === '' ? stem : `${section}-${stem}`
  const trimmed =
    joined.slice(0, MAX_CONTAINER_ID_LENGTH - SUFFIX_HEADROOM).replace(/-+$/, '') || FALLBACK_STEM
  // A heading of "CON" or "Aux" slugifies to a Windows device name, which core rejects
  // because a container id becomes a file. The escape is a word, not a number: `con-2`
  // reads as "the second slide called con", which is a different and misleading claim.
  const base = isSafeContainerId(trimmed) ? trimmed : `${trimmed}-${FALLBACK_STEM}`

  let candidate = base
  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    if (!taken.has(candidate) && isSafeContainerId(candidate)) return candidate
    candidate = `${base}-${attempt}`
  }
  throw new Error(`cannot propose a unique slideId from ${JSON.stringify(base)}`)
}

/** The line break used at `offset`, so an insertion matches the file it lands in. */
function lineBreakAt(source: string, offset: number): string {
  const next = source.indexOf('\n', offset)
  if (next === -1) return source.includes('\r\n') ? '\r\n' : '\n'
  return source.charAt(next - 1) === '\r' ? '\r\n' : '\n'
}

/** The human title of a slide: a declared frontmatter field, else its first prose. */
function headingOf(
  source: string,
  slide: SlideRange,
  headingKeys: readonly string[],
): string | undefined {
  const block = slide.frontmatter
  if (block !== undefined) {
    const located = locateFrontmatter(source, block, new Set(headingKeys))
    for (const key of headingKeys) {
      const field = located.fields.find((candidate) => candidate.key === key)
      if (field !== undefined && field.value.trim() !== '') return field.value
    }
  }
  const prose = locateProse(source, {
    start: slide.bodyStart,
    end: slide.bodyEnd,
    root: 'body',
  }).spans
  return (prose.find((span) => span.unitKey.endsWith('/title')) ?? prose[0])?.text
}

/**
 * Plan and apply the `slideId` insertions one file needs.
 *
 * A slide that already declares an identity is left untouched, which is what makes a
 * second run a no-op (spec 001 AS-2).
 */
export function planSlideIds(source: string, options: SlideIdPlanOptions): SlideIdPlan {
  const headingKeys = options.headingKeys ?? DEFAULT_HEADING_KEYS
  const deck = parseSlidevDeck(source)
  const diagnostics: Diagnostic[] = [...deck.diagnostics]
  const taken = new Set(options.taken ?? [])
  const insertions: SlideIdInsertion[] = []

  for (const record of collectSlideIds(source)) {
    if (record.slideId !== undefined) taken.add(record.slideId)
  }

  for (const slide of deck.slides) {
    const block = slide.frontmatter
    const located = block === undefined ? undefined : locateFrontmatter(source, block, new Set())
    if (located !== undefined) diagnostics.push(...located.diagnostics)
    if (located?.slideId !== undefined) continue
    // An id that is present but unsafe is a human decision, not something to overwrite.
    if (located?.diagnostics.some((item) => item.code === 'unsafe-slide-id')) continue

    // Slidev's `matter()` falls back to `RE_YAML_CODEBLOCK` when no `---` block matched,
    // so a slide opening with a ```yaml fence already *has* frontmatter. Inserting a `---`
    // block would win that race and demote the fence to rendered content, losing whatever
    // `layout` and `title` it declared. Refuse; the author converts it deliberately.
    if (block === undefined && YAML_CODEBLOCK_FRONTMATTER.test(source.slice(slide.bodyStart))) {
      diagnostics.push(
        diagnostic(
          source,
          'missing-slide-id',
          'error',
          'this slide declares its frontmatter as a yaml code block, which a "---" block would silently replace — convert it to a "---" block first',
          slide.bodyStart,
          slide.end,
        ),
      )
      continue
    }

    // A block written above a body that already opens with a separator line promotes that
    // line to a slide break: the slide splits, the new half has no identity, and the next
    // run inserts again. Idempotence (AS-2) is the property that catches this class.
    if (block === undefined) {
      const body = source.slice(slide.bodyStart, slide.end)
      const firstLine = body.slice(0, body.indexOf('\n') === -1 ? undefined : body.indexOf('\n'))
      if (isSlideSeparatorLine(firstLine)) {
        diagnostics.push(
          diagnostic(
            source,
            'missing-slide-id',
            'error',
            'this slide opens with a line Slidev reads as a slide break, so a frontmatter block written above it would split the slide instead of naming it',
            slide.bodyStart,
            slide.end,
          ),
        )
        continue
      }
    }

    // Slidev opens a frontmatter block only after a separator whose fourth character is
    // not a dash, so there is nowhere to put an id after `----`. Writing one anyway would
    // produce YAML the renderer shows as prose. The separator has to be fixed first.
    if (block === undefined && slide.separator !== undefined) {
      const text = source.slice(slide.separator.start, slide.separator.end).trimEnd()
      if (text.charAt(3) === '-') {
        diagnostics.push(
          diagnostic(
            source,
            'missing-slide-id',
            'error',
            'cannot give this slide an identity: Slidev opens no frontmatter block after a separator of four or more dashes, so change that line to exactly "---" first',
            slide.separator.start,
            slide.separator.end,
          ),
        )
        continue
      }
    }

    const slideId = proposeSlideId(headingOf(source, slide, headingKeys), {
      sectionId: options.sectionId,
      taken,
    })
    taken.add(slideId)

    const offset = block === undefined ? slide.start : block.bodyStart
    const eol = lineBreakAt(source, offset)
    const line = `${SLIDE_ID_KEY}: ${slideId}${eol}`
    const text =
      block !== undefined
        ? line
        : slide.start === 0
          ? `---${eol}${line}---${eol}`
          : `${line}---${eol}`
    insertions.push({ slideIndex: slide.index, slideId, offset, text })
  }

  let text = source
  for (let index = insertions.length - 1; index >= 0; index -= 1) {
    const insertion = insertions[index] as SlideIdInsertion
    text = text.slice(0, insertion.offset) + insertion.text + text.slice(insertion.offset)
  }
  return { text, insertions, diagnostics }
}

/** Read the identity every slide of one file declares, with its location. */
export function collectSlideIds(source: string): readonly SlideIdRecord[] {
  const deck = parseSlidevDeck(source)
  return deck.slides.map((slide) => {
    const block = slide.frontmatter
    const located = block === undefined ? undefined : locateFrontmatter(source, block, new Set())
    const offset = block?.start ?? slide.start
    const { line, column } = positionAt(source, offset)
    return {
      slideIndex: slide.index,
      slideId: located?.slideId,
      unsafe: located?.diagnostics.some((item) => item.code === 'unsafe-slide-id') ?? false,
      offset,
      line,
      column,
    }
  })
}

/**
 * The CI lint behind `init-ids --check` (FR-002): every slide must declare a safe,
 * unique identity. Returns an empty array when the deck is adopted; a non-empty one is
 * what makes the command exit non-zero.
 */
export function checkSlideIds(files: readonly SlideIdFile[]): readonly SlideIdIssue[] {
  const issues: SlideIdIssue[] = []
  const byId = new Map<string, SlideIdLocation[]>()

  for (const file of files) {
    for (const record of collectSlideIds(file.source)) {
      const location: SlideIdLocation = {
        path: file.path,
        slideIndex: record.slideIndex,
        line: record.line,
        column: record.column,
      }
      if (record.unsafe) {
        issues.push({
          code: 'unsafe-slide-id',
          slideId: undefined,
          message: `${file.path}:${record.line}: slideId is not usable as a file name`,
          locations: [location],
        })
        continue
      }
      if (record.slideId === undefined) {
        issues.push({
          code: 'missing-slide-id',
          slideId: undefined,
          message: `${file.path}:${record.line}: slide has no slideId; run init-ids`,
          locations: [location],
        })
        continue
      }
      const places = byId.get(record.slideId) ?? []
      places.push(location)
      byId.set(record.slideId, places)
    }
  }

  for (const [slideId, locations] of byId) {
    if (locations.length < 2) continue
    issues.push({
      code: 'duplicate-slide-id',
      slideId,
      message: `slideId ${JSON.stringify(slideId)} is declared in ${locations
        .map((location) => `${location.path}:${location.line}`)
        .join(' and ')}`,
      locations,
    })
  }

  return issues
}
