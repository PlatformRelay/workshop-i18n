/**
 * `workshop-i18n init-ids [--check]` — spec 001 User Story 1 (FR-001, FR-002).
 *
 * The one command allowed to write English (constitution I), and only ever an insertion:
 * a `slideId:` frontmatter line per slide (plus the delimiters, for a slide that had no
 * block) and a `<!-- labId: … -->` marker per lab. The planning is the extractor
 * packages' (`planSlideIds`, `planLabId`); this module decides *which* files, in which
 * order, with which cross-file uniqueness set, and writes the results.
 *
 * Quiz question ids are authored — the consumers' own JSON Schema requires them — so for
 * the quiz this command only checks: it never writes a bank.
 *
 * ## Failure handling
 *
 * All files are read before any is written, so an unreadable file (invalid UTF-8, a
 * symlink) aborts with the tree untouched (exit 65). A file the planner cannot adopt
 * safely — an unclosed frontmatter block, a separator Slidev would misread — is left
 * byte-for-byte as it was and reported, while every other file is adopted: each write is
 * an atomic, idempotent insertion, so a partial adoption is safe to re-run, and blocking
 * 400 slides on one broken file would help nobody. The run then exits 1, because the tree
 * still fails `--check`.
 */

import { posix } from 'node:path'
import type { QuizSchemaVariant } from '@workshop-i18n/core'
import {
  checkLabIds,
  collectLabIds,
  type LabIdIssue,
  planLabId,
} from '@workshop-i18n/extract-markdown'
import {
  locateQuizFile,
  memberOf,
  positionAt,
  QUIZ_SHAPES,
  hasErrors as quizHasErrors,
  scanJson,
} from '@workshop-i18n/extract-quiz'
import {
  checkSlideIds,
  collectSlideIds,
  planSlideIds,
  type SlideIdIssue,
} from '@workshop-i18n/extract-slidev'
import type { SurfaceFile } from './discover.js'
import { EXIT } from './exit-codes.js'
import { assertNoSymlink, insideRoot } from './paths.js'
import { compareStrings, count, formatDiagnostic } from './report.js'
import type { Command, CommandContext } from './run.js'
import { ofSurface, readSources, type SourceFile, type Sources } from './sources.js'
import { loadWorkspace, type Workspace } from './workspace.js'

/** The path of `file` below its glob base, without the extension. */
function stemBelowBase(file: SurfaceFile): string {
  const relative = file.base === '' ? file.path : file.path.slice(file.base.length + 1)
  const extension = posix.extname(relative)
  return extension === '' ? relative : relative.slice(0, -extension.length)
}

/**
 * The section a slide file's proposed ids are prefixed with: the file's own name, or its
 * directory's name when the file is an `index` (`pages/S05-pod/index.md` -> `S05-pod`).
 * Only a *proposal* input — the id is written once and never recomputed (ADR 0005).
 */
export function slideSectionId(file: SurfaceFile): string {
  const segments = stemBelowBase(file).split('/')
  if (segments.length > 1 && segments[segments.length - 1] === 'index') segments.pop()
  return segments[segments.length - 1] ?? ''
}

/** The path stem a lab's proposed id is derived from (`labs/day-1/05-pod.md` -> `day-1/05-pod`). */
export function labPathStem(file: SurfaceFile): string {
  return stemBelowBase(file)
}

/** What one surface's pass found and did. */
interface SurfaceOutcome {
  readonly summary: string
  readonly problems: readonly string[]
  readonly writes: readonly { readonly file: SourceFile; readonly text: string }[]
}

function issueLine(issue: SlideIdIssue | LabIdIssue): string {
  return `error: ${issue.message} [${issue.code}]`
}

function asCheckFile(file: SourceFile): { readonly path: string; readonly source: string } {
  return { path: file.path, source: file.text }
}

function planSlides(files: readonly SourceFile[], check: boolean): SurfaceOutcome {
  const taken = new Set<string>()
  for (const file of files) {
    for (const record of collectSlideIds(file.text)) {
      if (record.slideId !== undefined) taken.add(record.slideId)
    }
  }
  const problems: string[] = []
  const writes: { file: SourceFile; text: string }[] = []
  const after: { path: string; source: string }[] = []
  let slides = 0
  let added = 0
  for (const file of files) {
    const plan = planSlideIds(file.text, { sectionId: slideSectionId(file), taken })
    for (const insertion of plan.insertions) taken.add(insertion.slideId)
    for (const diagnostic of plan.diagnostics) {
      if (diagnostic.severity === 'error') problems.push(formatDiagnostic(file.path, diagnostic))
    }
    slides += collectSlideIds(plan.text).length
    added += plan.insertions.length
    if (plan.text !== file.text) writes.push({ file, text: plan.text })
    after.push({ path: file.path, source: plan.text })
  }
  // The lint runs over what the tree *will be*: the original under --check, the adopted
  // text otherwise — so an apply run reports exactly what the next --check will say. The
  // planner's own errors stay in the list too: they say *why* a slide is still missing.
  problems.push(...checkSlideIds(check ? files.map(asCheckFile) : after).map(issueLine))
  return {
    summary: `slides: ${count(files.length, 'file')}, ${count(slides, 'slide')}, ${count(added, 'id')} added`,
    problems,
    writes,
  }
}

function planLabs(files: readonly SourceFile[], check: boolean): SurfaceOutcome {
  const taken = new Set<string>()
  for (const file of files) {
    for (const record of collectLabIds(file.text)) taken.add(record.labId)
  }
  const problems: string[] = []
  const writes: { file: SourceFile; text: string }[] = []
  const after: { path: string; source: string }[] = []
  let added = 0
  for (const file of files) {
    const plan = planLabId(file.text, { pathStem: labPathStem(file), taken })
    if (plan.labId !== undefined) taken.add(plan.labId)
    for (const diagnostic of plan.diagnostics) {
      if (diagnostic.severity === 'error') problems.push(formatDiagnostic(file.path, diagnostic))
    }
    if (plan.insertion !== undefined) {
      added += 1
      writes.push({ file, text: plan.text })
    }
    after.push({ path: file.path, source: plan.text })
  }
  problems.push(...checkLabIds(check ? files.map(asCheckFile) : after).map(issueLine))
  return {
    summary: `labs: ${count(files.length, 'file')}, ${count(files.length, 'lab')}, ${count(added, 'id')} added`,
    problems,
    writes,
  }
}

/** Where each question id is declared, for cross-bank duplicate reporting. */
function questionIdLines(text: string, schema: QuizSchemaVariant): ReadonlyMap<string, number> {
  const lines = new Map<string, number>()
  const questions = memberOf(scanJson(text), QUIZ_SHAPES[schema].questionsKey)
  if (questions?.kind !== 'array') return lines
  for (const question of questions.items) {
    const id = memberOf(question, 'id')
    if (id?.kind === 'string' && !lines.has(id.value)) {
      lines.set(id.value, positionAt(text, id.start).line)
    }
  }
  return lines
}

function checkQuiz(files: readonly SourceFile[], schema: QuizSchemaVariant): SurfaceOutcome {
  const problems: string[] = []
  const declared = new Map<string, string[]>()
  let questions = 0
  for (const file of files) {
    const located = locateQuizFile(file.text, { schema })
    for (const diagnostic of located.diagnostics) {
      if (diagnostic.severity === 'error') problems.push(formatDiagnostic(file.path, diagnostic))
    }
    questions += located.questionIds.length
    if (quizHasErrors(located.diagnostics)) continue
    const lines = questionIdLines(file.text, schema)
    for (const id of located.questionIds) {
      const places = declared.get(id) ?? []
      places.push(`${file.path}:${lines.get(id) ?? 1}`)
      declared.set(id, places)
    }
  }
  for (const [id, places] of [...declared].sort(([a], [b]) => compareStrings(a, b))) {
    if (places.length < 2) continue
    problems.push(
      `error: question id ${JSON.stringify(id)} is declared in ${places.join(' and ')} [duplicate-question-id]`,
    )
  }
  return {
    summary: `quiz: ${count(files.length, 'file')}, ${count(questions, 'question')} (ids are authored, checked only)`,
    problems,
    writes: [],
  }
}

function planAll(
  workspace: Workspace,
  sources: Sources,
  check: boolean,
): readonly SurfaceOutcome[] {
  const outcomes: SurfaceOutcome[] = []
  for (const spec of workspace.manifest.surfaces) {
    const files = ofSurface(sources, spec.surface)
    if (spec.surface === 'quiz') outcomes.push(checkQuiz(files, spec.schema))
    else if (spec.surface === 'slides') outcomes.push(planSlides(files, check))
    else outcomes.push(planLabs(files, check))
  }
  return outcomes
}

function execute({ io, root, values }: CommandContext): number {
  const workspace = loadWorkspace(io, root)
  const sources = readSources(workspace)
  for (const warning of sources.warnings) io.stderr(`warning: ${warning}\n`)
  const outcomes = planAll(workspace, sources, values.check === true)
  const problems = outcomes.flatMap((outcome) => outcome.problems)

  if (values.check === true) {
    for (const problem of problems) io.stderr(`${problem}\n`)
    const inventory = outcomes.map((outcome) => outcome.summary.replace(/, \d+ ids? added$/, ''))
    if (problems.length > 0) {
      io.stdout(
        `init-ids --check: ${count(problems.length, 'identity problem')}; run init-ids, then fix what it reports\n`,
      )
      return EXIT.FAILED
    }
    io.stdout(
      `init-ids --check: every slide, lab and quiz question carries an explicit identity (${inventory.join('; ')})\n`,
    )
    return EXIT.OK
  }

  const writes = outcomes.flatMap((outcome) => outcome.writes)
  // Validate every target before the first write, so a symlink planted on any path aborts
  // the run with nothing written rather than half-way through.
  for (const { file } of writes) assertNoSymlink(io.fs, workspace.root, file.path)
  for (const { file, text } of writes) io.fs.writeFile(insideRoot(workspace.root, file.path), text)
  for (const outcome of outcomes) io.stdout(`init-ids ${outcome.summary}\n`)
  for (const problem of problems) io.stderr(`${problem}\n`)
  if (problems.length > 0) {
    io.stdout(`init-ids: ${count(problems.length, 'identity problem')} left for a human to fix\n`)
    return EXIT.FAILED
  }
  return EXIT.OK
}

/** The `init-ids` command. */
export const initIdsCommand: Command = {
  name: 'init-ids',
  summary: 'insert explicit slide and lab identities; --check lints them for CI',
  help: '  --check        write nothing; exit 1 naming every missing, duplicate or unsafe id',
  options: { check: { type: 'boolean' } },
  execute,
}
