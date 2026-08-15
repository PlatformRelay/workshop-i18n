# ADR 0003: Stateless CLI; localization state lives in the consumer repository

- **Status:** proposed
- **Date:** 2026-08-15
- **Replaces (pre-repo):** the origin pack's "modular monolith with asynchronous workers"
  (PostgreSQL, durable queue, object store, web portal, webhook ingestion).

## Context

The origin architecture pack designed a service: database, queue, S3 artifacts, role-based web
portal, webhook ingestion, SLOs, and disaster recovery. The consumer base is two workshops with
~two maintainers and volunteer translators, and zero lines of localization code exist yet. The
riskiest unknown — lossless Slidev round-trip — needs none of that runtime. Git already provides
the properties the service tier was buying: durable state, audit trail, access control, review
(PRs), automation (CI), and immutable releases (tags).

## Decision

`workshop-i18n` is a stateless CLI — a pure function over the consumer repository's working tree.
All localization state is committed files in the consumer repo:

- `i18n/<locale>/*.po` — translation catalogs (ADR 0004);
- `i18n/<locale>/overrides/<slideId>.md` — governed slide overrides (ADR 0008);
- `.localization/workshop.yaml` — the manifest.

There is no server, no database, no webhook, and no state owned by this tool. CI in the consumer
repo runs `extract`/`status`/`verify`; humans act through PRs and the TMS.

**Reversal trigger** (recorded so the service tier can earn its existence with evidence): adopt a
service only when ≥3 active workshop consumers exist **and** file-based TMS sync demonstrably
fails a real translator workflow (measured, not anticipated). The parked inbox/outbox and
sandboxed-rendering ADRs from the origin pack apply at that point.

## Consequences

- Translations version atomically with the content they translate and survive forks.
- Collaboration visibility is limited to CI reports and the TMS's own UI — accepted.
- Everything is reproducible from a checkout; there is nothing to back up or operate.
- The domain model stays in `packages/core` behind pure interfaces, so a future service would
  wrap, not rewrite, the engine.
