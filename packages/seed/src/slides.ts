/**
 * Aligning a translated Slidev deck to its English original (spec 004 User Story 1).
 *
 * ## The translated deck has no identities, so it borrows the English ones
 *
 * A parallel tree like Kubernetes-Workshop PR #55 was translated before `init-ids` ran,
 * so its slides carry no `slideId`. Rather than invent a second way of addressing
 * slides, alignment **transplants** the English ids into the translated source, in
 * memory only, and then runs the translated deck through the very same extractor as the
 * English. Both sides then speak the same unit keys, and the container and unit checks
 * decide which of them may be paired.
 *
 * The transplant is ordinal — slide *n* of the translation receives the id of English
 * slide *n* — which is exactly the kind of addressing constitution II forbids for
 * identity. It is sound here only because it is fenced in on every side:
 *
 * - it happens **within one file pair**, never across files;
 * - it happens **only when both decks split into the same number of slides** (Slidev's
 *   own splitting rules, transcribed in `extract-slidev`); any difference misses the
 *   whole file rather than guessing which slide was added or dropped;
 * - every paired slide must then agree on its **non-prose frontmatter** (`layout`,
 *   `class`, … — everything but the declared text keys and `slideId`) and on its
 *   **language-independent fingerprint** (`fingerprint.ts`: unit keys, fence bodies without
 *   comments, code spans, URLs, components), so two different slides that happen to share
 *   a position are refused;
 * - that fingerprint must be **unique in both decks**: look-alike slides can be swapped,
 *   or one dropped and another added, without any trace, so position proves nothing about
 *   them and they miss as `ambiguous-position`;
 * - and within a paired slide, units are paired by `alignContainer`'s scope rule.
 *
 * ADR 0016 records this bounded exception to constitution II.
 *
 * The borrowed id never leaves this module: drafts carry the English unit ids, and the
 * translated text itself is never written anywhere but into a catalog `msgstr`.
 *
 * A translated deck that already declares ids is honoured only where they agree with the
 * English at the same position; a disagreeing id misses that slide as
 * `container-id-conflict`, because the two trees then disagree about identity itself.
 */

import type { TranslationUnit } from '@workshop-i18n/core'
import {
  collectSlideIds,
  DEFAULT_FRONTMATTER_TEXT_KEYS,
  type ExtractedSlide,
  extractSlidevFile,
  hasErrors,
  locateSlidevFile,
  parseSlidevDeck,
  planSlideIds,
  SLIDE_ID_KEY,
  type SlidevExtraction,
  SlidevExtractionError,
} from '@workshop-i18n/extract-slidev'
import { parse as parseYaml } from 'yaml'
import { alignContainer } from './align-container.js'
import {
  differingParts,
  type FingerprintParts,
  fingerprintKey,
  fingerprintParts,
} from './fingerprint.js'
import {
  type AlignOptions,
  addDivergence,
  byContainer,
  containerMiss,
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
  type SeedDraft,
  type SeedFile,
  SeedInputError,
  type SeedLimits,
  type SeedMiss,
  type SkeletonDivergence,
  type SurfaceAlignment,
} from './types.js'

/** Options for {@link alignSlides}. */
export interface SlidesAlignOptions extends AlignOptions {
  /** Frontmatter keys holding prose; must match what `extract` is configured with. */
  readonly frontmatterTextKeys?: readonly string[]
}

/**
 * A slide's identity-proof key: its frontmatter machinery plus its language-independent
 * fingerprint. Speaker-note structure is left out on purpose — translators re-wrap notes,
 * and `alignContainer` already misses a note that diverged without costing the body.
 */
function slideKey(
  source: string,
  slide: ExtractedSlide,
  units: readonly TranslationUnit[],
  machine: string | undefined,
): { readonly key: string | undefined; readonly parts: FingerprintParts } {
  const parts = fingerprintParts(
    source.slice(slide.range.bodyStart, slide.range.bodyEnd),
    units.map((unit) => unit.id.unitKey).filter((key) => !key.startsWith('note/')),
  )
  return { key: machine === undefined ? undefined : `${machine}\n${fingerprintKey(parts)}`, parts }
}

function tally(keys: Iterable<string | undefined>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const key of keys) if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

/** Deterministic rendering of a parsed YAML value, with object keys sorted. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * A slide's frontmatter with the prose and the identity removed — the machinery that
 * decides how the slide renders. `undefined` when the block is not readable YAML.
 */
function machinery(
  source: string,
  slide: ExtractedSlide,
  textKeys: ReadonlySet<string>,
): string | undefined {
  const block = slide.range.frontmatter
  if (block === undefined) return '{}'
  let parsed: unknown
  try {
    // `yaml` never executes content; its alias-expansion cap bounds a billion-laughs block.
    parsed = parseYaml(source.slice(block.bodyStart, block.bodyEnd), {
      maxAliasCount: 100,
      logLevel: 'error',
    })
  } catch {
    return undefined
  }
  if (parsed === null || parsed === undefined) return '{}'
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return canonical(parsed)
  const kept = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      ([key]) => key !== SLIDE_ID_KEY && !textKeys.has(key),
    ),
  )
  return canonical(kept)
}

type Transplant =
  | { readonly ok: true; readonly text: string; readonly conflicts: ReadonlySet<number> }
  | { readonly ok: false; readonly detail: string }

/**
 * Write the English slide ids into the translated source, in memory.
 *
 * Reuses `planSlideIds` for *where* and *how* an id is written — the same insertion the
 * `init-ids` codemod makes, so the transplanted deck splits exactly as the original does
 * — and only swaps the proposed id for the English one.
 */
function transplantSlideIds(text: string, englishIds: readonly string[]): Transplant {
  const conflicts = new Set<number>()
  for (const record of collectSlideIds(text)) {
    if (
      record.unsafe ||
      (record.slideId !== undefined && record.slideId !== englishIds[record.slideIndex])
    ) {
      conflicts.add(record.slideIndex)
    }
  }
  const plan = planSlideIds(text, { sectionId: 'seed' })
  if (hasErrors(plan.diagnostics)) {
    const first = plan.diagnostics.find((item) => item.severity === 'error')
    return {
      ok: false,
      detail: `the translated deck cannot be read as written (line ${first?.line}: ${first?.code})`,
    }
  }
  let result = text
  for (let index = plan.insertions.length - 1; index >= 0; index -= 1) {
    const insertion = plan.insertions[index]
    const englishId = insertion === undefined ? undefined : englishIds[insertion.slideIndex]
    if (insertion === undefined || englishId === undefined) {
      return {
        ok: false,
        detail: 'the translated deck splits differently once identities are added',
      }
    }
    const proposed = `${SLIDE_ID_KEY}: ${insertion.slideId}`
    if (!insertion.text.includes(proposed)) {
      throw new Error(
        `init-ids insertion does not carry the id it proposed: ${JSON.stringify(insertion.text)}`,
      )
    }
    const written = insertion.text.replace(proposed, `${SLIDE_ID_KEY}: ${englishId}`)
    result = result.slice(0, insertion.offset) + written + result.slice(insertion.offset)
  }
  return { ok: true, text: result, conflicts }
}

function extractEnglish(pair: FilePair, textKeys: readonly string[]): SlidevExtraction {
  try {
    return extractSlidevFile(pair.english, { frontmatterTextKeys: textKeys }, pair.path)
  } catch (error) {
    if (error instanceof SlidevExtractionError) {
      throw new SeedInputError(
        `English slides file ${pair.path} cannot be extracted; seed needs an adopted deck (run init-ids): ${error.message}`,
        { cause: error },
      )
    }
    throw error
  }
}

function alignSlidesFile(
  pair: FilePair,
  textKeys: readonly string[],
  limits: SeedLimits,
): SectionAlignment {
  const english = extractEnglish(pair, textKeys)
  const units = english.units
  const section = (
    drafts: readonly SeedDraft[],
    misses: readonly SeedMiss[],
    divergence: SkeletonDivergence = noDivergence(),
  ): SectionAlignment => ({
    surface: 'slides',
    section: pair.path,
    englishUnits: units.length,
    drafts,
    misses,
    skeletonDivergence: divergence,
  })

  const refused = refuseTranslatedFile(pair, units, limits)
  if (refused !== undefined) return section([], [refused])
  const translatedText = pair.translated as string

  const englishCount = parseSlidevDeck(pair.english).slides.length
  const translatedCount = parseSlidevDeck(translatedText).slides.length
  if (englishCount !== translatedCount) {
    return section(
      [],
      [
        fileMiss(
          'slide-count-mismatch',
          units,
          `the English deck has ${englishCount} slides and the translated deck ${translatedCount}; slides are paired by position only when the counts agree`,
        ),
      ],
    )
  }

  const englishIds: string[] = []
  for (const slide of english.slides) englishIds[slide.range.index] = slide.slideId
  const transplant = transplantSlideIds(translatedText, englishIds)
  const located = transplant.ok
    ? locateSlidevFile(transplant.text, { frontmatterTextKeys: textKeys })
    : undefined
  if (
    !transplant.ok ||
    located === undefined ||
    hasErrors(located.diagnostics) ||
    located.slides.length !== english.slides.length
  ) {
    const detail = transplant.ok
      ? 'the translated deck cannot be extracted once identities are added'
      : transplant.detail
    return section([], [fileMiss('unreadable-translation', units, detail)])
  }

  const textKeySet = new Set(textKeys)
  const englishUnits = byContainer(units)
  const translatedUnits = byContainer(located.units)
  const translatedByIndex = new Map(located.slides.map((slide) => [slide.range.index, slide]))
  const drafts: SeedDraft[] = []
  const misses: SeedMiss[] = []
  let divergence = noDivergence()

  // Fingerprint every slide of both decks first: pairing by position is only allowed for
  // a slide whose fingerprint matches the one at its position *and* is unique in both
  // decks, so that no drop, add or swap of look-alike slides can go unnoticed (ADR 0016).
  const ourKeys = new Map(
    english.slides.map((slide) => [
      slide.range.index,
      slideKey(
        pair.english,
        slide,
        englishUnits.get(slide.slideId) ?? [],
        machinery(pair.english, slide, textKeySet),
      ),
    ]),
  )
  const theirKeys = new Map(
    located.slides.map((slide) => [
      slide.range.index,
      slideKey(
        located.skeleton.source,
        slide,
        translatedUnits.get(slide.slideId) ?? [],
        machinery(located.skeleton.source, slide, textKeySet),
      ),
    ]),
  )
  const ourCounts = tally([...ourKeys.values()].map((entry) => entry.key))
  const theirCounts = tally([...theirKeys.values()].map((entry) => entry.key))

  for (const slide of english.slides) {
    const ours = englishUnits.get(slide.slideId) ?? []
    if (ours.length === 0) continue
    const theirSlide = translatedByIndex.get(slide.range.index)
    const miss = (reason: SeedMiss['reason'], detail: string) =>
      misses.push(containerMiss(reason, slide.slideId, ours, detail))

    if (theirSlide === undefined || transplant.conflicts.has(slide.range.index)) {
      miss(
        'container-id-conflict',
        'the translated slide declares a different slideId at this position',
      )
      continue
    }
    const ourMachinery = machinery(pair.english, slide, textKeySet)
    const theirMachinery = machinery(located.skeleton.source, theirSlide, textKeySet)
    if (theirMachinery === undefined || ourMachinery !== theirMachinery) {
      miss(
        'structure-diverged',
        'the slide frontmatter (layout, class, …) differs from the English',
      )
      continue
    }
    const ourKey = ourKeys.get(slide.range.index)
    const theirKey = theirKeys.get(slide.range.index)
    if (ourKey?.key === undefined || theirKey?.key === undefined || ourKey.key !== theirKey.key) {
      const parts = ourKey && theirKey ? differingParts(ourKey.parts, theirKey.parts) : []
      miss(
        'structure-diverged',
        `the slide at this position differs from the English in its ${parts.join(', ') || 'shape'}`,
      )
      continue
    }
    if ((ourCounts.get(ourKey.key) ?? 0) > 1 || (theirCounts.get(theirKey.key) ?? 0) > 1) {
      miss(
        'ambiguous-position',
        'another slide in the deck looks exactly like this one, so its position cannot prove which translation is its own',
      )
      continue
    }

    const theirs: readonly TranslationUnit[] = translatedUnits.get(theirSlide.slideId) ?? []
    const aligned = alignContainer(
      slide.slideId,
      ours,
      theirs.map((unit) => ({ unitKey: unit.id.unitKey, source: unit.source })),
      limits,
    )
    drafts.push(...aligned.drafts)
    misses.push(...aligned.misses)
    divergence = addDivergence(
      divergence,
      skeletonDivergence(
        { source: pair.english, range: slide.range, holes: english.skeleton.holes },
        { source: located.skeleton.source, range: theirSlide.range, holes: located.skeleton.holes },
      ),
    )
  }
  return section(drafts, misses, divergence)
}

/**
 * Align a translated slides tree against the English one.
 *
 * `english` must be adopted (every slide carries a `slideId`); `translated` is the
 * parallel tree as found, and is treated as hostile throughout.
 *
 * @throws {SeedInputError} when an English file cannot be extracted, a path repeats, or
 *   a limit is exceeded. A translated file never throws; it misses.
 */
export function alignSlides(
  english: readonly SeedFile[],
  translated: readonly SeedFile[],
  options: SlidesAlignOptions = {},
): SurfaceAlignment {
  const limits = resolveLimits(options.limits)
  const textKeys = options.frontmatterTextKeys ?? DEFAULT_FRONTMATTER_TEXT_KEYS
  const { pairs, unpairedTranslated } = pairFiles(english, translated, limits)
  return {
    surface: 'slides',
    sections: pairs.map((pair) => alignSlidesFile(pair, textKeys, limits)),
    unpairedTranslated,
  }
}
