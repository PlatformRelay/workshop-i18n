/**
 * `verify` for one composed file (spec 003 FR-004): every gate, run on the *output*.
 *
 * The verifier trusts nothing about how the composed file was made. It locates the
 * English source and the composed file afresh with the same extractor, proves the
 * protected skeleton byte-identical, and then judges each unit's rendered text against
 * its English by reading it back out of the composed file:
 *
 * - identical to the English → `source`;
 * - exactly the marked English → `fallback` (an error in release output);
 * - anything else → `translation`, which must pass markup parity and protected terms,
 *   and is measured against its layout's length budget.
 *
 * `composeLocale` runs this on everything it emits, so its output is proven rather than
 * assumed; a CLI `verify` runs it on a generated tree it did not produce.
 */

import {
  formatUnitId,
  lengthBudgetFor,
  type Manifest,
  type Surface,
  surfaceSpec,
} from '@workshop-i18n/core'
import { QUIZ_SURFACE_ENTRY, quizSchemaOf } from '@workshop-i18n/extract-quiz'
import {
  ComposeInputError,
  type ComposeMode,
  type Finding,
  type FindingSeverity,
  sortFindings,
} from './findings.js'
import { contentGateFailures, lengthBudgetWarning } from './gates.js'
import { isMarkedFallback } from './marker.js'
import { compareSkeletons, type LocateContext, type LocatedFile, locateFile } from './surface.js'

/** How a unit appears in a composed file. */
export type VerifiedRendering = 'source' | 'fallback' | 'translation'

/** One unit as the verifier read it back out of the composed file. */
export interface VerifiedUnit {
  readonly id: string
  readonly rendering: VerifiedRendering
}

/** What {@link verifyComposedFile} needs. */
export interface VerifyFileInput {
  readonly manifest: Manifest
  /** The file's path as the caller names it; used only in findings. */
  readonly path: string
  readonly surface: Surface
  /** The English source, decoded (`decodeSource`). */
  readonly english: string
  /** The composed locale file, decoded. */
  readonly composed: string
  /** `strict` additionally refuses marked English fallback. Defaults to `preview`. */
  readonly mode?: ComposeMode
  /** Slidev frontmatter keys treated as prose; must match what `extract` used. */
  readonly frontmatterTextKeys?: readonly string[]
}

/** The verdict for one file. */
export interface FileVerification {
  readonly path: string
  /** Sorted; see {@link sortFindings}. */
  readonly findings: readonly Finding[]
  /** Every unit, in source order; empty when the skeleton does not match. */
  readonly units: readonly VerifiedUnit[]
}

/**
 * The locate context the manifest implies for a surface.
 *
 * @throws {ComposeInputError} when the manifest does not declare the surface.
 */
export function locateContextFor(
  manifest: Manifest,
  surface: Surface,
  frontmatterTextKeys?: readonly string[],
): LocateContext {
  if (surfaceSpec(manifest, surface) === undefined) {
    throw new ComposeInputError(
      surface === 'quiz'
        ? `${QUIZ_SURFACE_ENTRY}: the manifest declares no quiz surface, so a quiz file cannot be composed or verified`
        : `surfaces.${surface}: the manifest does not declare this surface`,
    )
  }
  return {
    quizSchema: surface === 'quiz' ? quizSchemaOf(manifest) : undefined,
    frontmatterTextKeys,
  }
}

/** The length budget a unit is held to, or `undefined` for surfaces that do not overflow. */
export function budgetFor(
  manifest: Manifest,
  located: LocatedFile,
  containerId: string,
): { readonly budget: number; readonly layout: string | undefined } | undefined {
  // Labs scroll and quiz text wraps inside its component; ADR 0009's heuristic is about
  // fixed-size slide layouts, and applying it elsewhere would be noise nobody acts on.
  if (located.surface !== 'slides') return undefined
  const layout = located.layoutOf(containerId)
  return { budget: lengthBudgetFor(manifest, layout), layout }
}

/** Extractor diagnostics for the English source, as findings. */
export function extractionFindings(path: string, located: LocatedFile): readonly Finding[] {
  return located.diagnostics.map((item) => ({
    severity: item.severity,
    code: 'extraction',
    path,
    line: item.line,
    detail: item.code,
    message:
      item.severity === 'error'
        ? `the English source cannot be extracted as written, so it is copied untranslated: ${item.message}`
        : item.message,
  }))
}

/** Verify one composed file against its English source. Pure and deterministic. */
export function verifyComposedFile(input: VerifyFileInput): FileVerification {
  const context = locateContextFor(input.manifest, input.surface, input.frontmatterTextKeys)
  const english = locateFile(input.surface, input.english, context)
  const verification = verifyLocated(
    input.manifest,
    input.path,
    english,
    locateFile(input.surface, input.composed, context),
    input.mode ?? 'preview',
  )
  return {
    ...verification,
    findings: sortFindings([...extractionFindings(input.path, english), ...verification.findings]),
  }
}

/**
 * The verifier's core, over files already located — so `composeLocale`, which has just
 * located both sides, does not locate them again. Extraction findings are the caller's.
 */
export function verifyLocated(
  manifest: Manifest,
  path: string,
  english: LocatedFile,
  composed: LocatedFile,
  mode: ComposeMode,
): FileVerification {
  const findings: Finding[] = []
  const mismatch = compareSkeletons(english, composed)
  if (mismatch !== undefined) {
    findings.push({
      severity: 'error',
      code: 'skeleton-mismatch',
      path: path,
      line: mismatch.line,
      message: `${mismatch.message} — fences, frontmatter machinery, Vue islands and includes must be byte-identical to English; regenerate the file instead of editing it`,
    })
    return { path: path, findings: sortFindings(findings), units: [] }
  }

  const units: VerifiedUnit[] = []
  const gateSeverity: FindingSeverity = 'error'
  for (const [index, hole] of english.holes.entries()) {
    const rendered = composed.holes[index]?.source ?? hole.source
    const id = formatUnitId(hole.id)
    if (rendered === hole.source) {
      units.push({ id, rendering: 'source' })
      continue
    }
    if (isMarkedFallback(rendered, hole.source)) {
      units.push({ id, rendering: 'fallback' })
      if (mode === 'strict') {
        findings.push({
          severity: 'error',
          code: 'fallback-in-release',
          path: path,
          unitId: id,
          message: 'release output still shows marked English fallback for this unit',
        })
      }
      continue
    }
    units.push({ id, rendering: 'translation' })
    for (const failure of contentGateFailures(hole.source, rendered, manifest.protectedTerms)) {
      findings.push({
        severity: gateSeverity,
        code: failure.code,
        path: path,
        unitId: id,
        message: failure.message,
      })
    }
    const budget = budgetFor(manifest, english, hole.id.containerId)
    const warning =
      budget === undefined
        ? undefined
        : lengthBudgetWarning(hole.source, rendered, budget.budget, budget.layout)
    if (warning !== undefined) {
      findings.push({
        severity: 'warning',
        code: 'length-budget',
        path: path,
        unitId: id,
        message: warning,
      })
    }
  }
  return { path: path, findings: sortFindings(findings), units }
}
