import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LENGTH_BUDGET,
  lengthBudgetFor,
  MANIFEST_API_GROUP,
  type Manifest,
  ManifestError,
  type MarkdownSurfaceSpec,
  parseManifest,
  QUIZ_SCHEMA_VARIANTS,
  SUPPORTED_MANIFEST_MAJOR,
  surfaceSpec,
} from '../src/index.js'

const complete = `
apiVersion: workshop-i18n/v1
locales:
  source: en
  targets:
    - de
    - pt-BR
surfaces:
  quiz:
    include: ['quiz/**/*.yaml']
    schema: kubernetes-workshop
  slides:
    include:
      - 'slides/**/*.md'
    exclude:
      - 'slides/drafts/**'
  labs:
    include: ['labs/**/*.md']
protectedTerms:
  - kubectl
  - Pod
  - kubeconfig
lengthBudgets:
  default: 1.4
  statement: 1.1
`

function issuesOf(yamlText: string): ManifestError {
  try {
    parseManifest(yamlText)
  } catch (error) {
    if (error instanceof ManifestError) return error
    throw error
  }
  throw new Error('expected parseManifest to reject this manifest')
}

const minimal = `
apiVersion: workshop-i18n/v1
locales:
  targets: [de]
surfaces:
  slides:
    include: ['slides/**/*.md']
`

describe('parseManifest — a well-formed manifest', () => {
  const manifest: Manifest = parseManifest(complete)

  it('records the api version and its major', () => {
    expect(manifest.apiVersion).toBe(`${MANIFEST_API_GROUP}/v1`)
    expect(manifest.apiMajor).toBe(SUPPORTED_MANIFEST_MAJOR)
  })

  it('reads the locale list', () => {
    expect(manifest.locales).toEqual({ source: 'en', targets: ['de', 'pt-BR'] })
  })

  it('returns surfaces in canonical order regardless of the YAML key order', () => {
    expect(manifest.surfaces.map((s) => s.surface)).toEqual(['slides', 'labs', 'quiz'])
  })

  it('reads path globs, defaulting exclude to empty', () => {
    expect(surfaceSpec(manifest, 'slides')).toEqual({
      surface: 'slides',
      include: ['slides/**/*.md'],
      exclude: ['slides/drafts/**'],
    })
    expect(surfaceSpec(manifest, 'labs')?.exclude).toEqual([])
  })

  it('reads the quiz schema variant', () => {
    const quiz = surfaceSpec(manifest, 'quiz')
    expect(quiz?.surface === 'quiz' && quiz.schema).toBe('kubernetes-workshop')
  })

  it('reads protected terms in the order the author wrote them', () => {
    expect(manifest.protectedTerms).toEqual(['kubectl', 'Pod', 'kubeconfig'])
  })

  it('reads per-layout length budgets with a default', () => {
    expect(manifest.lengthBudgets.default).toBe(1.4)
    expect(lengthBudgetFor(manifest, 'statement')).toBe(1.1)
    expect(lengthBudgetFor(manifest, 'two-cols')).toBe(1.4)
    expect(lengthBudgetFor(manifest)).toBe(1.4)
  })

  it('is frozen — the config the gates read cannot be edited in place', () => {
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.locales)).toBe(true)
    expect(Object.isFrozen(manifest.locales.targets)).toBe(true)
    expect(Object.isFrozen(manifest.surfaces)).toBe(true)
    expect(Object.isFrozen(manifest.protectedTerms)).toBe(true)
    expect(Object.isFrozen(manifest.lengthBudgets)).toBe(true)
    expect(Object.isFrozen(manifest.lengthBudgets.byLayout)).toBe(true)
    const slides = surfaceSpec(manifest, 'slides') as MarkdownSurfaceSpec
    expect(Object.isFrozen(slides)).toBe(true)
    expect(Object.isFrozen(slides.include)).toBe(true)
    expect(() => {
      ;(manifest.locales.targets as string[]).push('EVIL')
    }).toThrow(TypeError)
    expect(manifest.locales.targets).toEqual(['de', 'pt-BR'])
  })

  it('is deterministic — the same text parses to the same manifest', () => {
    expect(parseManifest(complete)).toEqual(manifest)
  })
})

describe('parseManifest — defaults', () => {
  const manifest = parseManifest(minimal)

  it('defaults the source locale to English', () => {
    expect(manifest.locales.source).toBe('en')
  })

  it('defaults protected terms and length budgets', () => {
    expect(manifest.protectedTerms).toEqual([])
    expect(manifest.lengthBudgets).toEqual({ default: DEFAULT_LENGTH_BUDGET, byLayout: {} })
  })

  it('freezes the values it defaulted, not only the ones the author wrote', () => {
    // The `complete` fixture declares every optional key, so the earlier freeze test only
    // ever exercised the populated paths. A manifest that omits `lengthBudgets` and
    // `exclude` takes different returns, and those were the ones left mutable.
    expect(Object.isFrozen(manifest.lengthBudgets)).toBe(true)
    expect(Object.isFrozen(manifest.lengthBudgets.byLayout)).toBe(true)
    const slides = surfaceSpec(manifest, 'slides') as MarkdownSurfaceSpec
    expect(Object.isFrozen(slides)).toBe(true)
    expect(Object.isFrozen(slides.include)).toBe(true)
    expect(Object.isFrozen(slides.exclude)).toBe(true)
    expect(Object.isFrozen(manifest.protectedTerms)).toBe(true)
    expect(Object.isFrozen(manifest.locales.targets)).toBe(true)
  })

  it('keeps the overflow gate where parsing put it', () => {
    expect(() => {
      ;(manifest.lengthBudgets as { default: number }).default = 99
    }).toThrow(TypeError)
    expect(lengthBudgetFor(manifest)).toBe(DEFAULT_LENGTH_BUDGET)
  })

  it('keeps the extraction scope where parsing put it', () => {
    const slides = surfaceSpec(manifest, 'slides') as MarkdownSurfaceSpec
    expect(() => {
      ;(slides.exclude as string[]).push('**/*')
    }).toThrow(TypeError)
    expect(slides.exclude).toEqual([])
  })

  it('reports an absent surface as undefined rather than guessing a path', () => {
    expect(surfaceSpec(manifest, 'quiz')).toBeUndefined()
  })
})

describe('parseManifest — apiVersion (spec 001 FR-003)', () => {
  it('rejects an unknown major version as a hard error', () => {
    const error = issuesOf(minimal.replace('/v1', '/v2'))
    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]).toMatchObject({ path: 'apiVersion', code: 'unsupported-api-version' })
    expect(error.message).toContain('v2')
    expect(error.message).toContain('v1')
  })

  it('rejects a missing apiVersion', () => {
    const error = issuesOf(minimal.replace('apiVersion: workshop-i18n/v1\n', ''))
    expect(error.issues[0]).toMatchObject({ path: 'apiVersion', code: 'missing' })
  })

  it('rejects a foreign api group and a malformed version string', () => {
    expect(issuesOf(minimal.replace('workshop-i18n/v1', 'other-tool/v1')).issues[0]).toMatchObject({
      path: 'apiVersion',
      code: 'invalid',
    })
    expect(issuesOf(minimal.replace('workshop-i18n/v1', 'v1')).issues[0]).toMatchObject({
      path: 'apiVersion',
      code: 'invalid',
    })
  })

  it('gives the version exactly one spelling — no zero-padded majors', () => {
    for (const spelling of ['workshop-i18n/v01', 'workshop-i18n/v1.0', 'workshop-i18n/V1']) {
      expect(issuesOf(minimal.replace('workshop-i18n/v1', spelling)).issues[0]).toMatchObject({
        path: 'apiVersion',
        code: 'invalid',
      })
    }
  })

  it('does not bother reporting other problems once the version is unsupported', () => {
    const error = issuesOf(`apiVersion: ${MANIFEST_API_GROUP}/v9\nsurfaces: 42\n`)
    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]?.code).toBe('unsupported-api-version')
  })
})

describe('parseManifest — malformed input', () => {
  it('reports a YAML syntax error with its line, never a bare cast error', () => {
    const error = issuesOf('apiVersion: [unterminated\n')
    expect(error.issues[0]?.code).toBe('malformed-yaml')
    expect(error.message).toMatch(/line \d+/)
  })

  it('names the manifest source when the caller supplies one', () => {
    try {
      parseManifest('\t- nope', { source: '.localization/workshop.yaml' })
      throw new Error('expected a rejection')
    } catch (error) {
      expect((error as ManifestError).message).toContain('.localization/workshop.yaml')
      expect((error as ManifestError).source).toBe('.localization/workshop.yaml')
    }
  })

  it('reports an undefined alias as a manifest error, not a bare ReferenceError', () => {
    const error = issuesOf('apiVersion: *nowhere\n')
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.issues[0]?.code).toBe('malformed-yaml')
    expect(error.issues[0]?.path).toBeTruthy()
  })

  it('turns anything the YAML parser throws into a manifest error', () => {
    for (const hostile of ['a: *x\nb: &x 1\n', 'a:\n  - *nope\n', '{{{\n']) {
      const error = issuesOf(hostile)
      expect(error).toBeInstanceOf(ManifestError)
      expect(error.issues[0]?.code).toBe('malformed-yaml')
    }
  })

  it('rejects a document that is not a mapping', () => {
    expect(issuesOf('- a\n- b\n').issues[0]?.code).toBe('invalid')
    expect(issuesOf('').issues[0]?.code).toBe('invalid')
  })

  it('rejects unknown top-level keys instead of silently ignoring a typo', () => {
    const error = issuesOf(`${minimal}protectedTerm: [kubectl]\n`)
    expect(error.issues[0]).toMatchObject({ path: 'protectedTerm', code: 'unknown-key' })
  })
})

describe('parseManifest — surfaces', () => {
  it('requires at least one surface', () => {
    expect(issuesOf(minimal.replace(/surfaces:[\s\S]*/, 'surfaces: {}\n')).issues[0]).toMatchObject(
      {
        path: 'surfaces',
        code: 'invalid',
      },
    )
    expect(issuesOf(minimal.replace(/surfaces:[\s\S]*/, '')).issues[0]).toMatchObject({
      path: 'surfaces',
      code: 'missing',
    })
  })

  it('rejects an unknown surface name with the same code as any other unknown key', () => {
    const error = issuesOf(`${minimal}  handouts:\n    include: ['h/*.md']\n`)
    expect(error.issues[0]).toMatchObject({ path: 'surfaces.handouts', code: 'unknown-key' })
    expect(error.message).toContain('slides, labs, quiz')
  })

  it('requires a non-empty include list', () => {
    expect(
      issuesOf(minimal.replace("    include: ['slides/**/*.md']\n", '    include: []\n')).issues[0],
    ).toMatchObject({ path: 'surfaces.slides.include', code: 'invalid' })
    expect(
      issuesOf(minimal.replace("    include: ['slides/**/*.md']\n", '    exclude: []\n')).issues[0],
    ).toMatchObject({ path: 'surfaces.slides.include', code: 'missing' })
  })

  it('rejects globs that escape the consumer repository', () => {
    for (const hostile of ['/etc/passwd', '../../secrets/**', 'slides\\**\\*.md', '']) {
      const error = issuesOf(
        minimal.replace("include: ['slides/**/*.md']", `include: ['${hostile}']`),
      )
      expect(error.issues[0]).toMatchObject({ path: 'surfaces.slides.include[0]', code: 'invalid' })
    }
  })

  it('rejects a non-list include', () => {
    expect(
      issuesOf(minimal.replace("include: ['slides/**/*.md']", "include: 'slides/**/*.md'"))
        .issues[0],
    ).toMatchObject({ path: 'surfaces.slides.include', code: 'invalid' })
  })
})

describe('parseManifest — quiz schema variant', () => {
  const withQuiz = (schema: string) => `${minimal}  quiz:\n    include: ['quiz/*.yaml']\n${schema}`

  it('requires a schema variant for the quiz surface', () => {
    expect(issuesOf(withQuiz('')).issues[0]).toMatchObject({
      path: 'surfaces.quiz.schema',
      code: 'missing',
    })
  })

  it('rejects a variant matching neither consumer schema, naming the known ones', () => {
    const error = issuesOf(withQuiz('    schema: homegrown\n'))
    expect(error.issues[0]).toMatchObject({ path: 'surfaces.quiz.schema', code: 'invalid' })
    for (const known of QUIZ_SCHEMA_VARIANTS) expect(error.message).toContain(known)
  })

  it('rejects a schema key on a non-quiz surface', () => {
    const error = issuesOf(`${minimal}    schema: kubernetes-workshop\n`)
    expect(error.issues[0]).toMatchObject({ path: 'surfaces.slides.schema', code: 'unknown-key' })
  })
})

describe('parseManifest — locales', () => {
  it('requires at least one target locale', () => {
    expect(issuesOf(minimal.replace('targets: [de]', 'targets: []')).issues[0]).toMatchObject({
      path: 'locales.targets',
      code: 'invalid',
    })
    expect(
      issuesOf(minimal.replace(/locales:\n {2}targets: \[de\]\n/, '')).issues[0],
    ).toMatchObject({
      path: 'locales',
      code: 'missing',
    })
  })

  it('rejects a duplicated target locale', () => {
    expect(issuesOf(minimal.replace('[de]', '[de, de]')).issues[0]).toMatchObject({
      path: 'locales.targets[1]',
      code: 'duplicate',
    })
  })

  it('rejects targets that differ only by case — one directory on macOS', () => {
    const error = issuesOf(minimal.replace('[de]', '[de, DE]'))
    expect(error.issues[0]).toMatchObject({ path: 'locales.targets[1]', code: 'duplicate' })
    expect(error.message).toMatch(/case/i)
  })

  it('rejects a target that differs from the source locale only by case', () => {
    const withSource = minimal.replace('locales:\n', 'locales:\n  source: en\n')
    expect(issuesOf(withSource.replace('[de]', '[EN]')).issues[0]).toMatchObject({
      path: 'locales.targets[0]',
      code: 'invalid',
    })
  })

  it('rejects the source locale appearing among the targets', () => {
    expect(issuesOf(minimal.replace('[de]', '[de, en]')).issues[0]).toMatchObject({
      path: 'locales.targets[1]',
      code: 'invalid',
    })
  })

  it('accepts real BCP 47 tags, including script, region and private-use subtags', () => {
    for (const tag of ['de', 'pt-BR', 'zh-Hans-CN', 'de-Latn-DE-x-a', 'es-419']) {
      const manifest = parseManifest(minimal.replace('[de]', `['${tag}']`))
      expect(manifest.locales.targets).toEqual([tag])
    }
  })

  it('rejects locale tags that are not safe directory names', () => {
    for (const hostile of ['../etc', 'de/DE', 'de_DE!', 'x'.repeat(40)]) {
      expect(issuesOf(minimal.replace('[de]', `['${hostile}']`)).issues[0]).toMatchObject({
        path: 'locales.targets[0]',
        code: 'invalid',
      })
    }
  })
})

describe('parseManifest — protected terms and length budgets', () => {
  it('rejects a non-list of protected terms and empty entries', () => {
    expect(issuesOf(`${minimal}protectedTerms: kubectl\n`).issues[0]).toMatchObject({
      path: 'protectedTerms',
      code: 'invalid',
    })
    expect(issuesOf(`${minimal}protectedTerms: ['']\n`).issues[0]).toMatchObject({
      path: 'protectedTerms[0]',
      code: 'invalid',
    })
  })

  it('rejects a duplicated protected term', () => {
    expect(issuesOf(`${minimal}protectedTerms: [kubectl, kubectl]\n`).issues[0]).toMatchObject({
      path: 'protectedTerms[1]',
      code: 'duplicate',
    })
  })

  it('rejects budgets that are not positive finite numbers', () => {
    for (const bad of ['0', '-1', 'high', '.inf']) {
      expect(issuesOf(`${minimal}lengthBudgets:\n  statement: ${bad}\n`).issues[0]).toMatchObject({
        path: 'lengthBudgets.statement',
        code: 'invalid',
      })
    }
  })

  it('never resolves a layout budget off the prototype chain', () => {
    const manifest = parseManifest(complete)
    for (const hostile of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const budget = lengthBudgetFor(manifest, hostile)
      expect(typeof budget).toBe('number')
      expect(budget).toBe(manifest.lengthBudgets.default)
    }
  })

  it('rejects a layout name that is not a plain identifier', () => {
    const issue = issuesOf(`${minimal}lengthBudgets:\n  '../evil': 1.2\n`).issues[0]
    expect(issue?.code).toBe('invalid')
    expect(issue?.path).toContain('lengthBudgets[')
    expect(issue?.message).toContain('evil')
  })
})

describe('parseManifest — error reporting', () => {
  it('aggregates every problem so one run fixes them all', () => {
    const error = issuesOf(`
apiVersion: workshop-i18n/v1
locales:
  targets: []
surfaces:
  slides:
    include: ['/abs/**']
protectedTerms: ['']
`)
    expect(error.issues.length).toBeGreaterThanOrEqual(3)
    expect(error.issues.map((i) => i.path)).toContain('locales.targets')
    expect(error.issues.map((i) => i.path)).toContain('surfaces.slides.include[0]')
    expect(error.issues.map((i) => i.path)).toContain('protectedTerms[0]')
  })

  it('names every offending path in the message', () => {
    const error = issuesOf(minimal.replace('[de]', '[de, de]'))
    expect(error.message).toContain('locales.targets[1]')
    expect(error.name).toBe('ManifestError')
  })
})
