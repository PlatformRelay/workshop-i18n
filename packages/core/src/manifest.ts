/**
 * The consumer manifest, `.localization/workshop.yaml` (ADR 0003, spec 001 FR-003).
 *
 * Core stays pure, so this module parses a *string*: reading the file is the CLI's job
 * (constitution IV). The manifest is a protected contract (GOVERNANCE.md), which shapes
 * two decisions here:
 *
 * - **An unknown major `apiVersion` is a hard error, checked before anything else.**
 *   A newer manifest may mean anything; guessing at its fields is how a tool silently
 *   localizes the wrong content.
 * - **Unknown keys are rejected, not ignored.** A typo'd `protectedTerm` that parses to
 *   "no glossary" would disable the `verify` gate silently, which is a worse outcome
 *   than a failed parse. Additive changes within a major version therefore need a
 *   version bump — that is the cost of the contract, and it is deliberate.
 *
 * Every rejection names the offending path (`surfaces.quiz.schema`,
 * `locales.targets[1]`) and says what was wrong. Nothing here throws a bare cast error.
 */

import { parse as parseYaml } from 'yaml'
import { SURFACES, type Surface } from './unit-id.js'

/** The api group every supported manifest declares. */
export const MANIFEST_API_GROUP = 'workshop-i18n'

/** The single manifest major version this release understands. */
export const SUPPORTED_MANIFEST_MAJOR = 1

/** Quiz shapes the extractor knows (spec 001: neither variant matching is a hard error). */
export const QUIZ_SCHEMA_VARIANTS = Object.freeze([
  'kubernetes-workshop',
  'opentofu-workshop',
] as const)

/** One of {@link QUIZ_SCHEMA_VARIANTS}. */
export type QuizSchemaVariant = (typeof QUIZ_SCHEMA_VARIANTS)[number]

/**
 * Default target/source character ratio a translation may reach before `verify` calls
 * it a likely overflow (ADR 0009's length-budget heuristic).
 */
export const DEFAULT_LENGTH_BUDGET = 1.4

/** Source and target locales. */
export interface LocaleSet {
  /** The authoring locale. Defaults to `en`; never a target. */
  readonly source: string
  /** Locales to compose, in manifest order. */
  readonly targets: readonly string[]
}

/** Path globs for a prose surface. */
export interface MarkdownSurfaceSpec {
  readonly surface: 'slides' | 'labs'
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/** Path globs plus the schema variant for the structured quiz surface. */
export interface QuizSurfaceSpec {
  readonly surface: 'quiz'
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly schema: QuizSchemaVariant
}

/** One declared surface. */
export type SurfaceSpec = MarkdownSurfaceSpec | QuizSurfaceSpec

/**
 * Length budgets: a fallback ratio plus per-layout overrides.
 *
 * `default` is reserved in the manifest's `lengthBudgets` mapping: it sets this
 * fallback, so a Slidev layout genuinely named `default` cannot be given a budget of
 * its own — it gets the fallback, which is the same number every unlisted layout gets.
 * Left as is rather than renamed to a sigil (`"*"`), because the manifest is a protected
 * contract, `default` reads better than the alternatives, and the only content this
 * costs is a per-layout budget for a layout named `default` that differs from the
 * global one. If a consumer ever needs that, it is an ADR and a key rename, not a patch.
 */
export interface LengthBudgets {
  readonly default: number
  readonly byLayout: Readonly<Record<string, number>>
}

/** A validated manifest. Every field is normalized; defaults are already applied. */
export interface Manifest {
  /** As written, e.g. `workshop-i18n/v1`. */
  readonly apiVersion: string
  /** Major version parsed out of {@link Manifest.apiVersion}. */
  readonly apiMajor: number
  readonly locales: LocaleSet
  /** Declared surfaces, always in canonical `slides, labs, quiz` order. */
  readonly surfaces: readonly SurfaceSpec[]
  /** Glossary for the `verify` gate, in the order the author wrote it. */
  readonly protectedTerms: readonly string[]
  readonly lengthBudgets: LengthBudgets
}

/** What kind of problem a manifest issue is. */
export type ManifestIssueCode =
  | 'malformed-yaml'
  | 'unsupported-api-version'
  | 'missing'
  | 'invalid'
  | 'duplicate'
  | 'unknown-key'

/** One problem with one place in the manifest. */
export interface ManifestIssue {
  /** Dotted/bracketed path to the offending value, e.g. `surfaces.quiz.schema`. */
  readonly path: string
  readonly code: ManifestIssueCode
  /** Human-readable explanation, already prefixed with the path. */
  readonly message: string
}

/** Thrown by {@link parseManifest}. Carries every problem found, not just the first. */
export class ManifestError extends Error {
  readonly issues: readonly ManifestIssue[]
  /** Caller-supplied label for the manifest (usually its path), if any. */
  readonly source: string | undefined

  constructor(issues: readonly ManifestIssue[], source?: string) {
    const where = source === undefined ? 'manifest' : `manifest ${source}`
    super(`invalid ${where}: ${issues.map((issue) => issue.message).join('; ')}`)
    this.name = 'ManifestError'
    this.issues = issues
    this.source = source
  }
}

/** Options for {@link parseManifest}. */
export interface ParseManifestOptions {
  /** Label used in error messages, typically `.localization/workshop.yaml`. */
  readonly source?: string
}

/** The document root's own path label, used when a problem has no field to blame. */
const DOCUMENT_PATH = '<document>'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/
/**
 * `workshop-i18n/v<major>`, nothing else. The major is unpadded (`v1`, never `v01`):
 * a protected contract with two spellings of the same version is a contract with an
 * ambiguity, and `Number('01')` would have quietly accepted the second one.
 */
const API_VERSION = /^([a-z0-9-]+)\/v(0|[1-9]\d*)$/
/**
 * BCP 47 tags, and also safe directory names: `i18n/<locale>/` is a real path.
 *
 * Subtags after the language may be 1-8 characters, which admits singletons and
 * private-use sequences (`de-Latn-DE-x-a`, `es-419`) that a 2-3 character cap rejected.
 * The total length is capped separately — the shape is permissive, the path safety
 * comes from the charset (letters, digits and "-" only) plus that cap.
 */
const LOCALE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,8}$/
const MAX_LOCALE_TAG_LENGTH = 35
/** Layout names come from the deck; keep them plain so they can be printed and matched. */
const LAYOUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/**
 * Manifest strings reach reports and file names, so control characters are rejected.
 * Written as a scan rather than a regex: a regex spelling of this range is itself a
 * lint finding, and the intent is clearer stated once.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function childPath(parent: string, key: string): string {
  if (!IDENTIFIER.test(key)) return `${parent}[${JSON.stringify(key)}]`
  return parent === '' ? key : `${parent}.${key}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class IssueList {
  readonly issues: ManifestIssue[] = []

  add(path: string, code: ManifestIssueCode, detail: string): void {
    this.issues.push({ path, code, message: `${path}: ${detail}` })
  }

  get empty(): boolean {
    return this.issues.length === 0
  }
}

/** Validate one glob: repo-relative, POSIX, and unable to escape the working tree. */
function checkGlob(issues: IssueList, path: string, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    issues.add(path, 'invalid', `must be a string, got ${typeof value}`)
    return undefined
  }
  if (value === '') {
    issues.add(path, 'invalid', 'must not be empty')
    return undefined
  }
  if (hasControlCharacter(value)) {
    issues.add(path, 'invalid', 'must not contain control characters')
    return undefined
  }
  if (value.startsWith('/')) {
    issues.add(
      path,
      'invalid',
      `must be relative to the repository root, got ${JSON.stringify(value)}`,
    )
    return undefined
  }
  if (value.includes('\\')) {
    issues.add(path, 'invalid', 'must use "/" as the path separator')
    return undefined
  }
  if (value.split('/').includes('..')) {
    issues.add(path, 'invalid', 'must not escape the repository with ".."')
    return undefined
  }
  return value
}

function readGlobList(
  issues: IssueList,
  path: string,
  value: unknown,
  { required }: { required: boolean },
): readonly string[] {
  if (value === undefined) {
    if (required) issues.add(path, 'missing', 'is required')
    return []
  }
  if (!Array.isArray(value)) {
    issues.add(path, 'invalid', 'must be a list of path globs')
    return []
  }
  if (required && value.length === 0) {
    issues.add(path, 'invalid', 'must list at least one path glob')
    return []
  }
  const globs: string[] = []
  value.forEach((entry, index) => {
    const glob = checkGlob(issues, `${path}[${index}]`, entry)
    if (glob !== undefined) globs.push(glob)
  })
  return globs
}

function readSurfaces(issues: IssueList, value: unknown): readonly SurfaceSpec[] {
  if (value === undefined) {
    issues.add('surfaces', 'missing', 'is required — declare at least one of slides, labs, quiz')
    return []
  }
  if (!isRecord(value)) {
    issues.add('surfaces', 'invalid', 'must be a mapping of surface name to path globs')
    return []
  }
  if (Object.keys(value).length === 0) {
    issues.add('surfaces', 'invalid', 'must declare at least one of slides, labs, quiz')
    return []
  }

  for (const key of Object.keys(value)) {
    if (!(SURFACES as readonly string[]).includes(key)) {
      // `unknown-key`, matching every other unknown key in the document: a consumer
      // filtering issues by code should not have to know that surfaces are special.
      issues.add(
        childPath('surfaces', key),
        'unknown-key',
        `unknown surface — known surfaces are ${SURFACES.join(', ')}`,
      )
    }
  }

  const specs: SurfaceSpec[] = []
  for (const surface of SURFACES) {
    const raw = value[surface]
    if (raw === undefined) continue
    const path = `surfaces.${surface}`
    if (!isRecord(raw)) {
      issues.add(path, 'invalid', 'must be a mapping with include (and optional exclude)')
      continue
    }
    const allowed = surface === 'quiz' ? ['include', 'exclude', 'schema'] : ['include', 'exclude']
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) {
        issues.add(
          childPath(path, key),
          'unknown-key',
          `unknown key — allowed keys are ${allowed.join(', ')}`,
        )
      }
    }
    const include = readGlobList(issues, `${path}.include`, raw.include, { required: true })
    const exclude = readGlobList(issues, `${path}.exclude`, raw.exclude, { required: false })

    if (surface === 'quiz') {
      const schema = readQuizSchema(issues, `${path}.schema`, raw.schema)
      if (schema !== undefined) specs.push({ surface, include, exclude, schema })
      continue
    }
    specs.push({ surface, include, exclude })
  }
  return specs
}

function readQuizSchema(
  issues: IssueList,
  path: string,
  value: unknown,
): QuizSchemaVariant | undefined {
  if (value === undefined) {
    issues.add(
      path,
      'missing',
      `is required for the quiz surface — one of ${QUIZ_SCHEMA_VARIANTS.join(', ')}`,
    )
    return undefined
  }
  if (typeof value !== 'string' || !(QUIZ_SCHEMA_VARIANTS as readonly string[]).includes(value)) {
    issues.add(
      path,
      'invalid',
      `matches no known quiz schema — known variants are ${QUIZ_SCHEMA_VARIANTS.join(', ')}`,
    )
    return undefined
  }
  return value as QuizSchemaVariant
}

function readLocales(issues: IssueList, value: unknown): LocaleSet {
  if (value === undefined) {
    issues.add('locales', 'missing', 'is required — declare the target locales')
    return { source: 'en', targets: [] }
  }
  if (!isRecord(value)) {
    issues.add('locales', 'invalid', 'must be a mapping with source and targets')
    return { source: 'en', targets: [] }
  }
  for (const key of Object.keys(value)) {
    if (key !== 'source' && key !== 'targets') {
      issues.add(
        childPath('locales', key),
        'unknown-key',
        'unknown key — allowed keys are source, targets',
      )
    }
  }

  let source = 'en'
  if (value.source !== undefined) {
    if (
      typeof value.source === 'string' &&
      value.source.length <= MAX_LOCALE_TAG_LENGTH &&
      LOCALE_TAG.test(value.source)
    ) {
      source = value.source
    } else {
      issues.add('locales.source', 'invalid', 'must be a locale tag such as "en"')
    }
  }

  const rawTargets = value.targets
  if (rawTargets === undefined) {
    issues.add('locales.targets', 'missing', 'is required — declare at least one target locale')
    return { source, targets: [] }
  }
  if (!Array.isArray(rawTargets)) {
    issues.add('locales.targets', 'invalid', 'must be a list of locale tags')
    return { source, targets: [] }
  }
  if (rawTargets.length === 0) {
    issues.add('locales.targets', 'invalid', 'must list at least one target locale')
    return { source, targets: [] }
  }

  const targets: string[] = []
  // Compared case-folded, because `i18n/<locale>/` is a directory: `de` and `DE` are two
  // entries here and one directory on macOS or Windows, where whichever locale composes
  // second silently overwrites the first.
  const foldedTargets = new Set<string>()
  rawTargets.forEach((entry, index) => {
    const path = `locales.targets[${index}]`
    if (
      typeof entry !== 'string' ||
      entry.length > MAX_LOCALE_TAG_LENGTH ||
      !LOCALE_TAG.test(entry)
    ) {
      issues.add(
        path,
        'invalid',
        `must be a locale tag usable as a directory name, got ${JSON.stringify(entry)}`,
      )
      return
    }
    const folded = entry.toLowerCase()
    if (folded === source.toLowerCase()) {
      issues.add(
        path,
        'invalid',
        `is the source locale ${JSON.stringify(source)} (compared without case), not a target`,
      )
      return
    }
    if (foldedTargets.has(folded)) {
      issues.add(
        path,
        'duplicate',
        `locale ${JSON.stringify(entry)} is listed more than once — locales are compared ` +
          'without case, because they become directory names',
      )
      return
    }
    foldedTargets.add(folded)
    targets.push(entry)
  })
  return { source, targets }
}

function readProtectedTerms(issues: IssueList, value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    issues.add('protectedTerms', 'invalid', 'must be a list of terms that must survive translation')
    return []
  }
  const terms: string[] = []
  value.forEach((entry, index) => {
    const path = `protectedTerms[${index}]`
    if (typeof entry !== 'string' || entry === '' || hasControlCharacter(entry)) {
      issues.add(path, 'invalid', `must be a non-empty term, got ${JSON.stringify(entry)}`)
      return
    }
    if (terms.includes(entry)) {
      issues.add(path, 'duplicate', `term ${JSON.stringify(entry)} is listed more than once`)
      return
    }
    terms.push(entry)
  })
  return terms
}

function readLengthBudgets(issues: IssueList, value: unknown): LengthBudgets {
  if (value === undefined) return { default: DEFAULT_LENGTH_BUDGET, byLayout: {} }
  if (!isRecord(value)) {
    issues.add(
      'lengthBudgets',
      'invalid',
      'must be a mapping of layout name to a target/source length ratio',
    )
    return { default: DEFAULT_LENGTH_BUDGET, byLayout: {} }
  }

  let fallback = DEFAULT_LENGTH_BUDGET
  // Null-prototype: layout names come from the deck, so `constructor` and friends must
  // be absent rather than inherited. `lengthBudgetFor` guards the read as well.
  const byLayout: Record<string, number> = Object.create(null)
  for (const [key, raw] of Object.entries(value)) {
    const path = childPath('lengthBudgets', key)
    if (key !== 'default' && !LAYOUT_NAME.test(key)) {
      issues.add(path, 'invalid', `is not a layout name; use letters, digits, ".", "_" and "-"`)
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      issues.add(
        path,
        'invalid',
        `must be a finite ratio greater than 0, got ${JSON.stringify(raw)}`,
      )
      continue
    }
    if (key === 'default') fallback = raw
    else byLayout[key] = raw
  }
  return { default: fallback, byLayout }
}

function readApiVersion(
  value: unknown,
  source: string | undefined,
): { version: string; major: number } {
  if (value === undefined) {
    throw new ManifestError(
      [
        {
          path: 'apiVersion',
          code: 'missing',
          message: `apiVersion: is required — expected ${MANIFEST_API_GROUP}/v${SUPPORTED_MANIFEST_MAJOR}`,
        },
      ],
      source,
    )
  }
  const match = typeof value === 'string' ? API_VERSION.exec(value) : null
  if (match === null || match[1] !== MANIFEST_API_GROUP) {
    throw new ManifestError(
      [
        {
          path: 'apiVersion',
          code: 'invalid',
          message: `apiVersion: must be ${MANIFEST_API_GROUP}/v<major>, got ${JSON.stringify(value)}`,
        },
      ],
      source,
    )
  }
  const major = Number(match[2])
  if (major !== SUPPORTED_MANIFEST_MAJOR) {
    throw new ManifestError(
      [
        {
          path: 'apiVersion',
          code: 'unsupported-api-version',
          message:
            `apiVersion: ${JSON.stringify(value)} is not supported by this release, which ` +
            `understands ${MANIFEST_API_GROUP}/v${SUPPORTED_MANIFEST_MAJOR}`,
        },
      ],
      source,
    )
  }
  return { version: value as string, major }
}

const ROOT_KEYS = ['apiVersion', 'locales', 'surfaces', 'protectedTerms', 'lengthBudgets']

/**
 * Parse and validate `.localization/workshop.yaml` from its text.
 *
 * Reading the file belongs to the CLI: core takes a string so it stays a pure function
 * of its input (constitution IV).
 *
 * @throws {ManifestError} with every problem found, each naming its path. An unknown
 * major `apiVersion` short-circuits: fields of a version we do not understand are not
 * worth guessing at (spec 001 FR-003).
 */
export function parseManifest(yamlText: string, opts?: ParseManifestOptions): Manifest {
  const source = opts?.source

  let document: unknown
  try {
    document = parseYaml(yamlText)
  } catch (error) {
    // Any throw from the parser, not just YAMLParseError: an undefined alias raises a
    // bare ReferenceError, and a parser this consumes hostile input with must never be
    // able to surface an error that carries no manifest path (spec 002 edge case).
    throw new ManifestError(
      [
        {
          path: DOCUMENT_PATH,
          code: 'malformed-yaml',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      source,
    )
  }

  if (!isRecord(document)) {
    throw new ManifestError(
      [
        {
          path: DOCUMENT_PATH,
          code: 'invalid',
          message: `${DOCUMENT_PATH}: must be a YAML mapping with an apiVersion key`,
        },
      ],
      source,
    )
  }

  const { version, major } = readApiVersion(document.apiVersion, source)

  const issues = new IssueList()
  for (const key of Object.keys(document)) {
    if (!ROOT_KEYS.includes(key)) {
      issues.add(
        childPath('', key),
        'unknown-key',
        `unknown manifest key — allowed keys are ${ROOT_KEYS.join(', ')}`,
      )
    }
  }

  const locales = readLocales(issues, document.locales)
  const surfaces = readSurfaces(issues, document.surfaces)
  const protectedTerms = readProtectedTerms(issues, document.protectedTerms)
  const lengthBudgets = readLengthBudgets(issues, document.lengthBudgets)

  if (!issues.empty) throw new ManifestError(issues.issues, source)

  return { apiVersion: version, apiMajor: major, locales, surfaces, protectedTerms, lengthBudgets }
}

/** The spec for one surface, or `undefined` when the manifest does not declare it. */
export function surfaceSpec(manifest: Manifest, surface: Surface): SurfaceSpec | undefined {
  return manifest.surfaces.find((spec) => spec.surface === surface)
}

/**
 * The length budget for a layout: its override if the manifest declares one, otherwise
 * the manifest default.
 */
export function lengthBudgetFor(manifest: Manifest, layout?: string): number {
  if (layout === undefined) return manifest.lengthBudgets.default
  // `Object.hasOwn`, never a plain index: a layout named `toString` or `constructor`
  // would otherwise resolve to a function where a number is declared, and the ADR 0009
  // overflow gate would silently stop gating that layout.
  if (!Object.hasOwn(manifest.lengthBudgets.byLayout, layout)) {
    return manifest.lengthBudgets.default
  }
  const budget = manifest.lengthBudgets.byLayout[layout]
  return typeof budget === 'number' ? budget : manifest.lengthBudgets.default
}
