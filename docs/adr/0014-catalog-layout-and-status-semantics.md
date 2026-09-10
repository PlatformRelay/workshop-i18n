# ADR 0014: One PO catalog per English source file; entries follow their unit; status gates on committed catalogs

- **Status:** proposed
- **Date:** 2026-09-10

## Context

ADR 0003 puts catalogs at `i18n/<locale>/*.po` and ADR 0004 makes gettext PO the working format,
but neither says how units are split across files. Spec 002 left that to the plan phase
("per surface or section"). GOVERNANCE.md lists the PO catalog conventions as a protected
contract, and the split is part of it: it is the path a TMS is configured against, the unit of a
merge conflict, and the thing `status` reports by.

Four constraints decide it:

- **Size and conflicts.** The Kubernetes-Workshop corpus extracts to 5 717 units per locale (1 592
  slide, 3 693 lab, 432 quiz) across 29 slide sections, 55 labs and one quiz bank. A catalog is
  the unit of a git conflict and of a TMS commit.
- **Identity is explicit and position-free (ADR 0005).** Moving a slide between files must not lose
  its translation. Any layout keyed by path must be designed so that it does not.
- **The TMS discovers catalogs by path.** Weblate's component discovery add-on matches a regular
  expression over repository paths and creates one component per distinct `component` group.
  Weblate keeps per-component state — suggestions, comments, dismissed checks, edit history — in
  its own database, keyed to the component.
- **Releases are built from committed files.** Whatever `status --policy release` certifies must be
  what a release (and `compose --strict`, spec 003 SC-003) actually reads.

### Options for the split

| Option | Files (K8s, one locale) | Moves free in git? | Weblate | Cost |
| --- | --- | --- | --- | --- |
| Per surface (`slides.po`, `labs.po`, `quiz.po`) | 3 | yes, within a surface | 3 components; moves keep TMS state | 1 600–3 700-entry files; every PR touching any lab conflicts on one file; a hand-edit error blocks a whole surface |
| Per section (S05 = its slides + lab + questions) | ~29 | within a section | ~29 components | needs a section key the manifest does not have (a protected manifest change), and mixes three surfaces with different extractors in one file |
| Per container (one per slide / lab / question) | ~400 | no | ~400 components | unusable in a TMS; path churn on every split |
| **Per source file** (mirrors the English path) | 85 | yes, via pooling (below) | one component per file | 85 components; Weblate-side state does not follow a unit that moves between files |

## Decision

### Layout

One catalog per English source file, mirroring its repository path under `i18n/<locale>/` with the
extension replaced by `.po`:

```text
pages/S05-pod/index.md   ->  i18n/<locale>/pages/S05-pod/index.po
labs/day-1/05-pod.md     ->  i18n/<locale>/labs/day-1/05-pod.po
quiz/questions.json      ->  i18n/<locale>/quiz/questions.po
```

Two sources that would map to one catalog (`a.md` and `a.json`) are refused. A catalog exists iff
it has entries (live or obsolete): a source that yields no units gets none, and a catalog emptied
by moves is deleted. The `#. workshop-i18n-source:` provenance comment is the source path without
a line number, so an edit elsewhere in a file does not rewrite provenance.

### Entries follow their unit, not the file

`extract` treats a locale's catalogs as **one logical catalog partitioned by current source
file**. Every existing entry, live or obsolete, is pooled by unit id; each source file's catalog is
built from the pooled entries its units name, wherever they lived before. Consequences, all part of
the contract:

- moving a slide to another file keeps its translation and review state — the entry moves;
- only a unit that left the English source entirely becomes obsolete (`#~`), in the catalog it
  was last in; a catalog whose source was deleted keeps its obsolete entries;
- one unit id present in two catalog files is a hard error naming both files and lines — never a
  silent pick;
- a new catalog built from moved entries inherits the header of the catalog they came from, so
  TMS-written header fields survive a rename.

The pooling is also the migration path for this decision: changing the partition function later
and running `extract` moves every entry to its new file without loss, because nothing is keyed by
path.

### No POT template tree

`extract` writes every declared target locale's catalog itself; adding a locale is a manifest edit
plus `extract`. A `.pot` tree would be one more generated tree to keep in sync and would invite the
`msgmerge` workflow this tool replaces (below).

### `status` semantics

- The unit set comes from the English source (core's `statusesForLocale`), so an absent catalog
  reports `missing` rather than nothing.
- States are read from **the catalogs `extract` would write**, not from the files on disk, so an
  English edit nobody has extracted yet already counts as `fuzzy`.
- A **gating policy** (`release`, any policy with a ceiling) additionally fails while any catalog on
  disk differs from that plan — a `stale-catalogs` violation. The plan can be more lenient than the
  committed files (a moved or resurrected entry, a removed unit still live on disk), and a release
  is built from the committed files. This keeps `status --policy release` and `compose --strict`
  answering the same question (spec 003 SC-003). `preview`, which gates nothing, is unaffected.
- Extractor coverage gaps (prose left English because it sits where the extractor cannot safely
  locate it, e.g. inside a Vue component) are counted per section in the report (`coverageGaps`),
  so a locale cannot look fully reviewed while slides silently stay English (ADR 0009). They are
  reported, not gated, in v1.

## Consequences

### Weblate configuration (spec 004 must document and verify these)

- **Component discovery**, one component per catalog file, with a match such as
  `i18n/(?P<language>[^/]+)/(?P<component>.+)\.po`, a slugified component name from the
  `component` group, file format *gettext PO file*, **no monolingual base file** and **no
  template for new translations**. Enable *remove components for inexistent files* so a renamed
  source does not leave a dead component behind.
- **Do not enable** *Update PO files to match POT (msgmerge)*: there is no POT, and `msgmerge`
  rebuilds `#.` comments and drops them on obsoleted entries (ADR 0013), fighting `extract`.
- **Customize gettext output: no line wrapping.** ADR 0013's canonical form is unwrapped; Weblate's
  default column wrapping would rewrap every entry it commits and the next `extract` would rewrap it
  back — churn in both directions on every round trip.
- **New languages are added in the manifest**, not by Weblate's *start new translation*, since no
  template exists and `extract` owns catalog creation.
- Weblate commits must not reorder entries; `extract` sorts them, so any reordering shows up as a
  one-time diff. Spec 004 verifies Weblate preserves file order.

### Accepted costs

- **85 Weblate components** for Kubernetes-Workshop. Acceptable for a two-workshop consumer base;
  if it is not, a coarser partition is a later ADR and, thanks to pooling, a one-command migration.
- **Weblate-side state does not follow a moved unit.** The translation, its flags and its review
  state live in the PO file and move with the entry. Suggestions, comments, dismissed checks and
  edit history live in Weblate's database under the old component and are lost to the new one;
  translation memory still offers the text. Moving slides between files is rare compared with
  editing them; the loss is bounded to TMS annotations, never to translations.
- **A release cannot pass on uncommitted state.** Teams must commit `extract` output before a
  release gate runs, which `extract --check` in CI already enforces.

### Not decided here

Per-locale overrides (`i18n/<locale>/overrides/`, ADR 0008) live beside the catalogs and are out
of scope; the extractor never walks `i18n/` as English source.
