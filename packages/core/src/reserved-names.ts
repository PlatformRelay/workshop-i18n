/**
 * File names Windows will not accept, shared by every identifier this tool turns into a
 * path: container ids become `overrides/<containerId>.md`, locales become `i18n/<locale>/`.
 *
 * Not exported from the package. Freezing the Set would be theatre — `Object.freeze`
 * does not stop `Set.prototype.add` — so the protection here is that nothing outside
 * this module can reach it.
 */

const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/**
 * True when `value` cannot be a file or directory name on Windows: a reserved device
 * name in any case, with or without an extension (`con`, `CON`, `con.md`), or a name
 * ending in `.`, which Windows strips — turning `s01.` and `s01` into one file.
 *
 * Longer names that merely start with a device name (`console`, `com10`, `nula`) are
 * fine, and are not rejected.
 */
export function isReservedFileName(value: string): boolean {
  if (value.endsWith('.')) return true
  const stem = value.split('.')[0]?.toLowerCase() ?? ''
  return WINDOWS_RESERVED_NAMES.has(stem)
}
