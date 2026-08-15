# ADR 0008: Governed, revision-anchored slide overrides and splits

- **Status:** proposed
- **Date:** 2026-08-15

## Context

String substitution alone cannot localize everything: German routinely needs more characters than
English and will overflow tight slide layouts, and occasionally pedagogy differs by locale. A
locale must be able to replace a whole slide — or split one English slide into several locale
slides — without forking the deck.

## Decision

A locale may override a slide via `i18n/<locale>/overrides/<slideId>.md`: one file containing
1..n full locale slides that `compose` substitutes for the English slide with that `slideId`.
Overrides are **governed**:

- each override records the `sourceSlideHash` of the English slide revision it was written
  against; when the English slide changes, the override is invalidated **wholesale** and reported
  by `status` until a human re-anchors it;
- fenced code and protected terms inside overrides pass the same `verify` gates as generated
  content — an override cannot smuggle divergent commands or API names;
- the override ratio per locale is a `status` report line; a locale whose overrides dominate is a
  fork wearing a costume, and that threshold is a policy conversation, not a tool feature.

## Consequences

- Goal "overflow / split slides" is met without keys in English markdown and without parallel
  trees.
- Overrides are reviewed like any content change: through the consumer repo's PRs.
- Splitting mints new slide ids for the extra fragments (ADR 0005), so click-level review
  comments and staleness stay addressable.
