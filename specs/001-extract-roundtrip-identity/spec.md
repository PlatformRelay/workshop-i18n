# Feature Specification: Lossless extraction with stable identities

**Feature Branch**: `001-extract-roundtrip-identity`

**Created**: 2026-08-15

**Status**: Draft

**Input**: v1 foundation — `extract` walks the surfaces declared in `workshop.yaml` and emits
canonical translation units; `init-ids` codemods explicit identities into existing corpora; CI
lint rejects missing/duplicate ids. (ADRs 0001, 0003, 0004, 0005, 0010; constitution I–IV.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Adopt identities in an existing workshop (Priority: P1)

A workshop maintainer runs `workshop-i18n init-ids` on their repo. The tool proposes a stable
`slideId` for every slide (derived from section + heading), lab id, and quiz-question id where one
is missing, writes them into the sources as a reviewable diff, and from then on `init-ids --check`
in CI rejects missing or duplicate identities.

**Why this priority**: Nothing else in the product works without identities; this is the one-time
migration cost ADR 0005 schedules explicitly (~400 slides in Kubernetes-Workshop plus the OpenTofu
corpus).

**Independent Test**: Run against a golden corpus snapshot of each workshop; the resulting diff
touches only frontmatter/id fields, is idempotent on re-run, and `--check` passes after apply and
fails on a fixture with a duplicated id.

**Acceptance Scenarios**:

1. **Given** a slide without `slideId`, **When** `init-ids` runs, **Then** a unique, readable id
   derived from section + heading is inserted and no other byte of the slide changes.
2. **Given** a repo where every container has an id, **When** `init-ids` runs again, **Then** the
   working tree is unchanged (idempotence).
3. **Given** two slides with the same `slideId`, **When** `init-ids --check` runs, **Then** it
   exits non-zero naming both locations.

### User Story 2 - Extract canonical units (Priority: P1)

A maintainer runs `workshop-i18n extract`. The tool reads `.localization/workshop.yaml`, walks
slides, labs, and quiz, and emits canonical translation units — paragraph-granular prose with
markdown inline markup left literal, each unit carrying its stable id and source hash. Fenced
code, frontmatter machinery, Vue islands, and speaker-note markers are preserved as protected
skeleton, never emitted as translatable text.

**Why this priority**: Extraction is the riskiest unknown (lossless Slidev round-trip) and the
input to every other feature.

**Independent Test**: Property test — composing the extracted English units back into the
skeleton reproduces the source semantically losslessly; fences and Vue islands byte-identical.

**Acceptance Scenarios**:

1. **Given** a slide with two frontmatter blocks, a Vue component, an HTML-comment speaker note,
   and a fenced YAML block, **When** `extract` runs, **Then** only the prose paragraphs, heading,
   layout text fields (`kicker`, `heading`), and speaker-note prose become units, and
   re-composition reproduces the slide with fences byte-identical.
2. **Given** an English edit to one paragraph, **When** `extract` runs again, **Then** only that
   unit's source hash changes; its identity and all other units are untouched.
3. **Given** a slide moved to another file and reordered, **When** `extract` runs, **Then** every
   unit keeps its identity.

### Edge Cases

- Slides using `src:` includes or magic-move code blocks — protected skeleton, covered by hostile
  corpus fixtures.
- Prose containing literal `msgctxt`-hostile characters (quotes, newlines) — PO escaping is the
  catalog layer's job (spec 002), but extraction must not corrupt them.
- A quiz file matching neither consumer schema variant → hard error naming the manifest entry.
- Malicious content (script tags, path-traversal ids) → ids are validated against a safe charset;
  extraction never executes content.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `init-ids` MUST propose and insert explicit identities for slides, labs, and quiz
  questions, idempotently, changing nothing else.
- **FR-002**: `init-ids --check` MUST exit non-zero on missing or duplicate identities (CI lint).
- **FR-003**: `extract` MUST read the `workshop.yaml` manifest (versioned `apiVersion`; unknown
  major version → hard error).
- **FR-004**: `extract` MUST emit paragraph-granular units with markdown inline markup literal,
  each carrying `<surface>:<containerId>:<unitKey>` and a source hash.
- **FR-005**: Protected skeleton (fences, frontmatter machinery, Vue islands, includes) MUST never
  appear as translatable text and MUST survive round-trip byte-identically.
- **FR-006**: Extraction MUST be deterministic: identical tree → identical output.
- **FR-007**: Extraction MUST NOT execute any content or make network calls.

### Key Entities

- **Manifest**: `.localization/workshop.yaml` — declares surfaces, paths, protected terms, quiz
  schema variant.
- **TranslationUnit**: stable id + English source + source hash (packages/core).
- **Protected skeleton**: the non-translatable structure re-used verbatim at composition.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of slides/labs/quiz questions in both consumer golden corpora receive stable
  ids with a hand-reviewable diff.
- **SC-002**: Round-trip property holds over the full hostile corpus (both workshops) with zero
  byte-diff in protected skeleton.
- **SC-003**: The four round-trip property groups (losslessness, fence identity, identity
  stability under edit/move/reorder, determinism) run in CI on every change.

## Assumptions

- Both workshops accept a `slideId` frontmatter key (coordinated via their INBOX/ADR process).
- `@slidev/parser` handles both workshops' Slidev feature set; gaps become fixtures + upstream
  issues, not silent workarounds.
