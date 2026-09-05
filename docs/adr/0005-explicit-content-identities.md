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

## Amendment 2026-09-05: unit keys are container-independent, not insertion-stable

**This amendment supersedes the sentence "Units within a container use position-independent
keys" above.** That claim is stronger than any implementable scheme, and spec 001's
implementation does not meet it as written.

The implemented key is a path of structural roles inside the container:
`body/h1-1/l-2/li-3/p-1`. It is **independent of the container's position** — the property the
decision actually needs, and the one AS-3 tests: a slide that moves to another file or is
reordered in the deck keeps every unit identity, because nothing in the key refers to the file,
the deck order, or the slide index. Within a container the trailing role counter is **ordinal**,
scoped to the enclosing heading.

The two alternatives were considered and rejected as worse:

- A slug of the unit's own prose is a content-derived identity, which this ADR forbids, and it
  orphans a translation on the first typo fix.
- Per-paragraph explicit ids in the English source are what constitution I forbids: translation
  machinery in the authoring surface.

So a residue remains, and it is larger than "the paragraph after the insertion point". Inserting
or removing a **block** re-keys its later siblings in the same heading scope; inserting or
removing a **heading**, or changing a heading's level, re-keys every later sibling scope and
everything nested under it. In an eight-unit slide, adding one `##` heading moved four ids.

The consequence is bounded and must be handled, not hidden: re-keyed units arrive at the catalog
layer as a removed id plus an added id, so their translations do not silently attach to the wrong
English — they are lost and must be re-established. Translation memory makes recovering them a
match-and-confirm rather than a retranslation, and the blast radius is one slide. `extract`
reports the churn so the effect is visible in review.

Containers themselves are unaffected: `slideId`, lab id and quiz question id remain explicit and
immutable, which is what carries the state that matters.
