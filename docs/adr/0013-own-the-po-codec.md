# ADR 0013: Own the PO codec rather than depend on `gettext-parser`

- **Status:** proposed
- **Date:** 2026-09-05

## Context

ADR 0004 makes gettext PO the working format, and spec 002 turns that into hard requirements the
catalog layer must satisfy:

- `msgctxt` carries the stable unit id (FR-002);
- an English edit sets `fuzzy` **and** records the previous source as `#| msgid` (FR-003);
- a deleted unit becomes an obsolete `#~` entry rather than disappearing (FR-004);
- output is deterministic and stably ordered so a no-change `extract` is a zero-byte diff (FR-005,
  SC-002);
- translator-owned fields on untouched entries survive verbatim (FR-001).

`gettext-parser` is the ecosystem default, but it is built for compiling catalogs, not for
round-tripping them through git. It discards obsolete entries and comment classes it does not
model, it does not preserve `#|` previous-source, and its serializer owns line wrapping and entry
ordering — precisely the three decisions FR-005 requires us to control. Working around that means
post-processing its output, which is a fragile way to end up owning the format anyway.

The format itself is small: entries of `#.`/`#:`/`#,`/`#|` comments, optional `msgctxt`, `msgid`,
`msgstr`, C-style string escaping and adjacent-string continuation, plus `#~` obsolete lines.

## Decision

Implement PO reading and writing inside `packages/catalog-po`, with no third-party runtime
dependency. The codec is:

- **Total on the read side** — a syntax error is a hard error naming file and line (spec 002 edge
  case), never a silent partial parse or a silent rewrite.
- **Lossless on unknown input** — comment classes and flags we do not interpret are preserved in
  order on write, so a TMS that annotates entries does not lose its annotations on the next
  `extract`.
- **Deterministic** — a single canonical spelling: fixed entry ordering (by `msgctxt`), fixed
  wrapping, no `POT-Creation-Date`-style volatile headers. Same inputs produce the same bytes on
  every machine and every run.
- **Property-tested** — parse/serialize round-trip over generated and golden catalogs, plus the
  hostile escaping cases (embedded quotes, newlines, backslashes, non-ASCII) that spec 001's edge
  cases hand us.

Interoperability, not novelty, is the acceptance bar: catalogs must be readable by `msgfmt` and by
Weblate. Spec 004 verifies the Weblate review-flag convention against fixtures, and that mapping is
implemented here rather than in a wrapper.

The bar has two directions, and only one of them is discharged by compiling our own output.
Reading is evidenced against catalogs the GNU tools actually wrote — `fixtures/catalogs/gnu-generated/`,
regenerable by the script beside them — because a fixture we hand-wrote to *imitate* GNU output
evidences our imitation, not gettext. `packages/catalog-po/test/gnu-fixtures.test.ts` reads them,
and asks `msgcat` itself whether what we write back still means the same thing.

## Consequences

- One less supply-chain edge in a repo that runs Scorecard and CodeQL, and no upstream lag when we
  need a comment class the dependency does not model.
- We own gettext conformance, including the parts we do not use. The codec is deliberately scoped:
  plural forms are parsed and preserved but not synthesized in v1 (workshop prose has no plural
  units); anything unsupported is an explicit error, never a quiet drop.
- The zero-byte-diff property (SC-002) becomes testable directly against our own serializer instead
  of being asserted about a dependency's formatting.
- If the scope ever grows past what this justifies, the codec is a package boundary and can be
  swapped behind its interface.

### Normalizations the canonical form applies

Owning the write side means owning a canonical spelling, so reading and re-writing a catalog
produced by other tools changes bytes that carry no meaning. All of these are deterministic and
idempotent — they happen once, on adoption, not on every run:

- **Line wrapping is re-flowed.** GNU wraps string values at a column; we break only after
  embedded newlines (equivalent to `msgcat --no-wrap`). Adopting a catalog written by GNU tools
  or by a TMS therefore produces one large diff the first time and none afterwards. Column
  wrapping is rejected precisely because it makes the bytes depend on a width constant and
  re-flows a whole entry when one word changes, which is the opposite of FR-005.
- **A UTF-8 BOM is dropped and CRLF line endings become LF.** Catalogs are UTF-8 (ADR 0004) and
  git-native; a BOM and CRLF are both read without complaint and neither is re-emitted. Worth
  naming: on the BOM we are *more* permissive than gettext, which refuses the same file
  (`msgfmt` reports `bom.po:1:2: syntax error`). So "what we accept" is not a subset of "what
  gettext accepts", and the interoperability claim runs one way only — everything we *write* is
  ordinary gettext, which is the direction that matters for a catalog leaving this tool.
- **Comment and flag order is canonicalised.** Comments keep the order they were read in, but the
  groups are emitted in gettext's order — comments, then `#,` flags, then `#|` previous-source —
  and duplicate flags collapse. No comment class or flag is dropped, including ones we do not
  interpret.
- **Entry order is canonicalised.** Header, then live entries sorted by `msgctxt` then `msgid`,
  then obsolete entries sorted the same way. GNU keeps the order the source produced. Sorting is
  what makes a no-change extract a zero-byte diff (FR-005), so it is not negotiable; against a
  GNU `--no-wrap` catalog it is the *only* remaining difference, which is how
  `gnu-fixtures.test.ts` pins it.
- **Escaped bytes become the characters they encode.** `msgcat --escape` spells every non-ASCII
  character as octal byte escapes, sometimes split across continuation lines. We decode them and
  re-emit literal UTF-8, escaping only `"`, `\` and control characters without a mnemonic.
- **Indentation is dropped.** `msgcat --indent` writes keywords and continuation lines with
  leading whitespace; we read it and emit the flush-left form.

Each of these was checked against real GNU output rather than against a description of it, and
each is idempotent: the second pass over our own output is a fixed point.

One asymmetry is worth naming: we keep `#.` and `#:` comments on obsolete (`#~`) entries, because
they record what a preserved translation was made against. `msgcat` preserves them too (verified
on 0.23.2), but `msgmerge` drops both classes at the moment it obsoletes an entry — it rebuilds
them from the POT, and a unit that left the English source has no POT entry left to rebuild from.
So a catalog that has been through `msgmerge` will have lost them. Nothing depends on their
retention — the update algorithm rebuilds provenance from the English source when a unit returns —
so this is a graceful loss, not a correctness one.

### Shapes we refuse that GNU produces

Two of them, both valid gettext — `msgfmt` compiles all three fixtures under
`fixtures/catalogs/gnu-generated/refused/` — so these are our limits, not gettext's bugs. Each is
kept on purpose and pinned by a test, so neither can drift from a decision into an accident.

**A catalog with no header entry.** Three GNU invocations produce one:

- `xgettext --omit-header`,
- `msgcomm --omit-header`,
- and any `msgcat`/`msgmerge` run whose first (or definition) input is one of those, because
  headerlessness propagates.

The header is where `Content-Type` and `Plural-Forms` live, so a headerless catalog has no declared
encoding — and that is not an abstract worry. `xgettext --omit-header` has nowhere to write a
charset, so it falls back to ASCII and **strips every non-ASCII byte out of the msgids it
extracts**: our own fixture, extracted from a source containing `Grüße, 日本語 — first line`, holds
`Gre,   first line`. The loss happens at production time, announced by a run of `invalid multibyte
sequence` on xgettext's stderr. Consumers reading the result afterwards say nothing at all — there is
nothing left to complain about — so the file arrives looking clean. Nothing in this tool's pipeline
can produce one, because `extract` always writes a header, and `--omit-header` is a POT-diffing
convenience rather than a shipping format. In a tool whose entire contract is byte-exactness,
accepting a catalog whose encoding is undeclared trades a real invariant for a case no consumer
hits.

**A catalog declaring a charset other than UTF-8.** One `msgconv --to-code=ISO-8859-1` away from
any catalog, and `msgfmt` compiles the result. Refused by `catalog.ts`, not by the codec — the
format is indifferent to charset and this is a policy of the tool (ADR 0004), which is why the two
refusals live at different layers.

Because both refusals stand, their messages carry the remedy rather than only the rule — the shape
`packages/core` uses for its reserved-locale rejection, on the same reasoning: that string is all a
translator handed a rejected file will read. The headerless message names
`msgen <file> | msgconv --to-code=UTF-8`, and the pipe is load-bearing: `msgen` and `msginit` both
synthesize a header declaring `charset=ASCII`, which the charset rule above then refuses, so advice
naming either of them alone walks the reader into a second wall. A gettext-gated test *executes*
the remedy rather than asserting it, because that is the mistake this message already made once.

**How the header rule fires.** `parsePo` requires the header to be the *first* entry, and that
ordering form is kept deliberately: relaxing it to "a header exists somewhere" would newly accept a
hand-edited catalog whose header drifted into the middle. But no GNU producer can fail it that way.
`--sort-output` and `--sort-by-file` both leave `msgid ""` at the top, and `msgattrib
--set-obsolete` obsoletes every entry *except* the header, because gettext treats it as a
distinguished entry rather than as a message; thirty ordering-affecting invocations were checked
and none moved it. So every GNU catalog that trips this rule is missing its header outright, never
carrying a late one — and gettext is indifferent to a late header anyway, since `msgcat` leaves a
mid-file header where it found it and `msgfmt` still compiles the result. The condition therefore
stays an ordering check while the *message* branches: a missing header gets the remedy above, a
misplaced one gets told which line its header is on.

The parser's other self-flagged strictness — refusing a comment block that is followed by no entry
— was checked the same way and found *not* to be reachable from GNU output. No tool emits a
dangling trailing comment; `msgcat` silently discards one if it reads a catalog that has it. We
raise an error there instead, which is the stricter but safer half of the same disagreement:
spec 002 forbids dropping translator work silently.
