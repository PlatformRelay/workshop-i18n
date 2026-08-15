# ADR 0007: English authoritative; locale artifacts are generated, never hand-edited

- **Status:** proposed
- **Date:** 2026-08-15

## Context

The consumer workshops already rejected parallel content trees for delivery variants (one section
library, generated root decks): a hand-maintained copy drifts the moment the original changes. A
community pt-BR translation PR proved the same failure shape for locales — right intent, wrong
form. English authoring must stay exactly as it is: plain markdown, no translation keys.

## Decision

English sources remain the single editable truth. Locale trees (slides, labs, quiz) are
**generated** by `compose` from English sources + PO catalogs + overrides, and are never edited by
hand. Fenced code, commands, API identifiers, flags, paths, and image references are copied
byte-identically from the English source into every locale; `verify` enforces fence identity and
protected-term integrity as CI gates. Generated output is a build artifact — deployed or released,
not hand-maintained as source (whether the consumer also commits it is the consumer's choice).

## Consequences

- Authors never see localization machinery; editing English stays exactly as cheap as today.
- A locale can never "fix" content by editing generated output; fixes flow through the catalog,
  an override (ADR 0008), or the English source.
- The generated tree must be a valid Slidev deck that builds and exports in the consumer's CI —
  that build is itself a release gate (ADR 0009).
