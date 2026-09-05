# ADR 0011: Implement in TypeScript on the Slidev/unified ecosystem

- **Status:** proposed
- **Date:** 2026-08-15

## Context

The portfolio's house style for tools is Go (kollect). But the highest-risk component here is
lossless Slidev parsing, and the only maintained Slidev parser (`@slidev/parser`, used by Slidev's
own editor) plus the mature markdown AST ecosystem (unified/remark/mdast) are npm packages. Both
consumer workshops are pnpm/TypeScript projects whose contributors are Slidev/frontend people, and
the compose→build verification step runs Slidev itself — a Node toolchain is present in every
consumer regardless.

## Decision

TypeScript (Node ≥ 22, pnpm workspace), published to npm. Weighted trade-off (1–5 per criterion):

| Criterion | Weight | TS/Node | Go | Rust |
| --- | ---: | ---: | ---: | ---: |
| Slidev/markdown parsing fit (`@slidev/parser`, unified/remark are npm) | 30 | 5 | 1 | 1 |
| Localization-format libraries (gettext, XLIFF) | 15 | 4 | 3 | 3 |
| Team familiarity (workshops are pnpm/TS; kollect house style is Go) | 15 | 4 | 4 | 1 |
| Consumer integration (`pnpm dlx`; render step is Node anyway) | 10 | 5 | 2 | 2 |
| Contributor accessibility (Slidev/frontend contributor pool) | 10 | 5 | 3 | 2 |
| Distribution/ops (single static binary) | 10 | 2 | 5 | 5 |
| Long-term maintainability / type safety | 5 | 4 | 4 | 5 |
| Performance | 5 | 3 | 4 | 5 |
| **Weighted total** | 100 | **4.30** | 2.85 | 2.30 |

The decisive row is the first: a Go/Rust implementation would re-implement Slidev's
multi-frontmatter/Vue-island parsing from scratch — precisely the component we least want to own.
Go's distribution advantage is moot when every consumer already runs Node.

## Consequences

- Borrow kollect's repo *hygiene* (governance, security posture, ADR discipline, CI gates), not
  its language.
- Strict compiler settings and property-based tests compensate for the weaker type system vs Rust.
- If a non-Node consumer ever appears, the CLI boundary (not a library API) is the compatibility
  surface.

## Amendment 2026-09-05: we own the Slidev slide split after all

The decisive row of the table above — "a Go/Rust implementation would re-implement Slidev's
multi-frontmatter/Vue-island parsing from scratch — precisely the component we least want to own"
— is now only half true, and the honest record should say so.

Spec 001's extractor does **not** use `@slidev/parser` at runtime. Slide splitting is a
~120-line line scan in `packages/extract-slidev/src/deck.ts`. Two reasons, both discovered while
implementing:

- ADR 0012 needs byte offsets into the original file for every slide, frontmatter block and
  prose span. `@slidev/parser` reports line indices over a line-ending-normalized copy, so its
  output cannot anchor a byte-exact splice without re-deriving the offsets anyway.
- It costs ~390 transitive packages, against four runtime dependencies and 82 lockfile entries
  for the whole package as built.

That trade is defensible only with evidence that the hand-rolled split agrees with the renderer,
because a splitter that disagrees keys prose under a slide the audience never sees while
`init-ids --check` still passes. The evidence is a differential test
(`slidev-parser-differential.test.ts`) that resolves an already-installed `@slidev/parser` from
outside this repo and compares slide count, body text, speaker-note text and frontmatter presence
over the whole fixture corpus, skipping when the parser is absent. It found two real divergences
that the corpus round-trip could not (tilde fences, and dash runs longer than three); both are
fixed, and the scan now agrees with `@slidev/parser` 52.19.0 on 29 real consumer pages / 290
slides with zero disagreements.

The rest of the decision stands unchanged: prose location still rests on the mdast ecosystem,
and the compose→build verification step still runs Slidev itself.
