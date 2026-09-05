import { describe, expect, it } from 'vitest'
import {
  assertSafeLocale,
  isLocaleTag,
  LocaleError,
  localeRejection,
  MAX_LOCALE_TAG_LENGTH,
  parseManifest,
} from '../src/index.js'

describe('isLocaleTag', () => {
  it('accepts real BCP 47 tags', () => {
    for (const tag of ['en', 'de', 'pt-BR', 'zh-Hans-CN', 'es-419', 'de-Latn-DE-x-a']) {
      expect(isLocaleTag(tag)).toBe(true)
    }
  })

  it('rejects anything that would not be a safe directory name', () => {
    for (const hostile of [
      '',
      '..',
      '../etc',
      'de/DE',
      'de\\DE',
      'de_DE!',
      'de DE',
      '.hidden',
      'de\u0000',
      'x'.repeat(MAX_LOCALE_TAG_LENGTH + 1),
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isLocaleTag(hostile as unknown as string)).toBe(false)
    }
  })

  it('rejects Windows device names, which are also real ISO 639-3 codes', () => {
    // con = Cofan, aux = Aura, nul = Nusa Laut, prn = Prasuni: reachable through a
    // legitimate language choice, not only through hostile input.
    for (const reserved of ['con', 'aux', 'nul', 'prn', 'CON', 'Aux']) {
      expect(isLocaleTag(reserved)).toBe(false)
      expect(localeRejection(reserved)).toBe('reserved-name')
    }
    // `lpt1` is not a well-formed language tag either, and the charset catches it first.
    expect(isLocaleTag('lpt1')).toBe(false)
    expect(isLocaleTag('cop')).toBe(true)
    expect(isLocaleTag('nl')).toBe(true)
  })

  it('reports why, so a CLI can explain a rejected --locale', () => {
    expect(localeRejection('de')).toBeUndefined()
    expect(localeRejection('')).toBe('empty')
    expect(localeRejection(42)).toBe('not-a-string')
    expect(localeRejection('x'.repeat(99))).toBe('too-long')
    expect(localeRejection('de/DE')).toBe('illegal-character')
  })
})

describe('assertSafeLocale', () => {
  it('tells a user what to do instead, not only that they cannot', () => {
    let message = ''
    try {
      assertSafeLocale('con')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/reserved/i)
    // The workaround has to be in the message: a facilitator typing `--locale con` reads
    // this line and nothing else.
    expect(message).toMatch(/con-EC|region subtag/i)
    expect(isLocaleTag('con-EC')).toBe(true)
  })

  it('returns the tag it accepted', () => {
    expect(assertSafeLocale('pt-BR')).toBe('pt-BR')
  })

  it('throws a LocaleError naming the reason, never a bare cast error', () => {
    let error: unknown
    try {
      assertSafeLocale('../etc')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LocaleError)
    expect((error as LocaleError).reason).toBe('illegal-character')
    expect((error as LocaleError).message).toContain('../etc')
  })

  it('neutralises bidi overrides in the message it throws', () => {
    let message = ''
    try {
      assertSafeLocale('de\u202e/etc')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain('\u202e')
    expect(message).toContain('u202e')
  })

  it('does not run a content-supplied toString', () => {
    const hostile = {
      toString() {
        throw new Error('boom')
      },
    }
    expect(() => assertSafeLocale(hostile as unknown as string)).toThrow(LocaleError)
  })
})

describe('the manifest applies the same rule', () => {
  const manifestWith = (target: string) => `
apiVersion: workshop-i18n/v1
locales:
  targets: ['${target}']
surfaces:
  slides:
    include: ['slides/**/*.md']
`

  it('rejects a reserved device name as a target locale', () => {
    expect(() => parseManifest(manifestWith('con'))).toThrow(/locales\.targets\[0\]/)
    expect(() => parseManifest(manifestWith('nul'))).toThrow(/reserved/i)
  })

  it('still accepts ordinary tags', () => {
    expect(parseManifest(manifestWith('pt-BR')).locales.targets).toEqual(['pt-BR'])
  })
})
