/**
 * Content identities (ADR 0005) and the safety gate that keeps them harmless.
 *
 * Identities come out of consumer content, and consumer content is hostile input
 * (SECURITY.md, spec 001 edge cases). A container id ends up in a file name
 * (`i18n/<locale>/overrides/<slideId>.md`), and the full unit id ends up inside a
 * quoted PO `msgctxt`. So ids are restricted to a conservative ASCII charset: an id
 * can never traverse a path, smuggle a control character into a report, or break out
 * of PO quoting.
 *
 * The gate is a *separate* function from `parseUnitId` on purpose. Parsing answers
 * "is this string shaped like an id"; validation answers "is this id safe to use as a
 * path or a msgctxt". Extractors validate ids the moment they read them from content;
 * code that merely re-reads an id the tool itself wrote does not pay the cost twice.
 */

/** Content surfaces, in the canonical order used for deterministic output. */
export const SURFACES = ['slides', 'labs', 'quiz'] as const

/** Content surface a unit was extracted from. */
export type Surface = (typeof SURFACES)[number]

/** Type guard for {@link Surface}; useful when reading a surface name out of input. */
export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && (SURFACES as readonly string[]).includes(value)
}

/**
 * Stable unit identity, used as PO `msgctxt`. Never derived from file path,
 * ordinal position, or content hash.
 */
export interface UnitId {
  readonly surface: Surface
  /** Explicit container identity, e.g. a `slideId`, lab id, or quiz question id. */
  readonly containerId: string
  /** Position-independent key of the unit within its container. */
  readonly unitKey: string
}

/** Maximum container id length; long enough for `section + heading`, short enough for a file name. */
export const MAX_CONTAINER_ID_LENGTH = 128

/** Maximum unit key length; unit keys are structural (`body/3`), never prose. */
export const MAX_UNIT_KEY_LENGTH = 256

/** Container ids double as file names, so no separators at all — letters, digits, `.`, `_`, `-`. */
const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Unit keys additionally allow `/` and `:` as structure separators (`body/3`, `note:speaker:2`). */
const UNIT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

/** Why an identity was rejected. Machine-readable so the CLI can group failures. */
export type UnitIdRejection =
  | 'empty'
  | 'too-long'
  | 'path-traversal'
  | 'illegal-character'
  | 'malformed-separator'
  | 'unknown-surface'

/** One reason one field of one identity is unsafe. */
export interface UnitIdIssue {
  readonly field: 'surface' | 'containerId' | 'unitKey'
  readonly reason: UnitIdRejection
  /** Human-readable, with the offending value JSON-escaped — never echoed raw. */
  readonly message: string
}

/** Thrown by {@link assertSafeUnitId}, {@link parseSafeUnitId}, {@link parseUnitId}. */
export class UnitIdError extends Error {
  readonly issues: readonly UnitIdIssue[]

  constructor(message: string, issues: readonly UnitIdIssue[] = []) {
    super(message)
    this.name = 'UnitIdError'
    this.issues = issues
  }
}

function issue(
  field: UnitIdIssue['field'],
  reason: UnitIdRejection,
  value: string,
  detail: string,
): UnitIdIssue {
  return { field, reason, message: `${field} ${JSON.stringify(value)}: ${detail}` }
}

function checkContainerId(value: string): UnitIdIssue | undefined {
  if (value === '') return issue('containerId', 'empty', value, 'must not be empty')
  if (value.length > MAX_CONTAINER_ID_LENGTH) {
    return issue(
      'containerId',
      'too-long',
      value,
      `must be at most ${MAX_CONTAINER_ID_LENGTH} characters`,
    )
  }
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    return issue(
      'containerId',
      'path-traversal',
      value,
      'must not contain "..", "/" or "\\" — container ids are used as file names',
    )
  }
  if (!CONTAINER_ID_PATTERN.test(value)) {
    return issue(
      'containerId',
      'illegal-character',
      value,
      'must start with a letter or digit and use only letters, digits, ".", "_" and "-"',
    )
  }
  return undefined
}

function checkUnitKey(value: string): UnitIdIssue | undefined {
  if (value === '') return issue('unitKey', 'empty', value, 'must not be empty')
  if (value.length > MAX_UNIT_KEY_LENGTH) {
    return issue('unitKey', 'too-long', value, `must be at most ${MAX_UNIT_KEY_LENGTH} characters`)
  }
  if (value.includes('..') || value.includes('\\')) {
    return issue('unitKey', 'path-traversal', value, 'must not contain ".." or "\\"')
  }
  if (!UNIT_KEY_PATTERN.test(value)) {
    return issue(
      'unitKey',
      'illegal-character',
      value,
      'must start with a letter or digit and use only letters, digits, ".", "_", "-", ":" and "/"',
    )
  }
  if (value.includes('//') || value.endsWith('/')) {
    return issue('unitKey', 'malformed-separator', value, 'must not contain "//" or end with "/"')
  }
  return undefined
}

/** True when `value` is safe to use as a container id (and therefore as a file name). */
export function isSafeContainerId(value: string): boolean {
  return checkContainerId(value) === undefined
}

/** True when `value` is safe to use as a unit key inside a PO `msgctxt`. */
export function isSafeUnitKey(value: string): boolean {
  return checkUnitKey(value) === undefined
}

/**
 * Collect every safety problem with `id`. Returns an empty array for a safe identity;
 * callers that want to fail fast use {@link assertSafeUnitId}.
 */
export function validateUnitId(id: UnitId): readonly UnitIdIssue[] {
  const issues: UnitIdIssue[] = []
  if (!isSurface(id.surface)) {
    issues.push(
      issue(
        'surface',
        'unknown-surface',
        String(id.surface),
        `must be one of ${SURFACES.join(', ')}`,
      ),
    )
  }
  const container = checkContainerId(id.containerId)
  if (container) issues.push(container)
  const key = checkUnitKey(id.unitKey)
  if (key) issues.push(key)
  return issues
}

/** Throw a {@link UnitIdError} unless `id` passes every safety rule. */
export function assertSafeUnitId(id: UnitId): void {
  const issues = validateUnitId(id)
  if (issues.length > 0) {
    throw new UnitIdError(`unsafe unit id: ${issues.map((i) => i.message).join('; ')}`, issues)
  }
}

/** Render a unit id as the `<surface>:<containerId>:<unitKey>` string used as PO `msgctxt`. */
export function formatUnitId(id: UnitId): string {
  return `${id.surface}:${id.containerId}:${id.unitKey}`
}

/**
 * Parse a `<surface>:<containerId>:<unitKey>` string. Structural only — it accepts any
 * characters the shape allows, so ids read from content must additionally pass
 * {@link assertSafeUnitId} (or be parsed with {@link parseSafeUnitId}).
 */
export function parseUnitId(raw: string): UnitId {
  const parts = raw.split(':')
  if (parts.length < 3) {
    throw new UnitIdError(`invalid unit id: ${JSON.stringify(raw)}`)
  }
  const [surface, containerId, ...rest] = parts
  if (surface !== 'slides' && surface !== 'labs' && surface !== 'quiz') {
    throw new UnitIdError(`invalid surface in unit id: ${JSON.stringify(raw)}`)
  }
  if (containerId === undefined || containerId === '' || rest.join(':') === '') {
    throw new UnitIdError(`invalid unit id: ${JSON.stringify(raw)}`)
  }
  return { surface, containerId, unitKey: rest.join(':') }
}

/** {@link parseUnitId} plus the safety gate — the entry point for ids read from content. */
export function parseSafeUnitId(raw: string): UnitId {
  const id = parseUnitId(raw)
  assertSafeUnitId(id)
  return id
}

/**
 * Total order over identities, by formatted id. The catalog layer sorts entries with
 * this so PO output is stably ordered (spec 002 FR-005) without a locale-sensitive
 * comparison: plain code-unit ordering, identical on every machine.
 */
export function compareUnitIds(a: UnitId, b: UnitId): number {
  const left = formatUnitId(a)
  const right = formatUnitId(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}
