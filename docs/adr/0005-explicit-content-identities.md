# ADR 0005: Require explicit immutable content identities

- **Status:** proposed
- **Date:** 2026-08-15

## Context

Translation state dies when identity is derived: path-based ids break on file moves, ordinal ids
break on slide insertion, and content-hash ids break on every edit — exactly when translation
memory matters most. Both workshops reorder and edit slides constantly.

## Decision

Every translatable container carries an **explicit, immutable identity** in the source:

- slides: `slideId` in slide frontmatter;
- labs: the lab's declared id;
- quiz: the existing question id.

Units within a container use position-independent keys. The full unit id
(`<surface>:<containerId>:<unitKey>`) is the PO `msgctxt` and the anchor for overrides, staleness,
and seeding. Identity is never derived from path, ordinal, or content hash.

## Consequences

- Adopting the tool requires a one-time codemod: `workshop-i18n init-ids` proposes ids derived
  from section + heading for the ~400 Kubernetes-Workshop slides and the OpenTofu corpus; a CI
  lint rejects missing or duplicate ids from then on. This migration cost is real and scheduled
  (spec 001), not assumed away.
- English edits change a unit's hash, never its identity — so an edit marks the translation fuzzy
  instead of orphaning it.
- Renaming/moving files is free; splitting a slide keeps the original `slideId` on one fragment
  and mints new ids for the rest.
