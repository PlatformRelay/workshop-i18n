# Feature Specification: Zero-code Weblate onboarding and pt-BR seed harvest

**Feature Branch**: `004-weblate-file-integration-seed`

**Created**: 2026-08-15

**Status**: Draft

**Input**: Documented, reproducible Weblate configuration consuming committed PO files via git
(review workflow on, glossary from the manifest's protected terms), plus `seed --from <tree>`
aligning an existing translated parallel tree (Kubernetes-Workshop PR #55, pt-BR) into
needs-review entries. (ADRs 0002, 0004, 0006, 0009; constitution V, VI.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Harvest the existing pt-BR translation (Priority: P1)

A maintainer runs `workshop-i18n seed --locale pt-BR --from <path-to-translated-tree>`. The tool
aligns the translated parallel tree against the English sources by slide/unit structure and fills
the pt-BR catalog with matched strings in **needs-review** state, reporting match/miss counts per
section. The contributor's work is honored instead of discarded.

**Why this priority**: PR #55 is a free, real translation corpus and the project's strongest
goodwill asset; it also gives every later feature a realistic non-German test locale.

**Independent Test**: Seed against a fixture snapshot of the pt-BR tree; alignment report matches
golden counts; no entry enters as reviewed.

**Acceptance Scenarios**:

1. **Given** a translated slide structurally matching its English source, **When** seed runs,
   **Then** its prose units land as needs-review with provenance noting the seed source.
2. **Given** a translated slide that diverged structurally, **When** seed runs, **Then** unmatched
   units stay missing and the slide is listed in the miss report — never guessed.
3. **Given** a seeded catalog, **When** seed re-runs, **Then** human-touched entries are never
   overwritten.

### User Story 2 - Volunteer translates in Weblate (Priority: P2)

Following `docs/weblate.md`, a maintainer creates a Weblate project pointed at the consumer repo's
PO files (git integration, review workflow enabled, glossary preloaded from the manifest's
protected terms). A volunteer translates one section; Weblate pushes a branch/MR; the resulting PR
passes `verify` and composes a valid deck.

**Why this priority**: Proves the buy-not-build boundary (ADR 0002) end-to-end with zero adapter
code; unblocks real translators.

**Independent Test**: Documented walkthrough executed once against a sandbox Weblate instance and
recorded; CI-side effects (PR gates) covered by fixtures independently.

**Acceptance Scenarios**:

1. **Given** the documented configuration, **When** a translator edits a unit containing a
   protected term, **Then** Weblate surfaces the glossary term, and if it is altered in the
   target, `verify` on the PR fails naming the term.
2. **Given** a reviewed unit in Weblate, **When** the change lands, **Then** `status` counts it
   as reviewed without manual state fixing.

### Edge Cases

- Weblate's PO review-flag conventions differ from expectation → verified against fixtures; the
  mapping is recorded in `docs/weblate.md` (this is the spike ADR 0004 demands, not an assumption).
- Seed source uses different slide ordering → alignment is id/structure-based, order-independent
  where possible; ambiguity → miss, never guess.
- Two Weblate components writing the same file → configuration forbids it; documented.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `seed` MUST align by container structure + unit position within matched containers,
  MUST mark all seeded entries needs-review with provenance, and MUST never overwrite
  human-touched entries.
- **FR-002**: `seed` MUST emit a per-section match/miss report (human + JSON).
- **FR-003**: `docs/weblate.md` MUST make the Weblate setup reproducible: project/component
  settings, git integration mode, review workflow, glossary import from the manifest.
- **FR-004**: The TMS port contract (`packages/tms-contract`) MUST be exercised by its fake-backed
  conformance kit in CI, documenting the file-based path as the reference implementation.

### Key Entities

- **Seed alignment**: mapping from a translated parallel tree to unit ids with confidence
  (matched / ambiguous / missed).
- **Weblate configuration**: documented settings, not code.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: ≥60% of the pt-BR tree's prose units land as pre-seeded needs-review suggestions on
  the k8s corpus.
- **SC-002**: A volunteer completes one section end-to-end in Weblate and the resulting PR
  composes a valid pt-BR deck with no maintainer hand-editing of catalogs.
- **SC-003**: Zero adapter code exists at the end of this feature (the port contract has only the
  fake), per ADR 0006.

## Assumptions

- The pt-BR PR author is credited in the seeded catalogs' provenance and changelog (their PR can
  then be closed with thanks and a pointer — handled in the consumer repo).
- A sandbox Weblate (hosted free tier or docker-compose) is available for the one-time
  walkthrough.
