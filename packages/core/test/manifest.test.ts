import { describe, expect, it } from 'vitest'
import {
  componentNameKey,
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
  textPropRejection,
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

describe('parseManifest — component text props (ADR 0015)', () => {
  const withProps = (block: string) => `${minimal}    componentTextProps:\n${block}`
  const slidesOf = (text: string) =>
    surfaceSpec(parseManifest(text), 'slides') as MarkdownSurfaceSpec

  it('reads the declared text props per component, in the order the author wrote them', () => {
    const slides = slidesOf(withProps('      KwCard: [heading, kicker]\n      CodeNote: [label]\n'))
    expect(slides.componentTextProps).toEqual({
      KwCard: ['heading', 'kicker'],
      CodeNote: ['label'],
    })
  })

  it('leaves the field absent when nothing is declared — a manifest without it is unchanged', () => {
    expect(slidesOf(minimal)).toEqual({
      surface: 'slides',
      include: ['slides/**/*.md'],
      exclude: [],
    })
    expect(slidesOf(minimal).componentTextProps).toBeUndefined()
  })

  it('freezes the declaration, so a prop cannot be made translatable after validation', () => {
    const props = slidesOf(withProps('      KwCard: [heading]\n')).componentTextProps
    expect(Object.isFrozen(props)).toBe(true)
    expect(Object.isFrozen(props?.KwCard)).toBe(true)
    expect(Object.getPrototypeOf(props)).toBeNull()
  })

  it('accepts kebab-case and PascalCase component names and HTML element names', () => {
    const slides = slidesOf(withProps('      lab-callout: [duration]\n      img: [alt]\n'))
    expect(slides.componentTextProps).toEqual({ 'lab-callout': ['duration'], img: ['alt'] })
  })

  it('rejects the key on the labs surface, where nothing reads it', () => {
    const error = issuesOf(
      `${minimal}  labs:\n    include: ['labs/*.md']\n    componentTextProps:\n      KwCard: [heading]\n`,
    )
    expect(error.issues[0]).toMatchObject({
      path: 'surfaces.labs.componentTextProps',
      code: 'unknown-key',
    })
  })

  it('rejects a binding, a directive or an event as a text prop — those are code', () => {
    for (const prop of ["':heading'", 'v-if', "'@click'", "'v-bind:heading'", "'#default'"]) {
      const error = issuesOf(withProps(`      KwCard: [${prop}]\n`))
      expect(error.issues[0], prop).toMatchObject({
        path: 'surfaces.slides.componentTextProps.KwCard[0]',
        code: 'invalid',
      })
    }
  })

  it('rejects a directive spelled in camelCase, which Vue resolves to the same v- name', () => {
    for (const prop of ['vHtml', 'vOn', 'vBind', 'VHtml', 'vModel']) {
      const error = issuesOf(withProps(`      KwCard: [${prop}]\n`))
      expect(error.issues[0], prop).toMatchObject({
        path: 'surfaces.slides.componentTextProps.KwCard[0]',
        code: 'invalid',
      })
    }
  })

  it('rejects event, URL and style attributes, which are code or addresses, never prose', () => {
    for (const prop of [
      'onclick',
      'onMouseover',
      'href',
      'src',
      'srcset',
      'action',
      'formaction',
      'srcdoc',
      'style',
      'is',
      'xlinkHref',
    ]) {
      expect(issuesOf(withProps(`      KwCard: [${prop}]\n`)).issues[0], prop).toMatchObject({
        code: 'invalid',
      })
    }
  })

  it('caps the size of the declaration', () => {
    const manyProps = Array.from({ length: 17 }, (_, index) => `p${index}`).join(', ')
    expect(issuesOf(withProps(`      KwCard: [${manyProps}]\n`)).issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps.KwCard',
      code: 'invalid',
    })
    const manyComponents = Array.from({ length: 65 }, (_, index) => `      C${index}: [heading]\n`)
    expect(issuesOf(withProps(manyComponents.join(''))).issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps',
      code: 'invalid',
    })
  })

  it('exposes the same prop rule for callers that bypass the manifest', () => {
    expect(textPropRejection('heading')).toBeUndefined()
    for (const prop of ['vHtml', 'v-html', ':heading', '@click', '#default', 'onClick', 'href']) {
      expect(textPropRejection(prop), prop).toBeDefined()
    }
  })

  it('rejects a component name that is not a plain tag name', () => {
    const error = issuesOf(withProps("      'Kw Card': [heading]\n"))
    expect(error.issues[0]).toMatchObject({ code: 'invalid' })
    expect(error.issues[0]?.path).toContain('componentTextProps')
  })

  it('rejects a mapping that is not a mapping of names to non-empty lists', () => {
    expect(issuesOf(withProps('      KwCard: heading\n')).issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps.KwCard',
      code: 'invalid',
    })
    expect(issuesOf(withProps('      KwCard: []\n')).issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps.KwCard',
      code: 'invalid',
    })
    expect(issuesOf(`${minimal}    componentTextProps: [KwCard]\n`).issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps',
      code: 'invalid',
    })
  })

  it('rejects the same component declared twice under two spellings Vue resolves as one', () => {
    const error = issuesOf(withProps('      KwCard: [heading]\n      kw-card: [kicker]\n'))
    expect(error.issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps.kw-card',
      code: 'duplicate',
    })
  })

  it('rejects a prop listed twice under two spellings Vue resolves as one', () => {
    const error = issuesOf(withProps('      KwCard: [leftHeading, left-heading]\n'))
    expect(error.issues[0]).toMatchObject({
      path: 'surfaces.slides.componentTextProps.KwCard[1]',
      code: 'duplicate',
    })
  })
})

describe('componentNameKey', () => {
  it('folds the spellings Vue resolves to one component onto one key', () => {
    expect(componentNameKey('KwCard')).toBe('kw-card')
    expect(componentNameKey('kw-card')).toBe('kw-card')
    expect(componentNameKey('kwCard')).toBe('kw-card')
    expect(componentNameKey('K8sIcon')).toBe('k8s-icon')
    expect(componentNameKey('leftHeading')).toBe('left-heading')
    expect(componentNameKey('v-click')).toBe('v-click')
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
