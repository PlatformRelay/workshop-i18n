# ADR 0010: Every supported story is covered at multiple test layers against golden corpora

- **Status:** proposed
- **Date:** 2026-08-15

## Context

The parser and composer are the riskiest components: they must round-trip real Slidev syntax —
multiple frontmatter blocks, Vue islands, magic-move code blocks, HTML-comment speaker notes —
losslessly. "It parses the happy path" is how localization tools corrupt decks. The origin pack's
story-driven, multi-layer test discipline is its best process idea and survives the runtime cut.

## Decision

- Every supported user story (author, translator, reviewer, facilitator) maps to tests at **at
  least two layers**: unit/property tests in the owning package and an end-to-end CLI test over a
  golden fixture.
- `fixtures/` holds a **hostile corpus** sampled from both consumer workshops — every syntax
  construct either workshop uses, plus adversarial cases — and golden expected outputs.
- **Round-trip properties** run as property-based tests: extract→compose over the English catalog
  is semantically lossless; fences and Vue islands are byte-preserved; unit identities are stable
  under content edits, file moves, and slide reordering.
- The TMS port contract is exercised by the conformance kit against the in-repo fake (ADR 0006);
  "story × live provider" matrices are explicitly out.
- CI runs a **reverse-dependency contract job**: the current tool against pinned corpora from both
  workshops, so a divergence in either consumer's conventions fails here, not in their CI.

## Consequences

- Fixtures are the spec: a bug report becomes a failing fixture before it becomes a fix.
- Parser changes are cheap to review (golden diffs) and hard to regress.
- Test scope is bounded — dropping the live-provider matrix is what makes the rest affordable.
