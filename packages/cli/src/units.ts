/**
 * Extraction across the whole corpus: every covered file, through its surface's
 * extractor, into catalog-ready units (spec 001 US-2, FR-004..FR-007).
 *
 * The extractors are pure and fail closed per file; this module adds what only a
 * corpus-wide view can check — that no container identity is declared by two files, which
 * would otherwise surface much later as two catalogs fighting over one `msgctxt` — and
 * collects *every* error before refusing, so one run tells the operator everything that
 * needs fixing.
 */

import type { ExtractedUnit } from '@workshop-i18n/catalog-po'
import type { QuizSchemaVariant, Surface } from '@workshop-i18n/core'
import { locateLabFile } from '@workshop-i18n/extract-markdown'
import { locateQuizFile } from '@workshop-i18n/extract-quiz'
import { locateSlidevFile } from '@workshop-i18n/extract-slidev'
import { CliError, EXIT } from './exit-codes.js'
import { formatDiagnostic, type LocatedDiagnostic } from './report.js'
import type { SourceFile, Sources } from './sources.js'
import type { Workspace } from './workspace.js'

/** One file's extraction. */
export interface ExtractedFile {
  readonly file: SourceFile
  /** Explicit container identities the file declares (slides, the lab, questions). */
  readonly containers: readonly string[]
  /** Units in identity order, each carrying the file path as its reference. */
  readonly units: readonly ExtractedUnit[]
}

/** The whole corpus, extracted. */
export interface Extraction {
  readonly files: readonly ExtractedFile[]
  /** Formatted extractor warnings: coverage gaps that stayed English, not failures. */
  readonly warnings: readonly string[]
}

interface Located {
  readonly containers: readonly string[]
  readonly units: readonly {
    readonly id: ExtractedUnit['id']
    readonly source: string
    readonly sourceHash: string
  }[]
  readonly diagnostics: readonly LocatedDiagnostic[]
}

function locate(file: SourceFile, quizSchema: QuizSchemaVariant | undefined): Located {
  if (file.surface === 'slides') {
    const located = locateSlidevFile(file.text)
    return { ...located, containers: located.slides.map((slide) => slide.slideId) }
  }
  if (file.surface === 'labs') {
    const located = locateLabFile(file.text)
    return { ...located, containers: located.labId === undefined ? [] : [located.labId] }
  }
  // Discovery only yields quiz files when the manifest declares the quiz surface, and
  // core refuses a quiz surface without a schema, so this is always defined here.
  const located = locateQuizFile(file.text, { schema: quizSchema as QuizSchemaVariant })
  return { ...located, containers: located.questionIds }
}

/**
 * Extract every covered file.
 *
 * @throws {CliError} (`DATA`) listing every extractor error in the corpus, and every
 *   container identity two files both declare.
 */
export function extractCorpus(workspace: Workspace, sources: Sources): Extraction {
  const quiz = workspace.manifest.surfaces.find((spec) => spec.surface === 'quiz')
  const quizSchema = quiz?.surface === 'quiz' ? quiz.schema : undefined
  const errors: string[] = []
  const warnings: string[] = []
  const files: ExtractedFile[] = []
  const owners = new Map<string, string>()

  for (const file of sources.files) {
    const located = locate(file, quizSchema)
    for (const diagnostic of located.diagnostics) {
      const line = formatDiagnostic(file.path, diagnostic)
      if (diagnostic.severity === 'error') errors.push(line)
      else warnings.push(line)
    }
    for (const container of located.containers) {
      const key = `${file.surface satisfies Surface}:${container}`
      const owner = owners.get(key)
      if (owner !== undefined && owner !== file.path) {
        errors.push(
          `error: ${key} is declared in both ${owner} and ${file.path} [duplicate-container]`,
        )
      } else {
        owners.set(key, file.path)
      }
    }
    files.push({
      file,
      containers: located.containers,
      units: located.units.map((unit) => ({ ...unit, reference: file.path })),
    })
  }

  if (errors.length > 0) {
    throw new CliError(
      EXIT.DATA,
      [
        `cannot extract: ${errors.length} ${errors.length === 1 ? 'error' : 'errors'} in the English source (nothing was written)`,
        ...errors,
      ].join('\n'),
    )
  }
  return { files, warnings }
}
