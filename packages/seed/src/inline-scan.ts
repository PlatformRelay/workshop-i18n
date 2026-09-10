/**
 * Linear scans for the two inline constructs the markup checks need to find: code spans
 * and `{{ … }}` interpolations.
 *
 * Both used to be regular expressions, and both were super-linear on hostile input — the
 * code-span pattern backtracks cubically over long backtick runs (8k backticks took 38 s),
 * and a lazy interpolation pattern rescans to the end of the string for every unclosed
 * `{{`. A translated tree is untrusted, so these are hand-written scans whose cost is
 * linear in the input.
 */

/** One code span: its offsets (backticks included) and its raw content. */
export interface CodeSpan {
  readonly start: number
  readonly end: number
  readonly content: string
}

interface BacktickRun {
  readonly start: number
  readonly length: number
  /** Backticks usable to *open* a span: one fewer after a backslash escape (CommonMark). */
  readonly openLength: number
}

function backtickRuns(text: string): BacktickRun[] {
  const runs: BacktickRun[] = []
  let index = 0
  while (index < text.length) {
    if (text.charCodeAt(index) !== 0x60) {
      index += 1
      continue
    }
    const start = index
    while (index < text.length && text.charCodeAt(index) === 0x60) index += 1
    let slashes = 0
    for (let back = start - 1; back >= 0 && text.charCodeAt(back) === 0x5c; back -= 1) slashes += 1
    const length = index - start
    runs.push({ start, length, openLength: slashes % 2 === 1 ? length - 1 : length })
  }
  return runs
}

/**
 * Find the code spans CommonMark would, in one pass: a run of *n* backticks opens a span
 * that the next run of exactly *n* backticks closes, and an opener with no closer is
 * literal text. A backslash before a run escapes its first backtick for opening only —
 * inside a span a backslash is literal, so it never stops a closer.
 *
 * Linear: each length keeps one cursor into its own list of runs, and cursors only move
 * forward.
 */
export function findCodeSpans(text: string): readonly CodeSpan[] {
  const runs = backtickRuns(text)
  const byLength = new Map<number, number[]>()
  runs.forEach((run, index) => {
    const list = byLength.get(run.length)
    if (list === undefined) byLength.set(run.length, [index])
    else list.push(index)
  })
  const cursors = new Map<number, number>()
  const spans: CodeSpan[] = []
  let index = 0
  while (index < runs.length) {
    const open = runs[index] as BacktickRun
    const list = open.openLength > 0 ? byLength.get(open.openLength) : undefined
    if (list === undefined) {
      index += 1
      continue
    }
    let cursor = cursors.get(open.openLength) ?? 0
    while (cursor < list.length && (list[cursor] as number) <= index) cursor += 1
    cursors.set(open.openLength, cursor)
    const closeIndex = list[cursor]
    if (closeIndex === undefined) {
      index += 1
      continue
    }
    const close = runs[closeIndex] as BacktickRun
    const openEnd = open.start + open.length
    const openStart = openEnd - open.openLength
    spans.push({
      start: openStart,
      end: close.start + close.length,
      content: text.slice(openEnd, close.start),
    })
    index = closeIndex + 1
  }
  return spans
}

/** Complete `{{ … }}` interpolations, and how many `{{` openers there are in all. */
export interface Mustaches {
  readonly complete: readonly string[]
  readonly openers: number
}

/** Find interpolations in one pass. An opener whose closer never comes is still counted. */
export function findMustaches(text: string): Mustaches {
  const complete: string[] = []
  let openers = 0
  let cursor = 0
  let closable = true
  for (;;) {
    const open = text.indexOf('{{', cursor)
    if (open < 0) break
    openers += 1
    cursor = open + 2
    if (!closable) continue
    const close = text.indexOf('}}', cursor)
    if (close < 0) {
      // No closer anywhere ahead, so no later opener can close either.
      closable = false
      continue
    }
    complete.push(text.slice(open, close + 2))
    cursor = close + 2
  }
  return { complete, openers }
}
