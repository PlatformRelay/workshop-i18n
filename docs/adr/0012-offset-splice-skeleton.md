# ADR 0012: The skeleton is the source file with holes, not a re-serialized AST

- **Status:** proposed
- **Date:** 2026-09-05

## Context

Constitution III demands that losslessness be *proven*: fenced code, commands, API identifiers and
image references must be byte-identical across locales, and spec 001 FR-005 requires the protected
skeleton to survive round-trip byte-identically. The obvious implementation — parse markdown to an
AST, replace prose nodes, serialize back — cannot deliver that. Every markdown serializer
normalizes: emphasis markers (`*` vs `_`), bullet characters, setext vs ATX headings, fence
character and length, indentation, hard-break spelling, entity escaping, trailing whitespace. A
`mdast-util-to-markdown` round-trip of an untouched English file already produces a diff. Under
that design "byte-identical fences" becomes a property we assert in tests and violate in
production the first time a consumer writes markdown the serializer spells differently.

The consumer corpora make this concrete: ~400 Slidev slides with multiple frontmatter blocks per
file, Vue islands, `src:` includes, magic-move fences and HTML-comment speaker notes. Any of those
is a serializer edge case; all of them are content we must never touch.

## Decision

Extraction never re-serializes. It **locates**.

- `extract` records, for every translatable unit, the half-open byte range `[start, end)` of that
  unit's prose in the original source file, alongside its stable identity and source hash.
- The **skeleton** is the original file text itself plus that list of holes. It is not a
  transformed representation; nothing is rebuilt from an AST.
- `compose` produces a locale file by splicing translations into those ranges in descending order
  and copying every other byte through unchanged.

Two consequences follow *by construction*, not by test discipline:

1. Composing a locale whose every unit is untranslated reproduces the English source byte-for-byte.
2. Any byte outside a recorded prose range — fences, frontmatter, Vue islands, includes, images,
   indentation, blank lines — is byte-identical in every locale, because it is literally copied.

A markdown parser is still used, but **only to compute offsets**. Its output is never emitted.
That reduces the parser from a correctness-critical component to a locator: a parser bug can
mis-scope a unit (a visible, testable defect) but can never corrupt the protected skeleton, and the
parser can be replaced without changing a single output byte.

Ranges are recomputed by `extract` from the current source on every run and are never persisted as
translation state — identity (ADR 0005) is what persists. Offsets are a within-run detail, so a
moved or reordered slide changes offsets while identities and catalogs are untouched.

## Consequences

- The round-trip property test for English is an *identity* assertion (`compose(extract(x)) === x`),
  which is strong enough to run over the entire hostile corpus rather than a curated subset.
- Overrides (ADR 0008) stay outside this mechanism: they replace whole slides rather than splicing
  spans, and therefore carry their own fence-identity gate (spec 003 FR-004).
- Translations must be spliceable as text, so a unit's range must cover a self-contained span:
  inline markup stays literal inside the unit (spec 001 FR-004) rather than being decomposed.
- Composition cost is linear in file size with no parse on the compose path.
- A unit whose translation is missing or fuzzy splices English plus a watermark (spec 003 FR-005);
  the watermark is the only case where composed output differs from a pure copy in the skeleton's
  vicinity, and it is confined to the hole.
