# ADR 0006: TMS port contract + conformance kit; zero live adapters in v1

- **Status:** proposed
- **Date:** 2026-08-15

## Context

The origin pack required every supported story to pass against **two live TMS provider adapters**,
including a deterministic provider simulator, webhook chaos scenarios, and an independently
implemented second adapter. On a ~two-maintainer project that is weeks of insurance against
lock-in to a provider no string has shipped through — and an unused second adapter rots.
Meanwhile the v1 integration path (Weblate reading committed PO files over git) requires no
adapter code at all.

## Decision

- `packages/tms-contract` defines the **port interface** a provider adapter must implement
  (publish units, import targets idempotently, preserve review state, survive source edits and
  obsolete units) and ships a **fake-backed conformance kit** — the executable specification any
  future adapter must pass.
- **v1 ships zero live adapters.** Weblate integration is documented configuration over the
  committed PO files (ADR 0002, ADR 0004).
- Anti-lock-in is provided by portable exports (PO everywhere, XLIFF export) plus the conformance
  kit — not by maintaining a redundant second adapter.
- A live adapter is written when a real trigger fires: file-based sync failing a real workflow, or
  concrete demand for a second provider (e.g. Crowdin).

## Consequences

- The port contract stays honest because the conformance kit runs in CI against the fake on every
  change (multiple test layers per story survive from the pack — ADR 0010).
- Every story is *covered at multiple layers*; the pack's "every story × every live provider"
  requirement is explicitly dropped.
- Provider migration is rehearsed through exports, not through a standing shadow adapter.
