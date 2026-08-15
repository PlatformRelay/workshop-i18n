# ADR 0001: Ship one standalone tool repository shared by all consumer workshops

- **Status:** proposed
- **Date:** 2026-08-15

## Context

Two Slidev workshops (Kubernetes-Workshop, OpenTofu-Workshop) share the same content shape —
section library under `pages/`, single-file labs, structured quiz JSON — and both need
localization without forking their content trees. Embedding the tooling in one workshop would
couple the other to that repo's release cadence and make the extraction contract implicit.

## Decision

Localization tooling lives in this standalone repository (`PlatformRelay/workshop-i18n`),
published to npm, and consumed by each workshop as a pinned dev dependency. Each consumer declares
its shape in a versioned `.localization/workshop.yaml` manifest; the manifest schema is a
protected contract (GOVERNANCE.md).

## Consequences

- The workshops upgrade the tool deliberately (Renovate PRs against a pinned version); a tool
  change can never break a workshop silently.
- CI here runs reverse-dependency contract tests against golden corpora sampled from both
  consumers, because the consumers' conventions already diverge (Makefile+mise vs Taskfile,
  `questions.json` vs `questions.prototype.json`).
- A third workshop can adopt the tool by writing a manifest, not by copying scripts.
