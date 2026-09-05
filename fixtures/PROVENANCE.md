# Fixture provenance

## `corpus-k8s/`

Verbatim copies of section decks from **Kubernetes-Workshop**
(`PlatformRelay/kubernetes-workshop`, `pages/<section>/index.md`), pinned at commit
`b4fb2e2d2be7298e47cea8540bd51bd3cfe82c34` (2026-09-05). Copyright and licence remain
with that project; they are vendored here only as a hostile-corpus input to the
round-trip property tests (constitution III, ADR 0010).

Each file was chosen for a construct that breaks a naive locator:

| Fixture | Hostile construct it covers |
| --- | --- |
| `S00-welcome.md` | The deck's only blockquotes; a one-key frontmatter block (`showRefresher: true`) that looks like an empty slide; quoted and unquoted `heading` in one file; `columns`/`agenda` layouts |
| `S02-container-security.md` | Box-drawing tree output inside a `text` fence; two magic-move blocks; a `story:` value using YAML's doubled-single-quote escape |
| `S09-gateway-api.md` | A bare `---` document separator **inside** a fence; the `comparison` layout with all four left/right text fields; `class:` machinery |
| `S12-statefulset.md` | The worst HTML nesting: `<K8sIcon>` + `<KwCard>` + `<code>` + `&lt;ns&gt;` entities inside a `<div>` grid |
| `S13-resources.md` | Highest frontmatter density (9 blocks in 13 slides); the gnarliest highlight info string `{none\|7-9\|10-12\|8,11\|9,12}` |
| `S18-networkpolicy.md` | A four-frame magic-move whose frames repeat overlapping YAML; a 30-line speaker note full of `Key:` pseudo-fields and bullets |
| `S19-rbac.md` | A three-document YAML (`Role` / `---` / `ServiceAccount` / `---` / `RoleBinding`) inside a fence — the single best regression test for a naive `^---$` splitter |
| `S20-helm.md` | The deck's only `{{ }}` mustache interpolation, in prose (Vue evaluates it) and inside a fence |
| `S23-prometheus-operator.md` | Largest file; 23 top-level `<div>` blocks; 12 speaker notes |
| `S24-kubebuilder.md` | The degenerate opposite end: three slides, no fences, no components — a guard against a locator that only works on dense files |
| `S26-best-practices.md` | Three magic-move blocks in one file; `<CodeNote at=…>` overlays labelled with circled numerals; 8 frontmatter blocks in 14 slides |

## `adversarial/`

Hand-built cases for constructs the Kubernetes-Workshop corpus happens **not** to
contain, so that the property tests still cover them. Every one of these must round-trip
byte-identically.

| Fixture | Hostile construct it covers |
| --- | --- |
| `src-includes-and-assets.md` | `src:` frontmatter includes (absent from the real deck), image references, a slide whose frontmatter is only machinery |
| `tables-and-setext.md` | GFM tables with alignment rows, escaped `\|` in a cell and ragged rows; setext headings (spelled with `=`, since a dash underline is a slide break to Slidev); a two-space hard line break |
| `fence-mutation.md` | Tilde fences, four-tilde around three-tilde, four-backtick magic-move around three-backtick, a bare fence, an indented closing fence, a fence inside a list item, a four-space indented block |
| `containers-and-wrapping.md` | Wrapped paragraphs inside blockquotes, ordered and nested lists, a blockquote inside a list item, and a wrapped paragraph with no container at all |
| `crlf-and-bom.md` | CRLF line endings and a leading byte-order mark |
| `comments-and-notes.md` | Several HTML comments per slide, a comment inside a fence, a single-line note, note prose with `key:`-shaped lines |
| `unicode-and-interpolation.md` | Emoji including astral and ZWJ sequences, flags, box drawing, arrows, RTL text, HTML entities, `{{ }}` mustache in prose |
| `yaml-hostility.md` | Plain / single-quoted / double-quoted / literal-block / folded-block scalars, a doubled-quote escape, numeric-looking strings, and declared text keys holding a list or a number |
| `lazy-continuation.md` | CommonMark laziness: continuation lines that drop the blockquote marker or the list indentation, the shape the real deck's speaker notes use constantly |
| `scanner-shapes.md` | Shapes Slidev's scanner distinguishes and fixtures previously did not: a `---` inside a speaker note (which must not split), comments opened and closed mid-line, and a fence indented past four spaces |
| `trailing-separator.md` | A file whose last byte is a separator, which yields no extra slide (a trailing separator *plus* newline does) |
| `degenerate.md` | A file that does not open with a delimiter, an empty slide, a frontmatter-only slide, a slide with no frontmatter, and no trailing newline |

## `adversarial-rejected/`

Files that extraction must **refuse**, each with the diagnostic it must raise. They exist
so that "unsupported" stays a tested behaviour rather than a silent mangle; composition
must still reproduce them byte-for-byte.

| Fixture | Diagnostic |
| --- | --- |
| `duplicate-slide-id.md` | `duplicate-slide-id` |
| `malformed-frontmatter.md` | `malformed-frontmatter` |
| `missing-slide-id.md` | `missing-slide-id` |
| `separator-in-tilde-fence.md` | `separator-in-tilde-fence` — Slidev tracks backtick fences only, so it splits the slide inside this code block; agreeing silently would leave the second rendered slide with no identity while `--check` passed |
| `dash-run-opens-no-block.md` | `missing-slide-id` — a `----` separator splits the slide but opens no frontmatter block, so `init-ids` has nowhere to write an identity and refuses rather than emitting YAML the renderer shows as prose |
| `phantom-frontmatter.md` | `phantom-frontmatter` — the slide opens no block, but its text begins with `---` and Slidev's lazy frontmatter regex closes on a later dash run hidden inside a speaker note, swallowing the whole slide |
| `unclosed-frontmatter.md` | `unclosed-frontmatter` |
| `unsafe-slide-id.md` | `unsafe-slide-id` |

## `corpus-k8s-labs/`

Verbatim copies of lab files from **Kubernetes-Workshop**
(`PlatformRelay/kubernetes-workshop`, `labs/day-N/NN-topic.md`), pinned at commit
`b4fb2e2d2be7298e47cea8540bd51bd3cfe82c34` (2026-09-05). Copyright and licence remain
with that project; they are vendored here only as a hostile-corpus input to the
round-trip property tests (constitution III, ADR 0010). The `day-N-` prefix in each file
name is the source directory, flattened.

Labs are plain Markdown — no Slidev separators, no frontmatter — but they carry the
protected content that must survive byte-identically: heredoc'd YAML manifests, `kubectl`
one-liners, API kinds, image references, and the `<details>` spoilers the consumer's
ADR 0012 (sibling lab solutions) makes the shape of every answer.

| Fixture | Hostile construct it covers |
| --- | --- |
| `day-1-00-setup.md` | 13 `<details>` spoilers in a *participant* file (the rest of the corpus keeps them in the companion); 46 fences; four-space indented blocks |
| `day-1-02-container-security.md` | Footnote references, an empty blockquote line, six heredocs, `$ENGINE`-style shell variables in prose |
| `day-1-02-container-security.solution.md` | The most `<details>` blocks of any file (15); footnotes inside a companion |
| `day-1-08-ingress.md` | Three bare `---` document separators **inside** a heredoc'd manifest — the single best regression test against a naive `^---$` splitter; 16 blockquotes |
| `day-2-09-gateway-api.md` | Seven heredocs, 38 list items, a `<details>` and three in-fence `---`s in one participant file |
| `day-2-12-statefulset.solution.md` | The heaviest inline HTML (71 tags): `<code>`, `&lt;ns&gt;` entities, nested spoilers |
| `day-2-14-probes.solution.md` | 48 fences and 13 spoilers in one file; eight distinct non-ASCII glyphs |
| `day-3-18-networkpolicy.md` | Four `---` separators inside heredocs (the maximum in the corpus) |
| `day-3-19-rbac.solution.md` | A 206-character `kubectl` one-liner; a three-document `Role`/`ServiceAccount`/`RoleBinding` heredoc |
| `day-3-21-gitops-flux.solution.md` | A 202-character line; ordered lists, which the rest of the corpus barely uses |
| `day-3-24-kubebuilder.md` | The degenerate opposite end: a 688-byte deferred stub, no fences, and a multi-line HTML comment holding real authoring prose (a genuine coverage gap the locator must *report*) |
| `day-3-25-pod-escape.md` | 57 blockquotes — the densest container nesting in the corpus |
| `day-3-26-capstone.md` | Circled numerals (`①`–`⑩`), 43 blockquotes, 43 list items, 24 table rows, seven heredocs |
| `labs-README.md` | A file in the labs tree that is **not** a lab: no `# Lab NN` title, no metadata table, mostly links and nested lists — a guard against a locator that only works on the shape it was written for |

## `adversarial-labs/`

Hand-built cases for constructs the Kubernetes-Workshop lab corpus happens **not** to
contain, so that the property tests still cover them. Every one of these must round-trip
byte-identically.

| Fixture | Hostile construct it covers |
| --- | --- |
| `fence-mutation.md` | Tilde fences, four-tilde around three-tilde, four-backtick around three-backtick, a bare fence, an indented fence, a fence inside a list item, a four-space indented block, and an unclosed fence at end of file |
| `tables-and-setext.md` | GFM tables with alignment rows, an escaped `\|` in a cell, ragged and over-wide rows; setext headings spelled with `=` and with `-`; a two-space hard break; a backslash hard break; significant trailing whitespace |
| `containers-and-lazy.md` | CommonMark laziness — continuation lines that drop the blockquote marker or the list indentation — plus ordered lists, an empty quote line, and a blockquote nested inside a list item |
| `crlf-and-bom.md` | CRLF line endings and a leading byte-order mark. Deliberately the one fixture **left un-adopted** — it carries no `labId` marker — so the corpus suite runs `init-ids` on a BOM file for real. **This fixture found two bugs of one class**: micromark's preprocessor drops a leading U+FEFF, so every offset in a BOM file was one code unit short; and `init-ids` wrote a marker there it could not read back, making the codemod non-idempotent. Both are invisible to a losslessness assertion, because untranslated holes copy the original bytes either way — and the second one hid until the marker was taken out of this file, because an already-adopted fixture never exercises insertion |
| `spoilers-and-html.md` | `<details>`/`<summary>` in every shape the corpus uses and two it does not: a summary on its own line, an empty summary, inline `<code>` and entities inside a summary, a `<div>` holding trapped prose, and an un-fenced `<placeholder>` in prose |
| `unicode-and-entities.md` | Astral emoji, a flag, a ZWJ sequence, an emoji with a skin-tone modifier, RTL scripts, combining marks (precomposed *and* decomposed), a zero-width space, a non-breaking space, HTML entities, box arrows, and `{{ }}` mustache in prose |
| `degenerate.md` | An empty ATX heading, a whitespace-only heading, all three thematic-break spellings, a link reference definition, an image-only paragraph, an inline-code-only paragraph, an empty comment, and no trailing newline |

## `adversarial-labs-rejected/`

Files that extraction must **refuse**, each with the diagnostic it must raise. They exist
so that "unsupported" stays a tested behaviour rather than a silent mangle; composition
must still reproduce them byte-for-byte, because refusing is not mangling.

| Fixture | Diagnostic |
| --- | --- |
| `missing-lab-id.md` | `missing-lab-id` — inventing an identity from the path or the position is exactly what constitution II forbids, so the fix is `init-ids`, not a fallback |
| `unsafe-lab-id.md` | `unsafe-lab-id` — the id becomes an override file name and a PO `msgctxt` |
| `duplicate-lab-id.md` | `duplicate-lab-id` — two markers in one file make its identity ambiguous; taking the first one silently would attach a lab's translations to whichever marker happened to be read first |

## `corpus-quiz/`

Verbatim copies of both consumer question banks, vendored as the golden corpora for the
quiz extractor:

| Fixture | Source | Pinned commit |
| --- | --- | --- |
| `kubernetes-workshop.questions.json` | `PlatformRelay/kubernetes-workshop`, `quiz/questions.json` (54 questions, 27 sections) | `b4fb2e2d2be7298e47cea8540bd51bd3cfe82c34` |
| `opentofu-workshop.questions.json` | `PlatformRelay/opentofu-workshop`, `quiz/questions.json` (69 questions) | `591e258b0b7f306bd536fe9a4e5824a75253bc23` |

The two are the reason extraction splices offsets instead of re-serializing. Their JSON
Schemas are identical apart from `$id`, but their **formatting** is not: the Kubernetes
bank writes each option as a single-line object and contains no string escapes at all,
while the OpenTofu bank pretty-prints options across four lines and carries 52 `\"`
escapes. A `JSON.parse` → mutate → `JSON.stringify` round-trip would rewrite each one
into the other's shape and produce a diff on every line of a file where nothing was
translated.

## `adversarial-quiz/` and `adversarial-quiz-rejected/`

Hand-built banks for JSON shapes neither consumer writes today, and banks the extractor
must refuse. See `packages/extract-quiz/test/corpus.test.ts` for what each one proves.
