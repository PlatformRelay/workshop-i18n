# workshop-i18n

> Git-native localization for Slidev workshops — extract translatable content into gettext PO
> catalogs, compose generated locale decks with governed slide overrides, and track translation
> staleness. No server, no database: your workshop repo is the source of truth.

[![CI](https://github.com/PlatformRelay/workshop-i18n/actions/workflows/ci.yaml/badge.svg)](https://github.com/PlatformRelay/workshop-i18n/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why

Slidev has no native content i18n. The obvious answers are all bad: parallel locale trees drift
silently, inline bilingual markdown chokes past two languages, and `$t()` key soup freezes English
authoring. `workshop-i18n` takes a different shape:

- **English markdown stays the single editable source.** Authors never see translation keys.
- **Translations live in PO catalogs** (`i18n/<locale>/*.po`) committed next to the content they
  translate — reviewed through the PRs and CI your project already has.
- **Locale decks are generated, never hand-maintained.** Code fences, `kubectl` commands, API
  kinds, and image references stay byte-identical across locales, enforced by CI gates.
- **Staleness is automatic.** An English edit marks exactly the affected entries fuzzy
  (gettext-native); `workshop-i18n status` reports what needs human revalidation per locale.
- **Overflow is a first-class problem.** When German prose will not fit an English layout, a locale
  may replace or split a slide via a governed override anchored to the source slide's revision.
- Translators work in a TMS (e.g. Weblate) pointed at the committed PO files — this tool does not
  reimplement translation memory, glossaries, or editors.

## Status

Pre-alpha. The architecture is settled ([docs/adr/](docs/adr/)); implementation is spec-driven
([specs/](specs/)). Not yet usable.

## Planned CLI

```text
workshop-i18n init-ids    # codemod: propose stable slide/unit identities, lint duplicates
workshop-i18n extract     # sources → canonical units → i18n/<locale>/*.po (fuzzy on change)
workshop-i18n status      # staleness report per locale/section; non-zero exit under policy
workshop-i18n compose     # generate a runnable locale tree (--strict fails closed)
workshop-i18n verify      # fence-identity, protected-term, and length-budget gates
workshop-i18n seed        # align an existing translated tree into needs-review entries
```

## Repository layout

```text
packages/
  core/              # domain: identities, unit model, states, policy — pure, no I/O
  extract-slidev/    # lossless Slidev round-trip (@slidev/parser + mdast)
  extract-markdown/  # lab markdown extraction
  extract-quiz/      # structured quiz JSON extraction
  catalog-po/        # PO read/write, fuzzy handling, msgctxt identities
  compose/           # locale tree generation, overrides, gates
  tms-contract/      # TMS port interface + fake-backed conformance kit
  cli/               # the workshop-i18n command
fixtures/            # hostile corpus from consumer workshops
docs/adr/            # architecture decision records
specs/               # Spec Kit feature specs
```

## Consumers

Built for and tested against
[Kubernetes-Workshop](https://github.com/PlatformRelay/Kubernetes-Workshop) and
[OpenTofu-Workshop](https://github.com/PlatformRelay/OpenTofu-Workshop). Any Slidev-based workshop
with a `.localization/workshop.yaml` manifest can adopt it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Architectural changes go through an ADR
([docs/adr/](docs/adr/)); the `workshop.yaml` manifest schema is a public contract and changes to
it require maintainer sign-off ([GOVERNANCE.md](GOVERNANCE.md)).

## License

[MIT](LICENSE)
