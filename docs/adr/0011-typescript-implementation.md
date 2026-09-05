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
outside this repo, skipping when it is absent.

**What that evidence does and does not cover**, because "zero disagreements" was claimed once
already on a weaker basis and was wrong twice over:

- It covers slide count, body text, speaker-note text and frontmatter presence over the vendored
  corpus *and* over a table of minimal files, one per branch and boundary of Slidev's scanner,
  written by reading `dist/core.mjs` rather than by observing behaviour. Fixtures are real content
  and therefore accidental about which branches they reach; two divergences (HTML-comment state,
  the `line[3] !== "-"` guard) lived for two review rounds in shapes no fixture contained.
- It compares **slide boundaries**, which is what Slidev's scanner decides and what identities
  are attached to. Slidev's *second* layer, `matter()`, re-reads each slice with two hand-rolled
  regexes — `RE_FRONTMATTER = /^---.*\r?\n([\s\S]*?)---/` and `RE_YAML_CODEBLOCK =
  /^\s*```ya?ml([\s\S]*?)```/` — and can disagree with the scanner, reading `k: v` out of an
  indented fence as frontmatter the scanner never opened. Where the two Slidev layers disagree,
  only the boundary is compared, and the exemption asserts the ```yaml form is why.

  Both directions of that disagreement are now refused rather than merely bounded. As well
  as `matter()` finding a block in a ```yaml fence, `RE_FRONTMATTER` can find one on a
  slide the scanner opened *no* block for: when `slice()` emits nothing and the next line
  is blank, Slidev leaves `start` on the separator, so the slide's raw begins `---` and the
  regex closes on any later dash run — one hidden inside a speaker note or a fence, where
  the scanner could not see it. Measured: the renderer showed `-->` and nothing else, the
  entire slide gone, with no diagnostic. That is `phantom-frontmatter`.

  That second layer is not a curiosity: four defects lived in it. `RE_FRONTMATTER` is lazy and
  its close is not line-anchored, so the first `---` *anywhere* after the opener ends the block —
  an em dash typed as `---` in a `story` value truncates the frontmatter and renders `slideId:`
  to the audience. And `RE_YAML_CODEBLOCK` makes a leading ```yaml fence a legitimate frontmatter
  form, which `init-ids` would have silently demoted to content. Both are now refused at the door.
  An earlier version of this amendment attributed the layer to gray-matter; Slidev 52.19.0 does
  not depend on gray-matter at all, and that mistake is what kept the layer out of scope.
- It does **not** run in CI today: the parser is resolved from an environment variable that CI does
  not set, so the comparison is developer-local unless a workflow provides it.
- It does **not** cover `@slidev/parser/fs`, which resolves `src:` includes. A deck that composes
  slides from other files renders content this package never sees unless those files are declared
  surfaces of their own.
- It covers slide *boundaries and frontmatter*, and nothing below them. The prose locator — mdast
  against Slidev's markdown-it — has no differential at all, and is the largest untested contract
  in the package: a msgid may carry `<span class="kw-kicker">…</span>` or `{{ .Values.x }}`, and a
  translation dropping either composes cleanly with no guard and no report.

The comparison also runs over **composed output**, not only over extraction input: composing every
unit with hostile translator text must leave Slidev's view of the deck — slide count, frontmatter
keys, identities — unchanged, or composition must refuse. Checking only the input side is what let
`skeleton.ts` keep CommonMark's fence and separator rules while `deck.ts` used Slidev's; the two
disagreed about indented fences and about `--- x`, and each disagreement was a translated deck
that splits differently from the English one. There is now one definition of each predicate,
exported from the transcription and used by composition.

With those bounds stated, the scan agrees with `@slidev/parser` 52.19.0 on 29 real consumer pages
/ 290 slides and on every scanner shape, with zero disagreements.

The rest of the decision stands unchanged: prose location still rests on the mdast ecosystem,
and the compose→build verification step still runs Slidev itself.
