/**
 * Extraction: one lab file, located (spec 001 User Story 2, FR-004).
 *
 * This wires the identity marker and the prose locator together and turns the located
 * spans into holes carrying identities. It never re-serializes anything, so the skeleton
 * it returns is the source file itself (ADR 0012).
 *
 * ## Identity is a precondition, not a fallback
 *
 * A lab without a `labId` marker cannot be extracted: any identity invented for it would
 * be derived from its path or its position, which is exactly what ADR 0005 and
 * constitution II forbid, and the derived id would silently re-point every translation
 * the first time the file is renamed. So a missing, unsafe or duplicated `labId` is a
 * hard error naming the line, and the fix is `init-ids` — the one operator-invoked
 * codemod allowed to touch English (constitution I).
 *
 * `locateLabFile` returns everything it found including the diagnostics;
 * `extractLabFile` is the same call that fails closed on an error, which is what the
 * `extract` command wants. Both reproduce the file byte-for-byte from an empty catalog,
 * refused files included — refusing is not the same as mangling.
 */

import {
  formatUnitId,
  type TranslationUnit,
  type UnitId,
  validateUnitId,
} from '@workshop-i18n/core'
import { type Diagnostic, diagnostic, hasErrors } from './diagnostic.js'
import { collectLabIds, LAB_ID_KEY } from './lab-id.js'
import { locateProse } from './prose.js'
import { createSkeleton, type Hole, type Skeleton, skeletonUnits } from './skeleton.js'

/** Everything one lab file yielded. */
export interface LabExtraction {
  /** The source plus its holes — feed it to `composeSkeleton`. */
  readonly skeleton: Skeleton
  /** The units, in identity order. */
  readonly units: readonly TranslationUnit[]
  /** The identity the file declares, or `undefined` when it declares none usable. */
  readonly labId: string | undefined
  readonly diagnostics: readonly Diagnostic[]
}

/** Thrown by {@link extractLabFile} when the file cannot be extracted as written. */
export class LabExtractionError extends Error {
  readonly diagnostics: readonly Diagnostic[]
  /** Caller-supplied label for the file, if any. */
  readonly source: string | undefined

  constructor(diagnostics: readonly Diagnostic[], source?: string) {
    const errors = diagnostics.filter((item) => item.severity === 'error')
    const where = source === undefined ? 'lab file' : `lab file ${source}`
    super(
      `cannot extract ${where}: ${errors.map((item) => `line ${item.line}: ${item.message}`).join('; ')}`,
    )
    this.name = 'LabExtractionError'
    this.diagnostics = diagnostics
    this.source = source
  }
}

/**
 * Locate every translatable unit in one lab file, reporting rather than throwing.
 *
 * Use this for `--check`-style reporting; {@link extractLabFile} is the same thing with
 * the gate closed.
 */
export function locateLabFile(source: string): LabExtraction {
  const records = collectLabIds(source)
  const declared = records[0]
  const diagnostics: Diagnostic[] = []

  if (records.length > 1) {
    const second = records[1] as (typeof records)[number]
    diagnostics.push(
      diagnostic(
        source,
        'duplicate-lab-id',
        'error',
        `this file declares ${LAB_ID_KEY} on line ${declared?.line} and line ${second.line}; a lab has exactly one identity`,
        second.start,
        second.end,
      ),
    )
  } else if (declared === undefined) {
    diagnostics.push(
      diagnostic(
        source,
        'missing-lab-id',
        'error',
        `lab has no ${LAB_ID_KEY} marker; run init-ids to give it a stable identity (ADR 0005)`,
        0,
        Math.min(source.length, source.indexOf('\n') + 1 || source.length),
      ),
    )
  } else if (declared.unsafe) {
    diagnostics.push(
      diagnostic(
        source,
        'unsafe-lab-id',
        'error',
        `${LAB_ID_KEY} ${JSON.stringify(declared.labId)} is not usable as a container id: it becomes a file name and a PO msgctxt`,
        declared.start,
        declared.end,
      ),
    )
  }

  const labId = hasErrors(diagnostics) ? undefined : declared?.labId
  if (labId === undefined) {
    // No identity means no units — but the skeleton is still the file, so composition
    // reproduces it exactly. Refusing is not mangling.
    return { skeleton: createSkeleton(source, []), units: [], labId: undefined, diagnostics }
  }

  const located = locateProse(source, { start: 0, end: source.length, root: 'body' })
  diagnostics.push(...located.diagnostics)

  const holes: Hole[] = []
  for (const span of located.spans) {
    const id: UnitId = { surface: 'labs', containerId: labId, unitKey: span.unitKey }
    const issues = validateUnitId(id)
    if (issues.length > 0) {
      diagnostics.push(
        diagnostic(
          source,
          'unsafe-unit-key',
          'error',
          `unit identity ${formatUnitId(id)} is unsafe: ${issues.map((issue) => issue.message).join('; ')}`,
          span.start,
          span.end,
        ),
      )
      continue
    }
    holes.push({
      id,
      start: span.start,
      end: span.end,
      source: span.text,
      encoding: span.encoding,
    })
  }

  const skeleton = createSkeleton(source, holes)
  return { skeleton, units: skeletonUnits(skeleton), labId, diagnostics }
}

/**
 * Locate every translatable unit in one lab file, failing closed on anything that cannot
 * be extracted correctly as written.
 *
 * @throws {LabExtractionError} when any diagnostic is an error.
 */
export function extractLabFile(source: string, label?: string): LabExtraction {
  const extraction = locateLabFile(source)
  if (hasErrors(extraction.diagnostics)) {
    throw new LabExtractionError(extraction.diagnostics, label)
  }
  return extraction
}
