# ADR 0016: Seeding may pair slides by position, only where the pairing is provable

- **Status:** proposed
- **Date:** 2026-09-10

## Context

Constitution II and ADR 0005 forbid addressing content by file path, ordinal position or
content hash. Spec 004 User Story 1 asks `seed` to harvest an existing translated
*parallel tree* — Kubernetes-Workshop PR #55, a full pt-BR translation — into needs-review
catalog entries, aligned "by container structure and unit position within matched
containers".

That tree was translated before `init-ids` existed, so its slides carry no `slideId`. Labs
and quiz questions are not a problem: a lab is one file paired with one file, and quiz
questions carry explicit ids in both trees. Slides are: to learn that translated slide *n*
is the translation of English slide *n*, something has to tie the two together, and the
only thing the two decks share is the order of their slides.

A plain ordinal pairing is unsound even when both decks split into the same number of
slides. Independent review demonstrated it: a deck of four same-shaped slides, translated
with slide 2 dropped and a new slide appended, seeded all eight units onto the wrong slide
ids with no miss and no warning; swapping two same-shaped slides did the same. That is
precisely the silent mis-attachment ADR 0005 exists to prevent, and it violates spec 004's
edge case "ambiguity → miss, never guess".

## Decision

`seed` may pair a translated slide with the English slide at the same position, as a
**bounded exception** to constitution II. The pairing is allowed only when all of the
following hold, and a slide that fails any of them is missed and listed in the report:

1. **One file pair at a time.** Position is never compared across files.
2. **Same slide count.** Both decks split into the same number of slides by Slidev's own
   rules (as transcribed in `extract-slidev`); otherwise the whole file is missed
   (`slide-count-mismatch`).
3. **Same machinery.** The two slides' frontmatter agrees on everything except the declared
   prose keys and `slideId` (`structure-diverged`).
4. **Same fingerprint.** The two slides agree on a language-independent fingerprint: body
   unit keys, fenced-block bodies with comments stripped (info string and line count only
   for prose-bearing fences such as `console` and `text`), inline code span contents,
   link and image targets and bare URLs, and the sequence of HTML/Vue elements by tag,
   attribute names, and bound or machinery attribute values (`structure-diverged`, with
   the parts that differ named).
5. **Unique fingerprint.** No other slide in *either* deck shares that fingerprint and
   machinery. Two indistinguishable slides can be swapped, or one dropped and another
   added, without any structural trace, so position cannot prove which is which
   (`ambiguous-position`).

The borrowed identity never leaves the seed run: it is written into the translated source
in memory only, and every draft carries the English unit id. The result is always a
`needs-review` draft (ADR 0009), so a residual mis-pairing — a translator who rewrote a
slide into a different slide that happens to share its fingerprint, at the same position —
still meets a human before it can ship.

## Consequences

- The exception is narrow and one-directional: it lets `seed` *borrow* identities from the
  English for alignment; it never mints, stores or derives an identity from position.
  Extraction, catalogs, overrides and staleness remain id-addressed exactly as ADR 0005
  says.
- Some real translation work is left for a human. On the full PR #55 corpus the rules seed
  1399 of 1592 slide units (87.9%, down from 88.7% under plain ordinal pairing): one
  slide misses because the translator translated prose *inside* a code span, and two
  S25 slides miss because they are indistinguishable from each other. Labs and quiz are
  unaffected (81.2% and 100%); the run as a whole seeds 84.4%.
- A future parallel tree that already carries `slideId`s needs none of this: declared ids
  that agree with the English are honoured, and disagreeing ones miss as
  `container-id-conflict`.
- Reversal trigger: if a seed source ever needs position pairing without a unique
  fingerprint (for example a deck of deliberately identical slides), the answer is to give
  that tree ids first, not to widen this exception.
