# Project governance

`workshop-i18n` is an open-source localization tool maintained as a personal OSS project under
[github.com/PlatformRelay/workshop-i18n](https://github.com/PlatformRelay/workshop-i18n). This
document describes how decisions are made and who is responsible for what.

## Scope

This governance model applies to:

- The `workshop-i18n` packages, CLI, and documentation in this repository.
- Release artifacts published to npm and GitHub Releases.

It does **not** cover consumer workshops' content or their localization policy decisions.

## Roles and responsibilities

| Role | Who | Responsibilities |
| --- | --- | --- |
| Maintainer | [@konih](https://github.com/konih) | Roadmap, reviews, releases, security response |
| Contributors | Anyone | PRs, issues, discussion |

## Decision making

- Routine changes: PR review by a maintainer.
- Architectural changes: an ADR in [docs/adr/](docs/adr/) accepted by a maintainer **before** the
  implementing PR merges. Superseding an accepted ADR requires a new ADR, not an edit.
- **Protected contracts — maintainer sign-off required:**
  - the `.localization/workshop.yaml` manifest schema (public contract with consumer repos);
  - the PO catalog conventions (`msgctxt` identity scheme, provenance comments);
  - the TMS port contract in `packages/tms-contract`;
  - the release/fail-closed policy semantics (`--strict` behavior).

  These are versioned interfaces other repositories depend on. Changes require an ADR, a
  documented migration path, and a semver-appropriate release.

## Releases

Releases are cut from `main` by a maintainer following semantic versioning. Breaking changes to
any protected contract require a major version bump and migration notes in the changelog.

## Continuity

If the maintainer is unresponsive for 90+ days, forks are welcome — the MIT license and this
repository's history make that practical. Consumer workshops pin tool versions, so an unmaintained
tool degrades slowly rather than suddenly.
