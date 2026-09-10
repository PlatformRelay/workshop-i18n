/**
 * The visible fallback marker (spec 003 US1, FR-005; ADR 0009, ADR 0012).
 *
 * In preview mode a unit with no shipping-grade translation renders as its English text,
 * and a reviewer must be able to *see* that it is English in the rendered deck. The
 * marker is a short plain-text prefix placed **inside the unit's hole**:
 *
 * ```text
 * ⚠ EN: A Pod is the smallest deployable unit.
 * ```
 *
 * ## Why a text prefix inside the hole, and not something richer
 *
 * The alternatives were weighed against the one hard constraint — the protected
 * skeleton stays byte-identical (ADR 0012), which the output-side skeleton gate proves —
 * and against the four places a hole can sit:
 *
 * - **An HTML comment** is invisible in the rendered deck, so it fails US1 outright; the
 *   lab extractor also refuses `<!--` in any replacement.
 * - **A styled wrapper** (`<span class="i18n-fallback">`, a Vue component) needs CSS or a
 *   registered component in the consumer's deck — the generated tree would no longer
 *   build "unchanged" (FR-001) — and it cannot live in a frontmatter value a layout prints
 *   with `{{ }}` (it would show as literal tag text) or in a quiz string. It would also be
 *   markup the parity gate has to special-case.
 * - **A per-slide banner** means inserting bytes outside any hole, which is exactly what
 *   the skeleton gate forbids, and it cannot say *which* strings on the slide are English.
 * - **A text prefix** is valid in every hole encoding the extractors have: markdown prose
 *   (headings, list items, table cells, blockquotes, speaker notes), YAML scalars (the
 *   splice re-quotes them), JSON strings (the splice escapes them) and `<summary>` labels.
 *   It needs nothing from the consumer, marks each English string individually, is
 *   greppable in the generated source, and costs a handful of characters.
 *
 * The characters are chosen to be inert in every renderer involved: no `*`, `_`, `[`,
 * `` ` ``, `<`, `{`, `|`, `#`, `>` or leading `-`/`+`/digit, so the prefix cannot open
 * emphasis, a link reference, code, a tag, an interpolation, a table column, a heading, a
 * quote or a list. "⚠" (U+26A0) is in every system symbol font.
 *
 * Where a prefix still cannot be placed — the extractor refuses the splice, or the
 * composed file fails the skeleton gate — the unit falls back to plain English and a
 * `marker-omitted` warning names it, so the gap is still reported, just not painted.
 *
 * Strict (release) output never contains the marker: strict composition fails before it
 * would have to use one.
 */

/** The prefix a preview fallback unit carries. */
export const FALLBACK_MARKER = '⚠ EN: '

/** The fallback rendering of an English unit. */
export function markFallback(english: string): string {
  return `${FALLBACK_MARKER}${english}`
}

/** True when `rendered` is exactly the marked fallback of `english`. */
export function isMarkedFallback(rendered: string, english: string): boolean {
  return rendered === markFallback(english)
}
