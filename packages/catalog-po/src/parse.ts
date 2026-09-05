/**
 * The read half of the codec (ADR 0013).
 *
 * Two properties matter more than anything else here:
 *
 * - **Total.** Every construct the parser meets is either understood or refused with a
 *   {@link PoSyntaxError} naming the file and line. There is no branch that skips a line
 *   it cannot classify, because a skipped line is translator work deleted on the next
 *   write (spec 002 edge case: "hand-edited catalog with broken syntax -> hard error with
 *   file/line, never silent re-write").
 * - **Lossless.** Comment classes, flags and previous-source we never interpret all land
 *   in the model, so they survive serialization.
 *
 * Adjacent strings are concatenated *before* unescaping. That is deliberate: a
 * multi-byte character written as octal byte escapes can be split across two
 * continuation lines, and decoding each line on its own would reject a file gettext
 * itself produced.
 */

import { type PoLocation, PoSyntaxError, UnsupportedPoError } from './errors.js'
import { unescapePoString } from './escape.js'
import type { PoComment, PoEntry, PoFile, PoPrevious } from './po-file.js'

/** Options for {@link parsePo}. */
export interface ParsePoOptions {
  /** Catalog path, used only to name the file in error messages. */
  readonly fileName: string
}

/** Accumulated raw (still-escaped) text for one field, plus where it started. */
interface Slot {
  raw: string
  readonly line: number
}

interface Builder {
  comments: PoComment[]
  flags: string[]
  /** Field name -> raw text. `previous.*` keys hold `#|` fields. */
  slots: Map<string, Slot>
  /** The slot continuation lines append to. */
  target: string | undefined
  /** `undefined` until a `msg*` line settles whether the entry is live or obsolete. */
  obsolete: boolean | undefined
  line: number
  touched: boolean
}

const KEYWORDS = new Set(['msgctxt', 'msgid', 'msgid_plural', 'msgstr'])
const KEYWORD_LINE = /^([A-Za-z_]+(?:\[[0-9]+\])?)[ \t]*(.*)$/
const INDEXED_MSGSTR = /^msgstr\[([0-9]+)\]$/
const BOM = '\ufeff'

function newBuilder(line: number): Builder {
  return {
    comments: [],
    flags: [],
    slots: new Map(),
    target: undefined,
    obsolete: undefined,
    line,
    touched: false,
  }
}

/**
 * True once the builder holds a `msg*` field. Comment lines (including `#|`) belong to
 * the block *before* that, so their arrival after this point means a new entry has begun
 * — which is how catalogs written without blank lines between entries still parse.
 */
function hasMessageContent(builder: Builder): boolean {
  for (const key of builder.slots.keys()) {
    if (!key.startsWith('previous.')) return true
  }
  return false
}

/**
 * Read every quoted string on a line and return their raw contents concatenated,
 * escapes still intact.
 */
function readStringLiterals(text: string, at: PoLocation): string {
  let index = 0
  let raw = ''
  let found = false

  while (index < text.length) {
    const character = text[index]
    if (character === ' ' || character === '\t') {
      index += 1
      continue
    }
    if (character !== '"') {
      throw new PoSyntaxError(at, `expected a quoted string, found ${JSON.stringify(character)}`)
    }
    index += 1
    let closed = false
    while (index < text.length) {
      const inner = text[index]
      if (inner === '\\') {
        // Keep the escape intact; unescaping happens once the whole field is assembled.
        const escaped = text[index + 1]
        if (escaped === undefined) {
          throw new PoSyntaxError(at, 'string ends with a lone backslash')
        }
        raw += inner + escaped
        index += 2
        continue
      }
      if (inner === '"') {
        closed = true
        index += 1
        break
      }
      raw += inner
      index += 1
    }
    if (!closed) {
      throw new PoSyntaxError(at, 'unterminated string')
    }
    found = true
  }

  if (!found) {
    throw new PoSyntaxError(at, 'expected a quoted string')
  }
  return raw
}

function decode(builder: Builder, key: string, fileName: string): string | undefined {
  const slot = builder.slots.get(key)
  if (slot === undefined) return undefined
  return unescapePoString(slot.raw, { fileName, line: slot.line })
}

/** Assemble one entry, or `undefined` when the block held nothing at all. */
function finishEntry(builder: Builder, fileName: string): PoEntry | undefined {
  if (!builder.touched) return undefined
  const at: PoLocation = { fileName, line: builder.line }

  const msgid = decode(builder, 'msgid', fileName)
  if (msgid === undefined) {
    // Say what the author actually did, not which field the parser wanted next.
    if (builder.slots.size === 0) {
      throw new PoSyntaxError(
        at,
        'comment block is not followed by an entry — a catalog cannot end with, or ' +
          'contain, comments that belong to no msgid',
      )
    }
    const context = decode(builder, 'msgctxt', fileName)
    throw new PoSyntaxError(
      at,
      context === undefined
        ? 'entry is missing its msgid'
        : `entry ${JSON.stringify(context)} has a msgctxt but no msgid`,
    )
  }

  const msgidPlural = decode(builder, 'msgid_plural', fileName)
  const singular = decode(builder, 'msgstr', fileName)

  const indices = [...builder.slots.keys()]
    .map((key) => INDEXED_MSGSTR.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1] ?? '0', 10))
    .sort((a, b) => a - b)

  if (indices.length > 0 && singular !== undefined) {
    throw new PoSyntaxError(at, 'entry mixes msgstr with indexed msgstr[N]')
  }
  if (indices.length > 0 && msgidPlural === undefined) {
    throw new UnsupportedPoError(at, 'indexed msgstr[N] without msgid_plural is not supported')
  }
  if (msgidPlural !== undefined && indices.length === 0) {
    throw new PoSyntaxError(at, 'plural entry has no msgstr[N]')
  }

  const indexed: string[] = []
  for (const [position, value] of indices.entries()) {
    if (value !== position) {
      throw new PoSyntaxError(
        at,
        `plural msgstr indices must run from 0 without gaps, found msgstr[${value}] at position ${position}`,
      )
    }
    indexed.push(decode(builder, `msgstr[${value}]`, fileName) ?? '')
  }

  if (singular === undefined && indexed.length === 0) {
    const context = decode(builder, 'msgctxt', fileName)
    const which = context === undefined ? `msgid ${JSON.stringify(msgid)}` : JSON.stringify(context)
    throw new PoSyntaxError(at, `entry ${which} is truncated: it has a msgid but no msgstr line`)
  }

  const previous: PoPrevious = {
    msgctxt: decode(builder, 'previous.msgctxt', fileName),
    msgid: decode(builder, 'previous.msgid', fileName),
    msgidPlural: decode(builder, 'previous.msgid_plural', fileName),
  }
  const hasPrevious =
    previous.msgctxt !== undefined ||
    previous.msgid !== undefined ||
    previous.msgidPlural !== undefined

  return {
    comments: builder.comments,
    flags: builder.flags,
    previous: hasPrevious ? previous : undefined,
    msgctxt: decode(builder, 'msgctxt', fileName),
    msgid,
    msgidPlural,
    msgstr: singular !== undefined ? [singular] : indexed,
    obsolete: builder.obsolete === true,
    line: builder.line,
  }
}

function classifyComment(rest: string): PoComment {
  const first = rest[0]
  if (first === '.' || first === ':') {
    return { marker: first, text: rest.slice(1) }
  }
  return { marker: '', text: rest }
}

/**
 * Parse a catalog. Every failure is a {@link PoSyntaxError} (or its
 * {@link UnsupportedPoError} subclass) naming `fileName` and the offending line.
 */
export function parsePo(text: string, options: ParsePoOptions): PoFile {
  const { fileName } = options
  const lines = (text.startsWith(BOM) ? text.slice(BOM.length) : text).split('\n')
  const entries: PoEntry[] = []
  let builder = newBuilder(1)

  const flush = (): void => {
    const entry = finishEntry(builder, fileName)
    if (entry !== undefined) entries.push(entry)
  }

  const restart = (line: number): void => {
    flush()
    builder = newBuilder(line)
  }

  const slotOf = (key: string, at: PoLocation): Slot => {
    const existing = builder.slots.get(key)
    if (existing !== undefined) return existing
    const slot: Slot = { raw: '', line: at.line }
    builder.slots.set(key, slot)
    return slot
  }

  const setObsolete = (isObsolete: boolean, at: PoLocation): void => {
    if (builder.obsolete === undefined) {
      builder.obsolete = isObsolete
      return
    }
    if (builder.obsolete !== isObsolete) {
      throw new PoSyntaxError(at, 'entry mixes obsolete (#~) and live lines')
    }
  }

  const handlePrevious = (afterBar: string, obsoleteLine: boolean, at: PoLocation): void => {
    if (hasMessageContent(builder)) restart(at.line)
    setObsolete(obsoleteLine, at)
    const content = afterBar.replace(/^[ \t]/, '')

    if (content.startsWith('"')) {
      const target = builder.target
      if (target === undefined || !target.startsWith('previous.')) {
        throw new PoSyntaxError(at, 'previous-source continuation with no preceding #| keyword')
      }
      slotOf(target, at).raw += readStringLiterals(content, at)
      builder.touched = true
      return
    }

    const match = KEYWORD_LINE.exec(content)
    const keyword = match?.[1]
    if (match === null || keyword === undefined || !KEYWORDS.has(keyword) || keyword === 'msgstr') {
      throw new PoSyntaxError(
        at,
        `unexpected keyword in previous-source comment: ${JSON.stringify(content)}`,
      )
    }
    const key = `previous.${keyword}`
    if (builder.slots.has(key)) {
      throw new PoSyntaxError(at, `duplicate #| ${keyword} in one entry`)
    }
    slotOf(key, at).raw += readStringLiterals(match[2] ?? '', at)
    builder.target = key
    builder.touched = true
  }

  const handleMessageLine = (content: string, obsoleteLine: boolean, at: PoLocation): void => {
    if (content.startsWith('"')) {
      const target = builder.target
      if (target === undefined) {
        throw new PoSyntaxError(at, 'string continuation with no preceding keyword')
      }
      setObsolete(obsoleteLine, at)
      slotOf(target, at).raw += readStringLiterals(content, at)
      builder.touched = true
      return
    }

    const match = KEYWORD_LINE.exec(content)
    const keyword = match?.[1]
    if (match === null || keyword === undefined) {
      throw new PoSyntaxError(at, `unrecognised line: ${JSON.stringify(content)}`)
    }
    const base = INDEXED_MSGSTR.test(keyword) ? 'msgstr' : keyword
    if (!KEYWORDS.has(base)) {
      throw new PoSyntaxError(at, `unknown keyword ${JSON.stringify(keyword)}`)
    }

    // A fresh msgctxt or msgid after a complete entry starts the next one.
    const complete =
      builder.slots.has('msgstr') ||
      [...builder.slots.keys()].some((key) => INDEXED_MSGSTR.test(key))
    if ((keyword === 'msgctxt' || keyword === 'msgid') && complete) restart(at.line)

    if (base === 'msgstr' && !builder.slots.has('msgid')) {
      throw new PoSyntaxError(at, 'msgstr before msgid')
    }
    if (keyword === 'msgid_plural' && !builder.slots.has('msgid')) {
      throw new PoSyntaxError(at, 'msgid_plural before msgid')
    }
    if (keyword === 'msgctxt' && builder.slots.has('msgid')) {
      throw new PoSyntaxError(at, 'msgctxt must precede msgid')
    }
    if (builder.slots.has(keyword)) {
      throw new PoSyntaxError(at, `duplicate ${keyword} in one entry`)
    }

    setObsolete(obsoleteLine, at)
    slotOf(keyword, at).raw += readStringLiterals(match[2] ?? '', at)
    builder.target = keyword
    builder.touched = true
  }

  for (const [offset, rawLine] of lines.entries()) {
    const lineNumber = offset + 1
    const at: PoLocation = { fileName, line: lineNumber }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const body = line.replace(/^[ \t]+/, '')

    if (body === '') {
      if (builder.touched) restart(lineNumber + 1)
      else builder = newBuilder(lineNumber + 1)
      continue
    }

    if (!body.startsWith('#')) {
      handleMessageLine(body, false, at)
      continue
    }

    const rest = body.slice(1)
    if (rest.startsWith('~')) {
      const inner = rest.slice(1)
      if (inner.startsWith('|')) {
        handlePrevious(inner.slice(1), true, at)
      } else {
        handleMessageLine(inner.replace(/^[ \t]/, ''), true, at)
      }
      continue
    }
    if (rest.startsWith('|')) {
      handlePrevious(rest.slice(1), false, at)
      continue
    }
    if (rest.startsWith(',')) {
      if (hasMessageContent(builder)) restart(lineNumber)
      for (const flag of rest.slice(1).split(',')) {
        const trimmed = flag.trim()
        if (trimmed !== '' && !builder.flags.includes(trimmed)) builder.flags.push(trimmed)
      }
      builder.touched = true
      continue
    }

    if (hasMessageContent(builder)) restart(lineNumber)
    builder.comments.push(classifyComment(rest))
    builder.touched = true
  }

  flush()

  const first = entries[0]
  if (
    first !== undefined &&
    (first.msgctxt !== undefined || first.msgid !== '' || first.obsolete)
  ) {
    throw new PoSyntaxError(
      { fileName, line: first.line },
      'catalog does not start with a header entry (msgid "")',
    )
  }

  return { entries }
}
