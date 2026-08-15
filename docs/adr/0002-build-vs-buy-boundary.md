# ADR 0002: Integrate mature TMS products; do not build translator tooling

- **Status:** proposed
- **Date:** 2026-08-15

## Context

Translation memory, glossaries, terminology suggestions, review workflow UX, and machine-translation
integration are decades-deep product categories. Homegrown localization efforts that rebuild them
fail predictably. Translators should work in an environment built for translators.

## Decision

This tool never implements a translation editor, translation memory, glossary engine, or MT
pipeline. Translators and linguistic reviewers work in an established TMS (first target: Weblate,
pointed at the PO files committed in the consumer repository). The tool owns only what TMS
products cannot: workshop-safe extraction, stable identities, deck composition with overrides,
staleness tracking, and release gates.

## Consequences

- The v1 TMS integration is configuration, not code: Weblate's native git + PO support consumes
  the committed catalogs directly (see ADR 0006 for the port contract that guards portability).
- Fuzzy/needs-review semantics follow gettext conventions so TMS behavior and tool behavior agree.
- If a TMS feature gap appears (e.g. Slidev preview links), the answer is metadata in the catalog
  (comments, source references), not a custom UI.
