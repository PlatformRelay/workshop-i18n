# Contributing

Thanks for considering a contribution. This project is pre-alpha; the fastest way to help is to
pick an open issue or discuss a proposal in an issue before writing code.

## Development setup

Requirements: Node.js ≥ 22, pnpm ≥ 11.

```bash
pnpm install
pnpm verify        # lint + typecheck + tests — the local gate, run before every PR
```

## Workflow

1. Fork and branch from `main` (`feat/<topic>`, `fix/<topic>`, `docs/<topic>`).
2. **Tests first.** New behavior lands with a failing test that the change makes pass. Parser and
   composer changes additionally need a golden-fixture case under `fixtures/`.
3. Keep `pnpm verify` green at every commit.
4. Open a PR. CI must pass; a maintainer reviews and merges.

## Commit convention

```text
:gitmoji: <type>(<optional scope>): <short summary>
```

ASCII gitmoji shortcode (e.g. `:sparkles:`, `:bug:`, `:memo:`) directly before the type — no
Unicode emoji. Types: `feat fix docs style refactor test chore ci build`. One logical change per
commit; the tree stays green at each commit.

## Merge policy

**Rebase and merge** — linear history, no squash, no merge commits. Branches are deleted on merge.
This preserves each well-formed commit on `main`, which is why one-logical-change-per-commit
matters.

## Architectural changes

Anything that touches a protected contract (see [GOVERNANCE.md](GOVERNANCE.md)) or changes the
architecture needs an ADR in [docs/adr/](docs/adr/) accepted before the implementing PR merges.
Feature work follows the Spec Kit flow under [specs/](specs/): spec → plan → tasks → implement.

## Translations and locale content

Locale content (PO catalogs, override slides) lives in the **consumer workshop repositories**, not
here. This repository only contains the tool and test fixtures. If you want to translate the
Kubernetes or OpenTofu workshop, contribute there.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
