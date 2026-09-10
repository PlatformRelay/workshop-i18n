# @workshop-i18n/compose

Locale composition and its gates (spec 003; ADRs 0007, 0009, 0012). A pure library: no
file system, no network, no content execution. The `workshop-i18n` CLI reads the working
tree, calls this package, and writes the generated tree.

## Compose a locale

```ts
import { composeLocale } from '@workshop-i18n/compose'

const result = composeLocale({
  manifest,                 // parseManifest(...) from @workshop-i18n/core
  locale: 'de',             // a manifest target
  files,                    // [{ path, surface, text, section? }] — English, ids already in place
  catalogs,                 // parseCatalog(...) for every catalog of 'de'
  mode: 'preview',          // or 'strict' (release)
})
// result.files     → [{ path, surface, text }] at the English relative paths
// result.units     → per-unit report: state, rendering, marked, reasons
// result.findings  → machine-readable errors and warnings, sorted
// result.policy    → core's PolicyEvaluation (`release` in strict mode)
// result.releasable
```

| catalog state       | `preview`                          | `strict`                   |
| ------------------- | ---------------------------------- | -------------------------- |
| reviewed            | translation, if it passes the gates | translation; gate failure = error |
| needs-review        | translation, unmarked              | error                      |
| fuzzy, or stale     | English with the fallback marker   | error                      |
| missing             | English with the fallback marker   | error                      |

A *stale* entry is one whose `msgid` is not the English the source holds now; it is
treated as `fuzzy`. Strict mode decides blocking units with core's `evaluatePolicy`
(`release`) over `statusesForLocale`, the same functions `status --policy release` uses.
**Strict composition with any error returns no files.** A needs-review draft passes
through the same content gates as a reviewed translation: in preview, a draft with
hostile markup falls back to marked English like any other.

### Stale entries and SC-003

Compose is **deliberately stricter than a state-only catalog read**. A `reviewed` entry
whose `msgid` has drifted from the current English is `reviewed` to `catalogStatuses`, and
`fuzzy` to compose, which refuses to ship a translation of words the source no longer
contains. Spec 003 SC-003 ("strict compose never fails on a locale that passes
`status --policy release`") is guaranteed by the **pipeline**, not by the two libraries
agreeing on a raw catalog: `extract` marks changed-source entries fuzzy, and `status`
reports against that. A caller that feeds compose a catalog `extract` has not updated gets
the stricter answer, on purpose.

### The fallback marker

Preview fallback units render as their English text prefixed with `⚠ EN: `
(`FALLBACK_MARKER`), inside the unit's own hole. It is plain text, so it is valid in every
hole encoding — markdown prose, YAML frontmatter scalars, JSON quiz strings, `<summary>`
labels — needs no CSS or component in the consumer's deck, and leaves the protected
skeleton byte-identical. `marker.ts` records the alternatives and why they lost. A unit
the marker cannot be placed on (in the corpus: only a quiz string whose English carries a
control character, which no replacement may touch) renders unmarked with a
`marker-omitted` warning.

### Generated-file notice (FR-002)

An in-file "generated — do not edit" banner is not possible without breaking what the
tree is for: a Slidev file must start with its frontmatter, a quiz bank is JSON (no
comments), and any byte outside a hole fails the skeleton gate. `GENERATED_NOTICE` is
therefore exported for the CLI to write *beside* the tree (outside the globs the deck and
labs load), and `verifyComposedFile` is what makes hand edits fail.

## The gates

All usable on their own; `composeLocale` runs them on every translation before emitting it
and again on the emitted output.

- **Skeleton identity** — `compareSkeletons(english, locateFile(surface, composed))`
  re-locates the *output* with the same extractor and requires the same holes and
  byte-identical bytes between them: fences, frontmatter machinery, Vue islands, includes.
- **Markup and placeholder parity** — `checkMarkupParity(english, translation)`.
  Translations are untrusted; a translation that fails is never emitted (preview:
  English fallback + warning; strict: error). Two layers:

  1. **The barrier — coarse and renderer-independent.** A translation may not
     *introduce*, beyond what its English unit has (as a multiset):
     - `linklike` — dotted host-like runs (`evil.com`, `пример.рф`, `xn--…`; digits-only
       decimals such as `1.5` exempt), an `@` touching a word (emails, `@user`), `://`,
       `mailto:`, a GitHub issue reference `#123`, or a bracket label that is not
       inline-link text (`[admin]`, which resolves against any reference definition in
       the file);
     - `syntax` — `$` (KaTeX), `^[` and `[^` (footnotes), `]:` (definitions);
     - `format` — any Unicode format character (Cf: zero-width and bidi controls,
       U+FEFF, U+00AD, …).

     Dropping these is allowed — a translation that leaves out an English `e.g.` creates
     nothing. A translation longer than `max(8192, 4 × English)` is refused before any
     parser runs.
  2. **Exact tokens, two-way:** inline code spans, HTML tags and Vue components
     (attributes included), `{{ }}` expressions, attribute braces, character references
     and URL tokens must match the English as multisets. URL tokens are inline and
     autolink destinations, a `linkify-it` pass over the unescaped text, and — for text
     up to 8192 characters — every `href`/`src` a **model** of the renderer creates:
     markdown-it 14.3.0 configured as `@slidev/cli` 52.19 configures its slide renderer
     (`html`, `xhtmlOut`, `linkify`, Slidev's quotes) with `markdown-it-footnote` 4.0.0
     and Slidev's KaTeX `math_inline` rule. The model only ever adds tokens; the barrier
     does not depend on it.

  A differential test checks both layers against markdown-exit 1.0.0-beta.9 (the engine
  Slidev 52 actually renders slides with, via `unplugin-vue-markdown` 32) and markdown-it
  14.3.0, each with the same two plugins: over a matrix of link forms × inline contexts
  (emphasis, strikethrough, footnotes, inline math, escapes, entities, links, images,
  code spans, U+FEFF) plus both re-reviews' bypass lists, every link either engine
  creates is counted *and* trips the coarse layer on its own.

  **Measured false-positive cost.** On the 1 399 real pt-BR translations the seed lane
  aligns from Kubernetes-Workshop PR #55, the coarse layer rejects **no** translation
  the gate did not already reject (11 before and after: 9 changed code spans, 2 added
  character references). Judged two-way it would have rejected 18 more, all for a
  *dropped* `e.g.`, `i.e.`, `a.m.`, `#1` or dotted identifier — which is why it is
  introduction-only.
- **Protected terms** — `missingProtectedTerms(english, translation, manifest.protectedTerms)`:
  every term the English uses must appear unaltered (case-sensitive, whole-word).
- **Length budget** — slides only, `lengthBudgetFor(manifest, layout)` against the code
  point ratio; always a warning.

`verifyComposedFile({ manifest, path, surface, english, composed, mode })` runs all of
them on a composed file it did not produce — what `workshop-i18n verify` needs.

## Known gaps

Stated so nobody mistakes the gates for more than they are.

- **Inline-tag attributes are frozen.** A tag's full text, attributes included, is a
  parity token, so a translation cannot change `<abbr title="…">` or an inline `<img
  alt="…">`: the unit falls back to English with a `markup-parity` warning. That is the
  price of catching `onclick=` added to an existing tag; move translatable attribute text
  into prose, or accept English there.
- **Reference labels are compared, coarsely.** A bracket label the English lacks
  (`[admin]`, `[text][admin]`) is refused, because it would resolve against any
  definition in the file. Changing a *full* reference's link text is allowed; re-pointing
  it to another existing label is refused as a changed label.
- **needs-review renders unmarked in preview.** That follows core's contract (a draft is
  not a gap) but means a preview deck can *look* finished while carrying drafts no human
  accepted. Reviewers must read `units[].state`, not the rendered deck; only strict output
  is releasable.
- **What the renderer model covers — and why it is not the barrier.** The model follows
  `@slidev/cli` 52.19's slide renderer: its markdown options plus the two plugins that
  change where text tokens split, `markdown-it-footnote` (always on) and KaTeX
  `math_inline` (on whenever a deck uses `$…$`). Slidev's other plugins are not modelled:
  Shiki and the code-block transformers, `MarkdownItLink` (turns existing links with
  `./`, `/`, `#` or digit-only targets into router links and adds `target="_blank"` to
  the rest — it creates none), task lists, GitHub alerts, v-drag, slot sugar, scoped
  styles, and MDC/Comark (opt-in via `mdc`/`comark`; its `{…}` attribute blocks are
  caught as `brace` tokens). Speaker notes are rendered separately, by Slidev's own
  markdown-exit 1.1.0-beta.2 with `html` on and `linkify` off. A consumer
  `markdownSetup` can add anything. None of this weakens the barrier, which assumes no
  renderer; it bounds only which links are also counted by their exact `href`.
- **Labs are rendered by GitHub, not Slidev.** GitHub's GFM adds extended autolinks,
  `#123` issue references, `@user` mentions and commit-SHA links. The coarse layer
  refuses introduced hosts, `@`-words and `#123`; a bare hexadecimal commit SHA a
  translation introduces is **not** caught.
- **Versions move in lockstep with the consumer's renderer.** `markdown-it` 14.3.0,
  `markdown-it-footnote` 4.0.0, `linkify-it` 5.0.2 (with `uc.micro` 2.1.0) and the
  test-only `markdown-exit` 1.0.0-beta.9 are pinned exactly to what the consumer's
  lockfile resolves. A Renovate bump of any of them — or of the consumer's `@slidev/cli`,
  `unplugin-vue-markdown` or `markdown-exit` — must move both sides together, with the
  differential test rerun against the new engine. A drifted model only loses exact
  `href` tokens; the barrier still holds.
- **Length budgets** cover slides only, and a layout with no configured budget gets the
  manifest default rather than an "uncovered" report.

## Deferred: governed slide overrides

**Deferred 2026-09-10 by operator-loop decision** (this lane shipped composition and gates
first). ADR 0008 / spec 003 User Story 2 — `i18n/<locale>/overrides/<slideId>.md`
replacement and split slides, `sourceSlideHash` anchoring and wholesale invalidation,
minted fragment ids, override staleness in `status` and `--strict`, and the override
fence gate (US2 AS-3) — is **not implemented**. The input has no field for an override, so
nothing can be silently ignored: a consumer cannot believe one was applied. When it lands,
an override replaces a whole slide's range before splicing (ADR 0012 keeps it outside the
hole mechanism) and must pass the same fence gate against the English slide it replaces.
