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
`slot:<ordinal>`. That fallback was first spelled `slot.<ordinal>`, which is exactly the key of a
`<slot>` HTML element (`<name>.<n>`, below) and gave two units one identity; the colon keeps the
two namespaces disjoint.

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

A **multi-line opening tag** (`<KwCard` with its props on the lines below) opens no HTML block:
CommonMark and markdown-it both test the block-start condition against the first line alone, so
the tag is inline HTML in a paragraph to the renderer, and it is a paragraph unit here too. The
locator follows the renderer rather than the author's intent; the markup guard keeps the tag, and
a paragraph that is nothing but an opening tag (possible when a lone `>` line starts a blockquote)
is not a unit at all. A declared prop inside such a paragraph is not extracted separately — it is
part of the paragraph's markup.

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
  refuses a prop name that is a binding, directive, event or slot — judged on the name as Vue
  resolves it, so `vHtml` is refused as `v-html` and `onClick` as a listener (`on` + upper case,
  `on-…`, or an all-lower-case `on…` HTML handler shape; `onboardingTitle` is allowed). Address, style and
  component-switch attributes (`href`, `src`, `srcset`, `srcdoc`, `action`, `formaction`,
  `style`, `is`, …) are refused too, and a declaration is capped at 64 components and 16 props
  each. `extractSlidevFile` applies the same rule to a declaration handed to it directly.
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
- The separators keep every shape in its own namespace: element segments are reduced to
  `[a-z0-9-]` and end in `.<n>`; runs are `t:<n>`, props `prop:<name>`, slot scopes `slot-<name>`
  or `slot:<n>`, markdown roles `<role>-<n>`. A `.` therefore only ever ends an element segment and
  a `:` only ever appears in a run, prop or fallback slot segment, so no two shapes can spell the
  same segment — the one collision a review found (`slot.1`) is the reason the slot fallback uses
  a colon.

For example `body/h1-1/div.1/v-click.1/kw-card.1/t:1` and `…/kw-card.1/prop:heading`.

### Markup in a unit is kept, not translated

A translation of any markdown or HTML unit must carry exactly the HTML tags and `{{ }}`
interpolations its English carries, as a multiset: a translator may move `<strong>` around a
different word, but may not edit, add or drop a tag or an interpolation, and markup that nests in
the English must still nest — a closing tag moved ahead of its opener is a template Vue refuses
to compile, which fails the whole deck's build. Composition refuses anything else
(`markup-changed`), and an HTML-text unit additionally refuses a blank line, which
would end the HTML block and turn the rest of it into markdown. This closes a gap that predates
this ADR — markdown units already carried inline HTML (`<span class="kw-kicker">…</span>`, 120
times in the deck) with nothing stopping a TMS from rewriting it — and it is what lets inline
markup ride along inside HTML runs at all.

**What counts as markup is read coarsely, on purpose.** The first version of this guard compared
tags as this package's scanner read them, and that scanner's tag-name rule was narrower than
Vue's: `<x_y v-html=…>`, `<svg:a onmouseover=…>` and `<a"b>` counted as text and compiled as live
elements, and `Welt <img` passed because it was judged alone rather than in front of the `</div`
it swallows. So the decision is now renderer-independent: every `<` not followed by whitespace
(with the text up to the next `>`), every `{{` and every `}}` must match the English as a
multiset, and their count may not change across the lines the replacement lands in. Comment
words are exempt; comment delimiters are counted. The precise scanner — now reading tag names
the way Vue's tokenizer does — may only add refusals. A false positive costs one unit an English
fallback; a false negative costs code execution in the deck.

**…and as the markdown renderer decodes it.** Slidev renders slide prose through markdown-exit
before Vue compiles the HTML, and markdown-it decodes character references and backslash escapes
on the way: `&#123;&#123;`, `&lbrace;&lbrace;`, `&#x7b;&#x7b;` and `\{\{` in a paragraph all
become a live `{{`. So for markdown and HTML-text units the counts are also taken over the text
with every reference or escape that decodes to `{`, `}` or `$` decoded (with an optional `;` and
names matched without case — more generous than the renderer, never less), and no brace or `$`
may be added at all. `<` and `>` stay encoded, from evidence: markdown-it re-escapes them in its
output, and inside a raw HTML block Vue's compiler decodes references only after it has found
the tags and interpolations (`&#123;&#123; x &#125;&#125;` there compiles to the text `{{ x }}`,
not an interpolation). Prop values are static strings to Vue — the same decode yields a string
prop — and are judged on their bytes.

**Block syntax is judged by line.** A line starting, at any indentation, with `<<<` (a snippet
import, which published a `.env` file in a real build), `$$` (a KaTeX block whose `{…}` becomes a
live `v-bind`), `:` (the MDC block grammar accepts two or more colons and trims before the name;
its `:1` shorthand crashes the build) or `[name]:` (a link reference definition an image can
point at) is refused unless the lines the replacement lands in already hold it. Every line rule —
these, slide separators, fence openers and slot markers — reads the line both as written and with
its container prefixes stripped repeatedly (spaces and tabs, `-`/`+`/`*` or `1.`/`1)` followed by
whitespace, `>`), because block rules run again inside a list item or a quote: `- :: Toc`,
`1) :::Toc`, `- [r]: ./.env?raw` and `- <<< @/.env` are the block syntax their content is.

**The backbone is a character budget, not a list of syntax.** Three review rounds each found one
more construct made of characters the coarse rules did not enumerate — `![x](./.env?raw)`, a
fence after a list bullet, `:Name`, `<<<`. So the guard now enumerates what a translation may
*add* instead. After decoding character references and backslash escapes, every character of a
markdown or HTML-text translation outside the free set may appear at most as often as in the
English unit. The free set is Unicode letters, marks and decimal digits; the two ordinary spaces
(U+0020, U+00A0); the prose punctuation `. , ; : ! ? ' " ( ) - – — … « » “ ” ‘ ’ ¿ ¡ %`; and —
from evidence below — non-ASCII punctuation and symbols. Everything else (`` ` ~ < > { } [ ] $ * _
# | @ / \ & ^ = + ``, other spaces, format characters such as U+200B or U+202E, controls) is
budgeted. On top, the budget keeps its specific rules, each of which a budget alone cannot see:

- inline code spans must be carried exactly (whitespace runs folded, since the renderer turns a
  line break inside one into a space), so markup the English keeps inside code cannot move out of
  it — `` `<img src=x onerror=y>` `` stays inert only inside the backticks;
- no added `![` (an image is a build-time asset import, and a relative one in a heading fails the
  whole build), no added run of three or more backticks or tildes anywhere (a fence after a
  container prefix: PlantUML, Mermaid, twoslash), no added inline `:name` in MDC's own name class
  `[\w$-]`, no added `v-drag`, and no added link target (a URL, a `www.` host, or a dotted name
  ending in a letter-only label, which linkify would turn into a link made only of free
  characters).

A line break is free where the next line cannot start or interrupt a block — it begins, after
ordinary spaces, with a letter, a non-ASCII character, `(`, `"`, `'`, a backtick, `/`,
`**word`-style emphasis, `=` or `#` that are not a setext underline or heading, or a number
that is not an ordered-list marker at 1 — and budgeted elsewhere. Inside a raw HTML block no block
rule runs until a blank line, which is refused on its own, so there every break is free.

Why non-ASCII punctuation and symbols are free: every grammar in the render path is spelled in
ASCII — CommonMark and markdown-it syntax and escapes, HTML and Vue templates, Slidev's slot,
snippet, KaTeX and v-drag rules, MDC. A character such as `→`, `·`, `≤`, `✓` or an emoji cannot
start, end or change markup in any of them. Format characters, other spaces, controls, private-use
and unassigned code points stay budgeted.

Measured on the real pt-BR drafts (the seed lane's 1,195 aligned markdown pairs, plus 425
HTML-text and 233 prop pairs paired by slide position): the guard before this round refused 0 of
1,853. A strict budget (ASCII-only free punctuation, a break free only before a letter) refused
118 — 94 markdown and 24 HTML-text, 91 of them line breaks before `(`, a backtick, `**` or a
number, five of them code spans re-wrapped across a line break. With the rules above it refuses
6, all markdown: four S21 units where the pt-BR draft translates the Argo CD variant against the
Flux English, one note that adds a sentence with a `/`, and one note whose re-wrap starts a line
with `:8080` — an MDC block shape that would really crash a build with MDC on. HTML-text and prop
units: 0 refused.

A test composes every corpus file with hostile payloads, renders each slide body and note with
markdown-exit (the consumer's version, with Slidev's options) and compiles the HTML with
`@vue/compiler-dom` (the consumer's Vue): the translated deck may hold nothing markdown cannot
produce from prose that the English lacks. Slidev's own markdown extensions are outside what
that oracle models, which is why the block-line rule and the decoder carry direct tests too.

## Consequences

- **Measured on the real deck** (all 29 sections, identities planned in memory): slot markers
  extracted 49 → 0; `prose-in-html-block` warnings 235 in 28 sections → 0; units 1592 → 1996
  with no declaration, 2354 with `KwCard: [heading]` and `CodeNote: [label]` (the 358 extra are
  exactly the 242 headings and 116 labels). Every section still composes back byte-for-byte from
  an empty catalog, and re-extracting a fully translated locale gives back every identity.
- **Re-keying, once.** Of the 1592 identities the deck had before, 1489 are unchanged (same id,
  same text), 49 were slot markers and are gone, and 54 moved: the prose after a `::right::` or
  `::notes::` gained a `slot-<name>/` segment, and paragraph counters in the scope a marker used to
  occupy shifted down by one. No consumer has catalogs yet, so this is churn in a first extract,
  not lost translations; after adoption, ADR 0005's amendment governs exactly as before.
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
  none of them can move a byte, because only located runs are holes. A block nested deeper than
  48 elements is left as skeleton and reported rather than walked.
- **Two known key residues.** An element's key segment is its tag name, so `Press <Enter> to go`
  inside an HTML block — an unknown element to Vue — keys the text after it under `enter.1`: a
  segment taken from what the author meant as prose. And `v-pre` is treated like any other
  directive (a boundary whose contents are still scanned); inside it `{{ }}` is literal text to
  Vue but is still guarded as markup, which only costs a translator flexibility.
