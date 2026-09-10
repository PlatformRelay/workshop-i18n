# ADR 0015: Prose inside HTML blocks and components is located, and text props are declared

- **Status:** proposed
- **Date:** 2026-09-10

## Context

Running `extract` over the real Kubernetes-Workshop deck (29 sections, identities planned in
memory) found two problems the vendored corpus had been passing over.

1. **Slidev slot markers were units.** `::notes::` (35 lines) and `::right::` (14) are Slidev's
   slot sugar — `@slidev/cli` turns `/^::\s*([\w.\-:]+)\s*::\s*$/` at block indent 0 into
   `<template v-slot:name>` — but CommonMark reads them as paragraphs. All 49 were msgids. A
   translated marker moves a column's prose into another slot or off the slide.
2. **Most slide prose was never extracted.** ADR 0012's locator treated every raw HTML block as
   skeleton and reported it (`prose-in-html-block`). The deck writes its prose inside components —
   `<KwCard heading="…">` 242 times, `<CodeNote at=… label="…">` 116 times, `<div>` grids around
   them — so the report fired 235 times in 28 of 29 sections. A large share of every slide would
   stay English in any locale, and the pt-BR contribution's translations of that prose could not
   be harvested.

Both are within spec 001's own terms: FR-005 says Vue islands are protected skeleton, and ADR 0004
says inline markup stays literal inside a paragraph unit. What neither said is where, inside an
island, the prose ends and the machinery begins. That boundary is what this ADR fixes, together
with the one piece of it that cannot be inferred: which component props are text.

## Decision

### Slot markers are skeleton, and scope keys

A line Slidev reads as a slot marker is never part of a unit. The locator transcribes Slidev's
regex, finds markers only where Slidev does (column 0, a whole line, in a paragraph's lines —
never inside a fence or an HTML block, where Slidev does not see them either), and blanks them in
the copy the parser reads, so a marker that interrupts a paragraph splits it exactly where Slidev
splits it. Offsets are unchanged, so every hole still points at the original bytes (ADR 0012).
A marker-shaped line inside a blockquote or an indented list item keeps its paragraph English and
is reported (`slot-marker-in-container`). Composition refuses a translation that introduces a
marker line.

Each marker opens a key scope named after its slot: `body/slot-right/p-1`. The slot name is layout
machinery, not prose, so this is a structural key in ADR 0005's sense, and it means editing the
left column no longer re-keys the right one. A repeated or unusable name falls back to
`slot.<ordinal>`, which a plain name cannot collide with.

### HTML blocks are scanned for prose runs

A raw HTML block is read with a small, tolerant tag scanner — the parser is still only a locator;
nothing is re-serialized. Inside the block:

- **A run** is a maximal sequence of sibling text, `{{ }}` interpolations and *inline-safe*
  elements. It becomes one unit, trimmed of surrounding whitespace, with continuation-line
  indentation stripped the way a list item's is.
- **Inline-safe** means a standard HTML phrasing element (`strong`, `em`, `code`, `span`, `a`,
  `br`, …) that is closed inside the block, carries no Vue directive, binding, event or slot
  attribute (`v-…`, `:…`, `@…`, `#…`), and holds only inline-safe content. These ride along
  literally, exactly as ADR 0004 already lets inline markup ride along in a markdown paragraph.
- **Everything else is a boundary**: components (`<KwCard>`, `<CodeNote>`, `<v-click>`), block
  elements (`<div>`, `<li>`), comments, and any element with a directive. Their tags are never
  in a unit; their contents are scanned for runs of their own.
- **Never prose:** the contents of `script`, `style`, `pre`, `textarea`, and CDATA/processing
  instructions; a run with no letter outside `code`/`kbd`/`samp`/`var` and interpolations
  (`<code>kubectl</code>` alone, `→`, `①`).
- **Anything left** that carries a letter — a comment aside, text behind an unterminated tag, a run
  whose key would exceed the identity limit — stays skeleton and is reported as
  `prose-in-html-block`. The warning now means *prose that could not be extracted safely*, not
  *prose inside HTML*.

Inline components inside a markdown paragraph (`Use the <KwChip variant="ok">core</KwChip> tier.`)
are not split out: the paragraph is the unit, as before, and the component rides along literally
under the markup guard below. Splitting would hand translators sentence fragments; the guard is
what makes carrying it safe.

### Text props are declared in the manifest

Which component props are text cannot be read off the deck — `heading="ClusterIP — the default"`
is prose and `kind="svc"` is not, and nothing in the markup says so. So it is declared, in the one
place the consumer already configures extraction:

```yaml
surfaces:
  slides:
    include: ['pages/*/index.md']
    componentTextProps:
      KwCard: [heading]
      CodeNote: [label]
```

- Keyed by component (or HTML element) name, matched the way Vue resolves names — `KwCard`,
  `kwCard` and `kw-card` are one component, `leftHeading` and `left-heading` one prop.
- Only **static** attributes are read. A `:heading` binding is code, and the manifest parser
  refuses a prop name that is a binding, directive, event or slot.
- **The default is empty.** A prop is machinery until declared. Over-extracting makes `kind="svc"`
  editable and breaks one locale's deck; under-extracting leaves visible English that a human
  notices. This is the same trade `DEFAULT_FRONTMATTER_TEXT_KEYS` makes, taken one step further:
  there is no corpus-derived default, because component names are theme-specific.
- The value is an unquoted, single-quoted or double-quoted attribute; the unit is the raw value,
  entities literal. On composition the delimiting quote is escaped (`&quot;`, `&#39;`) and an
  unquoted value is re-emitted double-quoted, so a translation cannot end the attribute. A line
  break in an attribute translation is refused.

### Keys inside HTML stay structural

Keys continue ADR 0005's amended scheme — a path of structural roles, no prose, no file position:

- An element is `<name>.<n>`, its name in Vue's hyphenated form (`kw-card.2`), counted per parent
  and per name — so adding a `<div>` does not re-key the cards beside it. Top-level elements of a
  block count in the enclosing heading scope, so an HTML block's position among markdown blocks
  does not enter the key either.
- A run is `t:<n>` among its parent's runs; a declared prop is `prop:<name>` on its element.
- The separators are chosen so the three shapes cannot collide with each other or with markdown
  roles (`p-1`, `l-1`, `t-1`): element names are reduced to `[a-z0-9-]`, so `.` and `:` only ever
  appear where this scheme puts them.

For example `body/h1-1/div.1/v-click.1/kw-card.1/t:1` and `…/kw-card.1/prop:heading`.

### Markup in a unit is kept, not translated

A translation of any markdown or HTML unit must carry exactly the HTML tags and `{{ }}`
interpolations its English carries, as a multiset: a translator may move `<strong>` around a
different word, but may not edit, add or drop a tag or an interpolation. Composition refuses
anything else (`markup-changed`), and an HTML-text unit additionally refuses a blank line, which
would end the HTML block and turn the rest of it into markdown. This closes a gap that predates
this ADR — markdown units already carried inline HTML (`<span class="kw-kicker">…</span>`, 120
times in the deck) with nothing stopping a TMS from rewriting it — and it is what lets inline
markup ride along inside HTML runs at all.

## Consequences

- **Measured on the real deck** (identities planned in memory, declaration `KwCard: [heading]`,
  `CodeNote: [label]`): slot markers extracted 49 → 0; `prose-in-html-block` warnings and unit
  counts before and after are recorded in the lane report that introduced this ADR.
- **Re-keying, once.** Keys after a slot marker gain a `slot-<name>/` segment, and the paragraph
  counters in the scope a marker used to occupy shift down by one. No consumer has catalogs yet,
  so this is churn in a first extract, not lost translations; after adoption, ADR 0005's
  amendment governs exactly as before.
- **The manifest change is additive and optional.** Every v1 manifest valid before this ADR is
  valid after it and means the same thing, so `apiVersion` stays `workshop-i18n/v1`. A manifest
  that uses the key is refused by an older tool with `unknown-key` naming the path — the fail-closed
  behaviour the manifest parser promises — so the release that carries it is a semver minor. This
  needs maintainer sign-off under GOVERNANCE.md, which is why the status is `proposed`.
- **The CLI must pass the declaration through.** `parseManifest` returns it on the slides surface
  spec; `extractSlidevFile` takes it as `componentTextProps`. Until the command wires one to the
  other, no prop is extracted in a real run.
- **Components inside HTML are boundaries.** `Text <KwChip>x</KwChip> more` inside a card yields
  three runs, not one sentence. It is safe, and rare in the deck; a manifest list of inline
  components could lift it later without changing any key shape.
- **The HTML scanner is a locator a Vue template compiler would disagree with on malformed
  input** — an unterminated tag, a stray closer. Those cases degrade to skeleton plus a warning;
  none of them can move a byte, because only located runs are holes.
