/**
 * The write half of the codec (ADR 0013): one canonical spelling per model.
 *
 * Spec 002 FR-005 wants a no-change `extract` to be a zero-byte diff, and SC-002 makes
 * that measurable. That only holds if the writer owns three decisions a general-purpose
 * PO library keeps for itself:
 *
 * - **Ordering.** Header, then live entries by `msgctxt`, then obsolete entries by
 *   `msgctxt` — code-unit order, identical on every machine. (`catalog.ts` sorts the
 *   same set with core's `compareUnitIds`; the two agree by construction, because
 *   `compareUnitIds` *is* code-unit order over the formatted id, and a test pins it.)
 * - **Wrapping.** Strings break after embedded newlines and nowhere else, the shape
 *   `msgcat --no-wrap` produces. Column-based wrapping would make the bytes depend on a
 *   width constant and would re-flow a whole entry when one word changes; breaking only
 *   at newlines keeps a diff proportional to the edit.
 * - **Volatility.** Nothing here writes a timestamp. `POT-Creation-Date` and friends are
 *   the reason PO files churn in git; a header field a catalog already carries is passed
 *   through untouched, but none is ever synthesized.
 */

import { escapePoString } from './escape.js'
import { isHeaderEntry, type PoEntry, type PoFile } from './po-file.js'

/**
 * Split a value into the chunks that become adjacent strings: after each newline, and
 * nowhere else. A value that merely *ends* in a newline stays on one line, matching what
 * gettext writes.
 */
function chunk(value: string): readonly string[] {
  const parts = value.split('\n')
  const chunks = parts.map((part, index) => (index < parts.length - 1 ? `${part}\n` : part))
  if (chunks.length > 1 && chunks[chunks.length - 1] === '') chunks.pop()
  return chunks
}

function renderField(prefix: string, keyword: string, value: string): readonly string[] {
  const chunks = chunk(value)
  if (chunks.length <= 1) {
    return [`${prefix}${keyword} "${escapePoString(value)}"`]
  }
  return [`${prefix}${keyword} ""`, ...chunks.map((part) => `${prefix}"${escapePoString(part)}"`)]
}

function renderEntry(entry: PoEntry): string {
  const lines: string[] = []

  for (const comment of entry.comments) {
    lines.push(`#${comment.marker}${comment.text}`)
  }
  if (entry.flags.length > 0) {
    lines.push(`#, ${[...new Set(entry.flags)].join(', ')}`)
  }

  const previous = entry.previous
  if (previous !== undefined) {
    const prefix = entry.obsolete ? '#~| ' : '#| '
    if (previous.msgctxt !== undefined)
      lines.push(...renderField(prefix, 'msgctxt', previous.msgctxt))
    if (previous.msgid !== undefined) lines.push(...renderField(prefix, 'msgid', previous.msgid))
    if (previous.msgidPlural !== undefined) {
      lines.push(...renderField(prefix, 'msgid_plural', previous.msgidPlural))
    }
  }

  const prefix = entry.obsolete ? '#~ ' : ''
  if (entry.msgctxt !== undefined) lines.push(...renderField(prefix, 'msgctxt', entry.msgctxt))
  lines.push(...renderField(prefix, 'msgid', entry.msgid))

  if (entry.msgidPlural !== undefined) {
    lines.push(...renderField(prefix, 'msgid_plural', entry.msgidPlural))
    for (const [index, form] of entry.msgstr.entries()) {
      lines.push(...renderField(prefix, `msgstr[${index}]`, form))
    }
  } else {
    lines.push(...renderField(prefix, 'msgstr', entry.msgstr[0] ?? ''))
  }

  return `${lines.join('\n')}\n`
}

/**
 * Total order over entries: by `msgctxt`, then `msgid`. Code-unit order, not
 * locale-aware, so the ordering is identical on every machine (FR-005).
 *
 * The two keys are compared in sequence rather than joined into one string. Any
 * separator character can also occur inside a `msgctxt` or a `msgid`, so a joined key
 * can order two distinct pairs as equal — and the obvious "safe" separator, a NUL byte,
 * is what makes a file undiffable in git.
 */
function compareEntries(a: PoEntry, b: PoEntry): number {
  const context = compareStrings(a.msgctxt ?? '', b.msgctxt ?? '')
  return context !== 0 ? context : compareStrings(a.msgid, b.msgid)
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Render a catalog in its canonical spelling. Deterministic: the same model produces the
 * same bytes on every machine and every run, which is what makes SC-002 testable against
 * our own serializer instead of a dependency's formatting.
 */
export function serializePo(file: PoFile): string {
  const headers = file.entries.filter((entry) => isHeaderEntry(entry))
  const rest = file.entries.filter((entry) => !isHeaderEntry(entry))
  const live = rest.filter((entry) => !entry.obsolete).sort(compareEntries)
  const obsolete = rest.filter((entry) => entry.obsolete).sort(compareEntries)

  const blocks = [...headers, ...live, ...obsolete].map(renderEntry)
  return blocks.join('\n')
}
