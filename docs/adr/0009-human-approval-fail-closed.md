# ADR 0009: Human approval through existing review mechanisms; strict compose fails closed

- **Status:** proposed
- **Date:** 2026-08-15

## Context

The origin pack required dual human approval (linguistic + visual) with fail-closed releases,
implemented via a portal with role-based inboxes. The policy is right; the mechanism was the
service tier ADR 0003 cut. AI may draft translations, but no unit ships without a human accepting
it, and no locale ships with silent English fallback.

## Decision

Keep the policy, change the mechanism:

- **Linguistic approval** = the TMS review workflow (e.g. Weblate review mode) or PR review of
  catalog changes in the consumer repo. Only `reviewed` units count as shipping-grade;
  seeded/AI-drafted entries enter as `needs-review` and can never skip straight to `reviewed`
  without a human action.
- **Visual approval** = PR review of the composed locale output in the consumer repo, assisted by
  `verify`'s deterministic gates: fence identity, protected terms, and a **length-budget
  heuristic** (target/source ratio per constrained layout) that flags likely overflow cheaply.
- **Fail-closed switch:** `compose --strict` fails on any fuzzy, missing, or unreviewed required
  unit — this is the release mode. Default (preview) mode emits visibly watermarked English
  fallback so reviewers can see gaps in context.

A rendered every-click-state visual diff pipeline is deferred until the first real clipped-slide
incident proves the heuristic insufficient.

## Consequences

- Goal "human validation is mandatory" holds with zero new UI surface.
- Release policy is enforced by exit codes in the consumer's CI, where policy already lives.
- The heuristic will miss some overflow; that residual risk is accepted and bounded by visual PR
  review of composed decks.
