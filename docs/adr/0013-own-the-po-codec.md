# ADR 0013: Own the PO codec rather than depend on `gettext-parser`

- **Status:** proposed
- **Date:** 2026-09-05

## Context

ADR 0004 makes gettext PO the working format, and spec 002 turns that into hard requirements the
catalog layer must satisfy:

- `msgctxt` carries the stable unit id (FR-002);
- an English edit sets `fuzzy` **and** records the previous source as `#| msgid` (FR-003);
- a deleted unit becomes an obsolete `#~` entry rather than disappearing (FR-004);
- output is deterministic and stably ordered so a no-change `extract` is a zero-byte diff (FR-005,
  SC-002);
- translator-owned fields on untouched entries survive verbatim (FR-001).

`gettext-parser` is the ecosystem default, but it is built for compiling catalogs, not for
round-tripping them through git. It discards obsolete entries and comment classes it does not
model, it does not preserve `#|` previous-source, and its serializer owns line wrapping and entry
ordering — precisely the three decisions FR-005 requires us to control. Working around that means
post-processing its output, which is a fragile way to end up owning the format anyway.

The format itself is small: entries of `#.`/`#:`/`#,`/`#|` comments, optional `msgctxt`, `msgid`,
`msgstr`, C-style string escaping and adjacent-string continuation, plus `#~` obsolete lines.

## Decision

Implement PO reading and writing inside `packages/catalog-po`, with no third-party runtime
dependency. The codec is:

- **Total on the read side** — a syntax error is a hard error naming file and line (spec 002 edge
  case), never a silent partial parse or a silent rewrite.
- **Lossless on unknown input** — comment classes and flags we do not interpret are preserved in
  order on write, so a TMS that annotates entries does not lose its annotations on the next
  `extract`.
- **Deterministic** — a single canonical spelling: fixed entry ordering (by `msgctxt`), fixed
  wrapping, no `POT-Creation-Date`-style volatile headers. Same inputs produce the same bytes on
  every machine and every run.
- **Property-tested** — parse/serialize round-trip over generated and golden catalogs, plus the
  hostile escaping cases (embedded quotes, newlines, backslashes, non-ASCII) that spec 001's edge
  cases hand us.

Interoperability, not novelty, is the acceptance bar: catalogs must be readable by `msgfmt` and by
Weblate. Spec 004 verifies the Weblate review-flag convention against fixtures, and that mapping is
implemented here rather than in a wrapper.

## Consequences

- One less supply-chain edge in a repo that runs Scorecard and CodeQL, and no upstream lag when we
  need a comment class the dependency does not model.
- We own gettext conformance, including the parts we do not use. The codec is deliberately scoped:
  plural forms are parsed and preserved but not synthesized in v1 (workshop prose has no plural
  units); anything unsupported is an explicit error, never a quiet drop.
- The zero-byte-diff property (SC-002) becomes testable directly against our own serializer instead
  of being asserted about a dependency's formatting.
- If the scope ever grows past what this justifies, the codec is a package boundary and can be
  swapped behind its interface.
