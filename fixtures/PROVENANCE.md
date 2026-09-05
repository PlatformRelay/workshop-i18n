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
| `tables-and-setext.md` | GFM tables with alignment rows, escaped `\|` in a cell and ragged rows; setext headings; a two-space hard line break |
| `fence-mutation.md` | Tilde fences, four-tilde around three-tilde, four-backtick magic-move around three-backtick, a bare fence, an indented closing fence, a fence inside a list item, a four-space indented block |
| `containers-and-wrapping.md` | Wrapped paragraphs inside blockquotes, ordered and nested lists, a blockquote inside a list item, and a wrapped paragraph with no container at all |
| `crlf-and-bom.md` | CRLF line endings and a leading byte-order mark |
| `comments-and-notes.md` | Several HTML comments per slide, a comment inside a fence, a single-line note, note prose with `key:`-shaped lines |
| `unicode-and-interpolation.md` | Emoji including astral and ZWJ sequences, flags, box drawing, arrows, RTL text, HTML entities, `{{ }}` mustache in prose |
| `yaml-hostility.md` | Plain / single-quoted / double-quoted / literal-block / folded-block scalars, a doubled-quote escape, numeric-looking strings, and declared text keys holding a list or a number |
| `lazy-continuation.md` | CommonMark laziness: continuation lines that drop the blockquote marker or the list indentation, the shape the real deck's speaker notes use constantly |
| `degenerate.md` | A file that does not open with a delimiter, an empty slide, a frontmatter-only slide, a slide with no frontmatter, and no trailing newline |

## `adversarial-rejected/`

Files that extraction must **refuse**, each with the diagnostic it must raise. They exist
so that "unsupported" stays a tested behaviour rather than a silent mangle; composition
must still reproduce them byte-for-byte.
