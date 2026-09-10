/**
 * Aligning a translated lab to its English original (spec 004 User Story 1).
 *
 * A lab is one container, identified by the `<!-- labId: … -->` marker `init-ids` writes
 * (see `extract-markdown`'s `lab-id.ts`). A translated lab from a parallel tree has no
 * marker, so — as for slides — the English id is transplanted into the translated source
 * in memory, using `planLabId`'s own insertion so the file parses exactly as it would
 * after a real `init-ids`, and the translated lab then goes through the same extractor
 * as the English. Pairing a lab by its file pair is not ordinal at all: one file, one
 * container.
 *
 * Within the lab, `alignContainer`'s heading-scope rule decides which units pair. Labs
 * are long (the largest real one yields well over a hundred units), so scope-level
 * misses matter here: one reworded task costs that task's scope, not the whole lab.
 */

import {
  collectLabIds,
  extractLabFile,
  hasErrors,
  type LabExtraction,
  LabExtractionError,
  locateLabFile,
  planLabId,
  renderLabIdMarker,
} from '@workshop-i18n/extract-markdown'
import { alignContainer } from './align-container.js'
import {
  type AlignOptions,
  type FilePair,
  fileMiss,
  noDivergence,
  pairFiles,
  refuseTranslatedFile,
  resolveLimits,
  skeletonDivergence,
} from './pair.js'
import {
  type SectionAlignment,
  type SeedFile,
  SeedInputError,
  type SeedLimits,
  type SurfaceAlignment,
} from './types.js'

function extractEnglish(pair: FilePair): LabExtraction & { readonly labId: string } {
  let extraction: LabExtraction
  try {
    extraction = extractLabFile(pair.english, pair.path)
  } catch (error) {
    if (error instanceof LabExtractionError) {
      throw new SeedInputError(
        `English lab ${pair.path} cannot be extracted; seed needs an adopted lab (run init-ids): ${error.message}`,
        { cause: error },
      )
    }
    throw error
  }
  const { labId } = extraction
  if (labId === undefined) {
    throw new SeedInputError(`English lab ${pair.path} declares no labId; run init-ids first`)
  }
  return { ...extraction, labId }
}

type Transplant =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'container-id-conflict' | 'unreadable-translation' }

/** Write the English `labId` into the translated source, in memory. */
function transplantLabId(text: string, labId: string): Transplant {
  const records = collectLabIds(text)
  if (records.length > 1) return { ok: false, reason: 'unreadable-translation' }
  const declared = records[0]
  if (declared !== undefined) {
    return declared.labId === labId && !declared.unsafe
      ? { ok: true, text }
      : { ok: false, reason: 'container-id-conflict' }
  }
  const plan = planLabId(text, { pathStem: 'seed' })
  if (plan.insertion === undefined || plan.labId === undefined || hasErrors(plan.diagnostics)) {
    return { ok: false, reason: 'unreadable-translation' }
  }
  const proposed = renderLabIdMarker(plan.labId)
  if (!plan.insertion.text.includes(proposed)) {
    throw new Error(
      `init-ids insertion does not carry the marker it proposed: ${JSON.stringify(plan.insertion.text)}`,
    )
  }
  const written = plan.insertion.text.replace(proposed, renderLabIdMarker(labId))
  const { offset } = plan.insertion
  return { ok: true, text: text.slice(0, offset) + written + text.slice(offset) }
}

function alignLabFile(pair: FilePair, limits: SeedLimits): SectionAlignment {
  const english = extractEnglish(pair)
  const units = english.units
  const base = { surface: 'labs' as const, section: pair.path, englishUnits: units.length }

  const refused = refuseTranslatedFile(pair, units, limits)
  if (refused !== undefined) {
    return { ...base, drafts: [], misses: [refused], skeletonDivergence: noDivergence() }
  }

  const transplant = transplantLabId(pair.translated as string, english.labId)
  const located = transplant.ok ? locateLabFile(transplant.text) : undefined
  if (
    !transplant.ok ||
    located === undefined ||
    hasErrors(located.diagnostics) ||
    located.labId !== english.labId
  ) {
    const reason = transplant.ok ? 'unreadable-translation' : transplant.reason
    const detail =
      reason === 'container-id-conflict'
        ? 'the translated lab declares a different labId'
        : 'the translated lab cannot be extracted as written'
    return {
      ...base,
      drafts: [],
      misses: units.length === 0 ? [] : [fileMiss(reason, units, detail)],
      skeletonDivergence: noDivergence(),
    }
  }

  const aligned = alignContainer(
    english.labId,
    units,
    located.units.map((unit) => ({ unitKey: unit.id.unitKey, source: unit.source })),
    limits,
  )
  const whole = (source: string) => ({ start: 0, end: source.length })
  return {
    ...base,
    drafts: aligned.drafts,
    misses: aligned.misses,
    skeletonDivergence: skeletonDivergence(
      { source: pair.english, range: whole(pair.english), holes: english.skeleton.holes },
      {
        source: located.skeleton.source,
        range: whole(located.skeleton.source),
        holes: located.skeleton.holes,
      },
    ),
  }
}

/**
 * Align a translated labs tree against the English one.
 *
 * @throws {SeedInputError} when an English lab cannot be extracted, a path repeats, or a
 *   limit is exceeded. A translated file never throws; it misses.
 */
export function alignLabs(
  english: readonly SeedFile[],
  translated: readonly SeedFile[],
  options: AlignOptions = {},
): SurfaceAlignment {
  const limits = resolveLimits(options.limits)
  const { pairs, unpairedTranslated } = pairFiles(english, translated, limits)
  return {
    surface: 'labs',
    sections: pairs.map((pair) => alignLabFile(pair, limits)),
    unpairedTranslated,
  }
}
