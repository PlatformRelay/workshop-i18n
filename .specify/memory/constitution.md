# workshop-i18n Constitution

Binding principles for every feature, plan, and task in this repository. A spec or implementation
that conflicts with a principle is wrong until the principle is superseded by an accepted ADR.

## Core Principles

### I. English is never touched

The tool reads English sources and writes catalogs, reports, and generated locale artifacts. It
never rewrites English content except through the explicit, operator-invoked `init-ids` codemod.
No translation keys, markers, or machinery ever appear in the English authoring surface.

### II. Identity before everything

No feature may address content by file path, ordinal position, or content hash. Explicit immutable
identities (ADR 0005) are a prerequisite: if a surface has no identity scheme yet, the feature
starts by defining one, not by working around its absence.

### III. Losslessness is proven, not claimed

Any code that parses and re-emits workshop content ships with round-trip property tests and golden
fixtures from the hostile corpus (ADR 0010). Fenced code, commands, API identifiers, and image
references are byte-identical across locales, enforced by `verify` — a failed gate is a build
failure, never a warning.

### IV. Stateless CLI, git-native state

All state lives as committed files in the consumer repository (ADR 0003). No feature may
introduce a server, database, daemon, webhook, or network call at runtime. Every command is a
deterministic function of the working tree: same input, same output, exit codes carry policy.

### V. Humans accept translations

AI and seeding may draft; only a human review action (TMS review or PR review) promotes a unit to
shipping-grade. `--strict` composition fails closed on anything less (ADR 0009). No feature may
create a path that ships unreviewed prose silently.

### VI. Buy translator UX, build workshop safety

Nothing in this repo reimplements a TMS capability (editor, TM, glossary, MT — ADR 0002). Effort
goes exclusively to what TMS products cannot do: safe extraction, identities, composition,
overrides, staleness, gates.

## Additional Constraints

- TypeScript strict mode; Node ≥ 22; pnpm workspace (ADR 0011).
- Protected contracts (manifest schema, PO conventions, TMS port, `--strict` semantics) change
  only with an ADR + migration path + semver-appropriate release (GOVERNANCE.md).
- Untrusted input: extractor and composer treat consumer content as hostile — no code execution
  during extraction/composition (SECURITY.md).
- Both consumer workshops' golden corpora must pass in CI before a release (ADR 0001/0010).

## Development Workflow

- TDD: failing test first; `pnpm verify` (lint + typecheck + tests) green at every commit.
- Commits: `:gitmoji: type(scope): summary`; rebase-merge only; linear history (CONTRIBUTING.md).
- Feature flow: `/speckit-specify` → (`/speckit-clarify` if genuinely ambiguous) → `/speckit-plan`
  → `/speckit-tasks` → `/speckit-implement`; specs live under `specs/NNN-*/`.

## Governance

This constitution binds all contributors and agents. Amendments require a PR that also updates
dependent specs/ADRs, reviewed by a maintainer. Where the constitution and an ADR conflict, the
newer accepted document wins and must supersede the older explicitly.

**Version**: 1.0.0 | **Ratified**: 2026-08-15 | **Last Amended**: 2026-08-15
