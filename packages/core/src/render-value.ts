/**
 * Rendering hostile values for error messages.
 *
 * Two things a rejected value must not do on its way into a message: run its own
 * stringification, and control how the message reads. `JSON.stringify` handles the first
 * and escapes C0 control characters, but it passes bidi overrides through unchanged — so
 * a `U+202E` inside a rejected id visually reverses the rest of the line reporting it,
 * and a CLI can be made to display a path or a verdict that is not what it received.
 */

/** Bidi controls and the zero-width characters that hide inside an identifier. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Replace bidi and zero-width characters with their escape spelling. */
export function neutraliseInvisible(text: string): string {
  return text.replace(INVISIBLE, (character) => {
    const code = character.codePointAt(0) ?? 0
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/**
 * Render any value for an error message: never invoking its own `toString`, with control
 * characters escaped by `JSON.stringify` and bidi/zero-width characters neutralised on
 * top. Values `JSON.stringify` refuses (cycles, bigint) degrade to their type name.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return neutraliseInvisible(JSON.stringify(value))
  try {
    const rendered = JSON.stringify(value) ?? String(value)
    return neutraliseInvisible(rendered)
  } catch {
    return typeof value
  }
}
