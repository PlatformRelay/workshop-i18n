/**
 * A JSON reader that reports **where** every value is, not just what it is.
 *
 * `JSON.parse` throws the file away: it returns values with no offsets, so an extractor
 * built on it can only put a translation back by re-serializing the whole document. That
 * is precisely the design ADR 0012 rejects. Re-serializing a quiz bank normalizes key
 * order, indentation, and the choice between `é` and `é` — and the two consumer
 * banks disagree about all three, so a `JSON.parse` → mutate → `JSON.stringify` round
 * trip rewrites every line of a file in which nothing was translated.
 *
 * So this module scans instead. Every node carries the half-open range it occupies in
 * the source, and a string additionally carries the range *inside* its quotes plus the
 * decoded value. The extractor makes a hole out of the inner range, composition splices
 * an escaped body back into it, and the quotes — like every other byte — are copied.
 *
 * ## Deliberately stricter than `JSON.parse` in exactly two places
 *
 * - **A duplicate object key is refused.** JSON permits it and `JSON.parse` silently
 *   keeps the last one. A question with two `prompt` keys has two candidate ranges for
 *   one unit id, and picking one silently is how a translation ends up spliced into the
 *   copy nobody reads. Refusing names the file and the line instead.
 * - **A leading byte-order mark is refused**, with a message that says so. `JSON.parse`
 *   also rejects it, but with "Unexpected token", which sends the reader looking at the
 *   wrong thing.
 *
 * Everything else follows RFC 8259 exactly, and the corpus tests assert that agreement
 * against `JSON.parse` string by string rather than trusting it.
 *
 * Pure and offline: no `node:fs`, no network, no `eval`, and nothing here executes a
 * byte of consumer content (constitution IV, SECURITY.md).
 */

import { positionAt } from './source.js'

/** A JSON string, with the range inside its quotes and the value those bytes denote. */
export interface JsonString {
  readonly kind: 'string'
  /** Inclusive offset of the opening quote. */
  readonly start: number
  /** Exclusive offset just past the closing quote. */
  readonly end: number
  /** Inclusive offset of the first byte inside the quotes. */
  readonly innerStart: number
  /** Exclusive offset just past the last byte inside the quotes. */
  readonly innerEnd: number
  /** The decoded value — escapes resolved, exactly as `JSON.parse` would give it. */
  readonly value: string
}

/** One `"key": value` pair of an object, both located. */
export interface JsonMember {
  readonly key: JsonString
  readonly value: JsonNode
}

/** A located JSON value. */
export type JsonNode =
  | JsonString
  | {
      readonly kind: 'object'
      readonly start: number
      readonly end: number
      readonly members: readonly JsonMember[]
    }
  | {
      readonly kind: 'array'
      readonly start: number
      readonly end: number
      readonly items: readonly JsonNode[]
    }
  | {
      readonly kind: 'number'
      readonly start: number
      readonly end: number
      readonly value: number
    }
  | {
      readonly kind: 'boolean'
      readonly start: number
      readonly end: number
      readonly value: boolean
    }
  | { readonly kind: 'null'; readonly start: number; readonly end: number }

/** Thrown by {@link scanJson}; carries the offset and the 1-based line and column. */
export class JsonScanError extends Error {
  readonly offset: number
  readonly line: number
  readonly column: number
  /** Caller-supplied label for the file, if any. */
  readonly source: string | undefined

  constructor(detail: string, text: string, offset: number, source?: string) {
    const { line, column } = positionAt(text, offset)
    const where = source === undefined ? '' : `${source}:`
    super(`${where}${line}:${column}: ${detail}`)
    this.name = 'JsonScanError'
    this.offset = offset
    this.line = line
    this.column = column
    this.source = source
  }
}

/** The value of one member of an object node, or `undefined`. Never walks a prototype. */
export function memberOf(node: JsonNode | undefined, key: string): JsonNode | undefined {
  if (node?.kind !== 'object') return undefined
  return node.members.find((member) => member.key.value === key)?.value
}

/** RFC 8259 insignificant whitespace: space, tab, line feed, carriage return. Nothing else. */
function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

/** Escape characters JSON spells with a single letter, and what each denotes. */
const SHORT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
})

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/

/**
 * How deeply objects and arrays may nest.
 *
 * The scanner is recursive descent, so without a limit a bank nesting a few thousand
 * arrays exhausts the JavaScript stack and surfaces as an unhandled `RangeError` — a
 * crash with no file, no line and no diagnostic code, on input SECURITY.md tells us to
 * treat as hostile. The limit turns that into the same named failure as any other
 * malformed document. Both consumer banks nest four levels deep, so the ceiling is three
 * orders of magnitude above anything real.
 */
export const MAX_NESTING_DEPTH = 500

class Scanner {
  private at = 0
  private depth = 0

  constructor(
    private readonly text: string,
    private readonly label: string | undefined,
  ) {}

  private fail(detail: string, offset = this.at): never {
    throw new JsonScanError(detail, this.text, offset, this.label)
  }

  /** Enter one nesting level, refusing to go deeper than {@link MAX_NESTING_DEPTH}. */
  private enter(): void {
    this.depth += 1
    if (this.depth > MAX_NESTING_DEPTH) {
      this.fail(`JSON nested deeper than ${MAX_NESTING_DEPTH} levels`)
    }
  }

  private skipWhitespace(): void {
    while (this.at < this.text.length && isWhitespace(this.text.charCodeAt(this.at))) this.at += 1
  }

  private expect(character: string): void {
    if (this.text[this.at] !== character) {
      this.fail(`expected ${JSON.stringify(character)}`)
    }
    this.at += 1
  }

  /** Read the whole document, refusing anything after the top-level value. */
  document(): JsonNode {
    if (this.text.startsWith('﻿')) {
      this.fail('JSON must not start with a byte-order mark', 0)
    }
    this.skipWhitespace()
    if (this.at >= this.text.length) this.fail('the document is empty')
    const value = this.value()
    this.skipWhitespace()
    if (this.at !== this.text.length) this.fail('unexpected content after the JSON document')
    return value
  }

  private value(): JsonNode {
    this.skipWhitespace()
    const character = this.text[this.at]
    if (character === undefined) this.fail('unexpected end of input')
    if (character === '{') return this.object()
    if (character === '[') return this.array()
    if (character === '"') return this.string()
    if (character === 't') return this.literal('true', true)
    if (character === 'f') return this.literal('false', false)
    if (character === 'n') return this.nullLiteral()
    return this.number()
  }

  private literal(word: string, value: boolean): JsonNode {
    const start = this.at
    if (!this.text.startsWith(word, start)) this.fail(`expected ${word}`)
    this.at += word.length
    return { kind: 'boolean', start, end: this.at, value }
  }

  private nullLiteral(): JsonNode {
    const start = this.at
    if (!this.text.startsWith('null', start)) this.fail('expected null')
    this.at += 4
    return { kind: 'null', start, end: this.at }
  }

  private number(): JsonNode {
    const start = this.at
    const match = NUMBER.exec(this.text.slice(start))?.[0]
    if (match === undefined || match === '') this.fail('expected a JSON value')
    this.at += match.length
    return { kind: 'number', start, end: this.at, value: Number(match) }
  }

  private string(): JsonString {
    const start = this.at
    this.expect('"')
    const innerStart = this.at
    let value = ''
    for (;;) {
      const character = this.text[this.at]
      if (character === undefined) this.fail('unterminated string', start)
      if (character === '"') {
        const innerEnd = this.at
        this.at += 1
        return { kind: 'string', start, end: this.at, innerStart, innerEnd, value }
      }
      if (character === '\\') {
        value += this.escape()
        continue
      }
      const code = character.charCodeAt(0)
      if (code < 0x20) {
        this.fail('a control character must be escaped inside a JSON string')
      }
      value += character
      this.at += 1
    }
  }

  /** Read one `\`-escape and return the character it denotes. */
  private escape(): string {
    const at = this.at
    this.at += 1
    const marker = this.text[this.at]
    if (marker === undefined) this.fail('unterminated escape', at)
    if (marker === 'u') {
      const hex = this.text.slice(this.at + 1, this.at + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        this.fail('a \\u escape must be followed by four hexadecimal digits', at)
      }
      this.at += 5
      // `fromCharCode`, not `fromCodePoint`: a surrogate pair is written as two escapes
      // and must be appended as two code units so it recombines, and a *lone* surrogate
      // must survive as a lone surrogate — which is what `JSON.parse` produces too.
      return String.fromCharCode(Number.parseInt(hex, 16))
    }
    const short = Object.hasOwn(SHORT_ESCAPES, marker) ? SHORT_ESCAPES[marker] : undefined
    if (short === undefined) this.fail(`unknown escape \\${marker}`, at)
    this.at += 1
    return short
  }

  private array(): JsonNode {
    const start = this.at
    this.expect('[')
    this.enter()
    const items: JsonNode[] = []
    this.skipWhitespace()
    if (this.text[this.at] === ']') {
      this.at += 1
      this.depth -= 1
      return { kind: 'array', start, end: this.at, items }
    }
    for (;;) {
      items.push(this.value())
      this.skipWhitespace()
      const character = this.text[this.at]
      if (character === ',') {
        this.at += 1
        continue
      }
      if (character === ']') {
        this.at += 1
        this.depth -= 1
        return { kind: 'array', start, end: this.at, items }
      }
      this.fail('expected "," or "]"')
    }
  }

  private object(): JsonNode {
    const start = this.at
    this.expect('{')
    this.enter()
    const members: JsonMember[] = []
    const seen = new Set<string>()
    this.skipWhitespace()
    if (this.text[this.at] === '}') {
      this.at += 1
      this.depth -= 1
      return { kind: 'object', start, end: this.at, members }
    }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.at] !== '"') this.fail('expected a quoted object key')
      const key = this.string()
      if (seen.has(key.value)) {
        this.fail(
          `duplicate object key ${JSON.stringify(key.value)}; which one is authoritative is not decidable`,
          key.start,
        )
      }
      seen.add(key.value)
      this.skipWhitespace()
      this.expect(':')
      members.push({ key, value: this.value() })
      this.skipWhitespace()
      const character = this.text[this.at]
      if (character === ',') {
        this.at += 1
        continue
      }
      if (character === '}') {
        this.at += 1
        this.depth -= 1
        return { kind: 'object', start, end: this.at, members }
      }
      this.fail('expected "," or "}"')
    }
  }
}

/**
 * Scan `text` as one JSON document, returning a tree in which every value knows its range.
 *
 * @throws {JsonScanError} naming the file, line and column of the first problem.
 */
export function scanJson(text: string, label?: string): JsonNode {
  return new Scanner(text, label).document()
}
