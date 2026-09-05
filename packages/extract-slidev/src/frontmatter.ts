/**
 * Locating the translatable text fields of a slide's frontmatter.
 *
 * Slidev layouts put real prose in YAML: `kicker`, `heading`, `leftHeading`, `story`.
 * That prose has to reach a translator, but the block around it — `layout`, `src`,
 * `image`, `lab`, `class`, `clicks` — is machinery that must not move a byte (spec 001
 * FR-005). So this locates *values*, not the block: it records the range of the scalar
 * node and leaves everything else, including the key, the quoting style and the
 * comments, to be copied through.
 *
 * ## Why the range covers the quotes
 *
 * A hole spans the whole scalar node, quotes included, while the unit's text is the
 * *decoded* value. Composition then has a choice at splice time: with no translation it
 * copies the original bytes, so `'It''s here'` stays exactly as the author wrote it; with
 * a translation it re-emits a double-quoted scalar, so a value containing a colon, a
 * newline or a quote cannot restructure the YAML around it. Handing the translator the
 * raw `'It''s here'` instead would leak YAML escaping into the catalog and make every
 * translator responsible for getting it right.
 *
 * ## Only string scalars
 *
 * A declared key holding a list, a mapping or a number is reported, never extracted.
 * `duration: 40` is a number to YAML and a number after translation too; guessing that
 * the author meant text is how a deck ends up with a quoted `"40"` where a layout
 * expected an integer.
 */

import { isSafeContainerId } from '@workshop-i18n/core'
import { isMap, isScalar, parseDocument } from 'yaml'
import type { FrontmatterBlock } from './deck.js'
import { type Diagnostic, diagnostic } from './diagnostic.js'

/** The frontmatter key carrying a slide's explicit identity (ADR 0005). */
export const SLIDE_ID_KEY = 'slideId'

/**
 * Frontmatter keys treated as translatable text unless the caller says otherwise.
 *
 * Taken from the Kubernetes-Workshop corpus, where these carry rendered prose and every
 * other key carries machinery. The list is deliberately an allowlist: over-extracting
 * turns a layout switch into translatable text and breaks the build in one locale, while
 * under-extracting leaves visible English that a human notices immediately.
 */
export const DEFAULT_FRONTMATTER_TEXT_KEYS: readonly string[] = Object.freeze([
  'day',
  'duration',
  'env',
  'heading',
  'kicker',
  'leftBadge',
  'leftHeading',
  'next',
  'note',
  'rightBadge',
  'rightHeading',
  'story',
  'subtitle',
  'title',
])

/** One translatable frontmatter value. */
export interface FrontmatterField {
  readonly key: string
  /** Inclusive start offset of the scalar node in the file, quotes included. */
  readonly start: number
  /** Exclusive end offset of the scalar node, trailing whitespace excluded. */
  readonly end: number
  /** The decoded value — no quotes, no YAML escapes. */
  readonly value: string
}

/** What one frontmatter block yielded. */
export interface FrontmatterLocation {
  readonly fields: readonly FrontmatterField[]
  /** The slide's explicit identity, when it carries a safe one. */
  readonly slideId: string | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Drop trailing whitespace from a scalar's range.
 *
 * `yaml` ends a block scalar's value range *after* the newline that terminates it.
 * Splicing over that newline would weld the next key onto the replacement
 * (`story: "…"clicks: 2`), so the range is pulled back to the last non-space byte.
 */
function trimRange(file: string, start: number, end: number): number {
  let last = end
  while (last > start && /\s/.test(file.charAt(last - 1))) last -= 1
  return last
}

/** Locate the translatable values and the slide identity in one frontmatter block. */
export function locateFrontmatter(
  file: string,
  block: FrontmatterBlock,
  textKeys: ReadonlySet<string>,
): FrontmatterLocation {
  const diagnostics: Diagnostic[] = []
  const fields: FrontmatterField[] = []
  const yaml = file.slice(block.bodyStart, block.bodyEnd)
  const document = parseDocument(yaml, { keepSourceTokens: false })

  if (document.errors.length > 0) {
    const first = document.errors[0]
    diagnostics.push(
      diagnostic(
        file,
        'malformed-frontmatter',
        'error',
        `frontmatter is not valid YAML: ${first?.message ?? 'unknown error'}`,
        block.start,
        block.end,
      ),
    )
    return { fields, slideId: undefined, diagnostics }
  }

  const contents = document.contents
  if (contents === null || (isScalar(contents) && contents.value === null)) {
    return { fields, slideId: undefined, diagnostics }
  }
  if (!isMap(contents)) {
    diagnostics.push(
      diagnostic(
        file,
        'malformed-frontmatter',
        'error',
        'frontmatter must be a mapping of keys to values',
        block.start,
        block.end,
      ),
    )
    return { fields, slideId: undefined, diagnostics }
  }

  let slideId: string | undefined
  for (const item of contents.items) {
    const key = isScalar(item.key) ? item.key.value : undefined
    if (typeof key !== 'string') continue
    const value = item.value

    if (key === SLIDE_ID_KEY) {
      const raw = isScalar(value) ? value.value : undefined
      if (typeof raw === 'string' && isSafeContainerId(raw)) {
        slideId = raw
      } else {
        diagnostics.push(
          diagnostic(
            file,
            'unsafe-slide-id',
            'error',
            `${SLIDE_ID_KEY} ${JSON.stringify(raw)} is not a safe container id — it becomes a file name and a PO msgctxt, so it must be letters, digits, ".", "_" and "-"`,
            block.start,
            block.end,
          ),
        )
      }
      continue
    }

    if (!textKeys.has(key)) continue
    if (!isScalar(value) || typeof value.value !== 'string' || value.range === null) {
      diagnostics.push(
        diagnostic(
          file,
          'non-scalar-text-field',
          'warning',
          `frontmatter key ${JSON.stringify(key)} is declared as translatable text but does not hold a string scalar, so it stays English`,
          block.start,
          block.end,
        ),
      )
      continue
    }
    const [rawStart, rawEnd] = value.range
    const start = block.bodyStart + rawStart
    const end = trimRange(file, start, block.bodyStart + rawEnd)
    if (start >= end) continue
    fields.push({ key, start, end, value: value.value })
  }

  return { fields, slideId, diagnostics }
}
