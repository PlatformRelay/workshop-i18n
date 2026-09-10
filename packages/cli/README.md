# @workshop-i18n/cli

The `workshop-i18n` command: adopt explicit content identities, extract English into gettext PO
catalogs, and report translation state for CI. Stateless and offline — every command is a
deterministic function of the working tree (constitution IV); it never executes content and never
touches the network.

```text
workshop-i18n init-ids [--check]
workshop-i18n extract  [--check]
workshop-i18n status   [--json] [--policy release|preview] [--locale <tag>]
```

Every command takes `--root <dir>` (default: the working directory) and reads
`<root>/.localization/workshop.yaml`.

## Manifest

```yaml
apiVersion: workshop-i18n/v1
locales:
  source: en
  targets: [pt-BR]
surfaces:
  slides:
    include: ['pages/**/index.md']
  labs:
    include: ['labs/**/*.md']
  quiz:
    include: ['quiz/questions.json']
    schema: kubernetes-workshop
```

Globs are repository-relative and support `*`, `?`, `**` (whole segments) and `{a,b}` (which may
nest, up to 64 alternatives); every other character is literal. A wildcard never matches a leading
`.` — name a dot-path literally, e.g. `{.github,docs}/*.md`. Unbalanced braces, `./` and `..`
segments are refused. Matching is linear in the pattern and path — no regular expression, so a
hostile glob in a pull request cannot stall CI. The walk starts at each glob's literal
base, never follows a symlink (a symlinked source is skipped with a warning; a symlinked glob base,
catalog or `i18n/` directory is an error), and never enters `.git/`, `node_modules/`, or the tool's
own `i18n/` and `.localization/` trees — so a broad `**/*.md` cannot extract a locale's overrides
as English, and an include glob based inside either tree (`i18n/**/*.md`) is refused outright. A glob that matches nothing is warned about; a file two surfaces both claim is an error.

## Commands

### `init-ids`

Inserts the identities ADR 0005 requires and changes no other byte: a `slideId:` frontmatter line
per slide (plus the `---` delimiters for a slide that has no block) and a `<!-- labId: … -->` marker
under each lab's title. Proposals are derived once — section + heading for slides
(`pages/S05-pod/index.md` → `s05-pod-…`), the path below the glob base for labs
(`labs/day-1/05-pod.md` → `day-1-05-pod`) — and are unique across the corpus. A second run is a
no-op. Quiz question ids are authored by the consumer's own schema, so the quiz is checked, never
written.

All files are read before any is written; an unreadable file aborts with the tree untouched. A file
the planner cannot adopt safely (an unclosed frontmatter block, a separator Slidev would misread)
is left byte-for-byte as it was and reported, while every other file is adopted, and the run exits 1.

`--check` writes nothing and exits 1 naming every missing, duplicate (across files, and across quiz
banks) and unsafe id with its file and line. Run it in CI.

### `extract`

Extracts every surface and updates the catalogs of every target locale. Nothing is written until
the whole corpus has extracted cleanly and every existing catalog has parsed; every extractor error
is listed in one run. Extractor coverage warnings (prose left English inside an HTML block, …) are
printed to stderr with their location.

Update rules (spec 002): an entry whose English did not change is untouched, translator comments
and unknown flags included; an English edit makes exactly that entry `fuzzy` with `#| msgid`; a unit
that left the English source becomes an obsolete `#~` entry; a new unit enters as untranslated.
A no-change run writes nothing and is byte-identical. Units that were added *and* obsoleted within
one container in the same run are reported as re-keyed — the residue ADR 0005's amendment names —
so the loss is visible in review.

`--check` writes nothing and exits 1 when any catalog is out of date with the English source.

### `status`

Tallies every declared locale by section and state (`missing`, `fuzzy`, `needs-review`,
`reviewed`), human-readable or `--json`. A section is an English source file. The unit set comes
from the English source, so a locale with no catalogs reports everything `missing`. States are read
from the catalogs `extract` *would* write: an English edit nobody has extracted yet already counts
as `fuzzy`, and a warning plus `"catalogsCurrent": false` say the files on disk are stale.

`--policy release` fails (exit 1) on any missing, fuzzy or needs-review unit and lists every gating
unit id with its section. It also fails while the committed catalogs differ from what `extract`
would write (a `stale-catalogs` violation): a release is built from the committed files, and the
plan can be more lenient than they are. `--policy preview` gates nothing, stale or not.
`--locale` narrows the report — and which catalogs are read — to one declared target. A catalog
directory for a locale the manifest does not declare is warned about and excluded.

The `--json` document (`schemaVersion: 1`) has a fixed key order and is byte-identical across runs:

```json
{
  "schemaVersion": 1,
  "sourceLocale": "en",
  "catalogsCurrent": true,
  "total": 5,
  "totals": { "missing": 3, "fuzzy": 0, "needs-review": 0, "reviewed": 2 },
  "locales": [
    {
      "locale": "pt-BR",
      "total": 5,
      "counts": { "missing": 3, "fuzzy": 0, "needs-review": 0, "reviewed": 2 },
      "sections": [
        { "section": "labs/day-1/05-pod.md", "total": 2, "counts": { "missing": 0, "fuzzy": 0, "needs-review": 0, "reviewed": 2 } }
      ]
    }
  ],
  "policy": null
}
```

With `--policy`, `policy` is `{ "name", "satisfied", "violations": [{ "kind": "state", "locale",
"state", "limit", "count", "units": [{ "id", "section" }] }] }`, plus
`{ "kind": "stale-catalogs", "catalogs": [paths] }` when the committed catalogs are behind. Treat an
unknown `kind` as a violation.

## Catalog layout

**One catalog per English source file**, mirroring its path under `i18n/<locale>/` with the
extension replaced by `.po`:

```text
pages/S05-pod/index.md   ->  i18n/pt-BR/pages/S05-pod/index.po
labs/day-1/05-pod.md     ->  i18n/pt-BR/labs/day-1/05-pod.po
quiz/questions.json      ->  i18n/pt-BR/quiz/questions.po
```

Spec 002 left per-surface vs per-section splitting open. Per file was chosen because it is bounded
(one section or one lab — never a multi-thousand-entry `slides.po` that every PR conflicts on), it
invents no naming scheme beyond the path the author already chose, and a TMS component maps onto it
with one file mask per surface (for example `i18n/*/pages/**/index.po` in Weblate). Two sources that
would share one catalog (`a.md` and `a.json`) are refused. No `.pot` template tree is written: every
target locale's catalog is created by `extract` itself, and a template would be one more generated
tree to keep in sync; adding a locale is a manifest edit followed by `extract`.

**Entries follow their unit, not the file.** A path-keyed layout would orphan translations whenever
a slide moves to another file, which ADR 0005 promises is free. So a locale's catalogs are treated
as one logical catalog partitioned by current source file: existing entries are pooled by unit id
and each source file's catalog takes the entries its units name, wherever they lived before. Only a
unit that left the English source becomes obsolete, in the catalog it was last in. A catalog left
with no entries — every unit moved away, as on a file rename — is removed. The same unit id in two
catalogs is a hard error naming both files and lines. The `#.` source reference is the file path
(not a line number), so an edit elsewhere in a file does not rewrite provenance comments.

### Merge conflicts in catalogs

Entries are sorted by unit id and each catalog covers one source file, so two branches conflict
only where they touched the same entries. A catalog still carrying conflict markers is refused
(exit 65, naming the first marker's line) and never rewritten. Resolve it by hand — for each
conflicted entry keep one side's `msgid`, `msgstr` and flags together, delete the markers — then
run `workshop-i18n extract`: it re-canonicalizes the file and marks every entry whose `msgid` no
longer matches the English `fuzzy`, with the kept `msgid` as `#| msgid`. Keeping a side whole is
what makes that check work; mixing one side's `msgid` with the other side's `msgstr` defeats it.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success; the gate, if any, passed. |
| 1 | The command ran and its gate failed (`--check` findings, a failed `--policy`). |
| 64 | Usage: unknown command or option, unknown policy, undeclared `--locale`. |
| 65 | Input that cannot be processed: invalid manifest, extraction errors, broken PO syntax (with file and line), a path escaping the root, a symlink where a file must be. |
| 66 | No manifest at `.localization/workshop.yaml`. |
| 70 | Internal error — a bug in workshop-i18n. |
| 74 | The file system refused a read or write. |

## As a library

`run(argv, io)` is the whole command line as a pure function over an injected file system and
output streams; `bin.ts` binds it to the real process. The package has no third-party runtime
dependency.
