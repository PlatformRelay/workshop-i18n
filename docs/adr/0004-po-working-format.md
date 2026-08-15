# ADR 0004: Canonical unit model with gettext PO as the working format

- **Status:** proposed
- **Date:** 2026-08-15

## Context

The origin pack proposed XLIFF 2.1 as the canonical portability target. But the first TMS target
(Weblate) documents both its XLIFF 2 and its Markdown support as under development, while its
gettext PO support is its oldest, best-exercised path. Building the working format on the format
the chosen provider handles worst is risk-maximal. Goal 4 (automatic staleness) also maps exactly
onto gettext's native `fuzzy` semantics.

## Decision

- The **canonical model** is a tool-owned, versioned serialization of extracted units
  (`packages/core`), produced deterministically by `extract`.
- The **working exchange format is gettext PO**: `msgctxt` carries the stable unit id (ADR 0005),
  `#| msgid` carries previous-source for diff context, `fuzzy` marks staleness, and extracted
  comments carry source references and the source hash.
- Extraction happens at **paragraph granularity with markdown inline markup left literal** in the
  string (`**bold**`, `` `code` ``); a protected-token linter guards the literals instead of an
  inline-code model.
- **XLIFF 2.1 is demoted to an `export` subcommand** for archival and provider migration. It is
  not the canonical store and not a release gate.

## Consequences

- Weblate consumes the committed PO files with zero adapter code (ADR 0002, ADR 0006).
- Staleness (goal 4) falls out of `fuzzy` + source-hash provenance; no bespoke state machine.
- Paragraph granularity keeps translator context; the linter, not markup stripping, protects
  do-not-translate tokens.
- If a future provider needs richer inline-code fidelity than literal markdown-in-PO provides,
  the XLIFF export path is the escape hatch and gets its own ADR.
