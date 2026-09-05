/**
 * Locale tags, and the gate that keeps them safe as path segments.
 *
 * A locale is the other identifier this tool turns into a path: catalogs live at
 * `i18n/<locale>/*.po` and overrides at `i18n/<locale>/overrides/<slideId>.md`. Container
 * ids have been gated since spec 001; locales were validated only inside the manifest
 * parser, which left every other entry point — a `--locale` flag, a directory scan, a
 * `UnitStatus.locale` built by the catalog layer — ungated. Same rule, one place, so all
 * of them agree.
 */

import { describeValue } from './render-value.js'
import { isReservedFileName } from './reserved-names.js'

/**
 * Longest accepted tag. BCP 47's own registry stays far below this; the cap exists so a
 * tag cannot become an unreasonable path segment.
 */
export const MAX_LOCALE_TAG_LENGTH = 35

/**
 * BCP 47 shape: a 2-8 letter language, then up to eight 1-8 character subtags. The 1
 * character minimum admits singletons and private-use sequences (`de-Latn-DE-x-a`,
 * `es-419`). Path safety comes from the charset — letters, digits and `-` only — plus
 * {@link MAX_LOCALE_TAG_LENGTH} and the reserved-name check, not from the shape.
 */
const LOCALE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,8}$/

/** Why a locale tag was rejected. */
export type LocaleRejection =
  | 'not-a-string'
  | 'empty'
  | 'too-long'
  | 'illegal-character'
  | 'reserved-name'

/**
 * The reason `value` is not a usable locale tag, or `undefined` when it is one.
 *
 * Exposed alongside the boolean so a CLI can tell a user *why* their `--locale` was
 * refused rather than only that it was.
 */
export function localeRejection(value: unknown): LocaleRejection | undefined {
  if (typeof value !== 'string') return 'not-a-string'
  if (value === '') return 'empty'
  if (value.length > MAX_LOCALE_TAG_LENGTH) return 'too-long'
  if (!LOCALE_TAG.test(value)) return 'illegal-character'
  // `con`, `aux`, `nul` and `prn` are Windows device names — and ISO 639-3 codes for
  // Cofan, Aura, Nusa Laut and Prasuni, so this is reachable by choosing a language, not
  // only by attacking. `i18n/con/` cannot be created or checked out on Windows.
  if (isReservedFileName(value)) return 'reserved-name'
  return undefined
}

/** True when `value` is a locale tag safe to use as a directory name. */
export function isLocaleTag(value: unknown): boolean {
  return localeRejection(value) === undefined
}

/** Thrown by {@link assertSafeLocale}. */
export class LocaleError extends Error {
  readonly reason: LocaleRejection
  /** The offending value, rendered — never the value itself. */
  readonly value: string

  constructor(reason: LocaleRejection, rendered: string) {
    super(`invalid locale ${rendered}: ${LOCALE_REJECTION_DETAIL[reason]}`)
    this.name = 'LocaleError'
    this.reason = reason
    this.value = rendered
  }
}

const LOCALE_REJECTION_DETAIL: Readonly<Record<LocaleRejection, string>> = Object.freeze({
  'not-a-string': 'must be a string',
  empty: 'must not be empty',
  'too-long': `must be at most ${MAX_LOCALE_TAG_LENGTH} characters`,
  'illegal-character': 'must be a BCP 47 tag using only letters, digits and "-"',
  'reserved-name': 'is a reserved device name and cannot be a directory on Windows',
})

/**
 * Return `value` as a validated locale tag, or throw.
 *
 * Renders the offending value with `JSON.stringify` rather than interpolating it, so a
 * content-supplied `toString` never runs inside the guard.
 *
 * @throws {LocaleError} naming the reason.
 */
export function assertSafeLocale(value: unknown): string {
  const reason = localeRejection(value)
  if (reason === undefined) return value as string
  throw new LocaleError(reason, describeValue(value))
}
