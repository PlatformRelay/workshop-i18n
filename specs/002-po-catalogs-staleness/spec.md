# Feature Specification: PO catalogs with automatic stale tracking

**Feature Branch**: `002-po-catalogs-staleness`

**Created**: 2026-08-15

**Status**: Draft

**Input**: `extract` writes/updates `i18n/<locale>/*.po` with `msgctxt` = unit id and source-hash
provenance; an English edit marks exactly the affected entries fuzzy; `status` reports per
locale/section and enforces policy via exit code. (ADRs 0004, 0005, 0009; constitution II, IV, V.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Catalog update on English change (Priority: P1)

An author merges an English edit. The next `extract` updates the locale catalogs: the affected
entries become fuzzy with previous-source retained (`#| msgid`), untouched entries keep their
review state, removed units become obsolete entries, and new units appear as missing.

**Why this priority**: Automatic staleness (goal 4) is the core promise; silent drift is the
failure the whole tool exists to prevent.

**Independent Test**: Golden scenario — one paragraph edited in a fixture workshop; exactly one
entry per locale flips to fuzzy; a re-run without changes is a no-op (idempotent, deterministic
file output, stable ordering → clean diffs).

**Acceptance Scenarios**:

1. **Given** a reviewed German entry, **When** its English source changes, **Then** the entry is
   fuzzy with previous source recorded, and no other entry changes state.
2. **Given** an English slide is deleted, **When** `extract` runs, **Then** its entries become
   obsolete (`#~`) — translation work is preserved, not destroyed.
3. **Given** no English change, **When** `extract` runs twice, **Then** the catalogs are
   byte-identical (no timestamp churn).

### User Story 2 - Staleness report and policy gate (Priority: P2)

A maintainer runs `workshop-i18n status`. It reports, per locale and per section: reviewed, fuzzy,
needs-review, missing counts, override staleness (spec 003), and totals — human-readable and
`--json`. With `--policy` thresholds (e.g. release requires zero fuzzy/missing), it exits non-zero
for CI.

**Why this priority**: The review queue must be visible before translators are invited; it is
also the release gate's data source.

**Independent Test**: Fixture catalogs in known mixed states produce an exact expected report and
exit codes under different policies.

**Acceptance Scenarios**:

1. **Given** a locale with 3 fuzzy entries, **When** `status --policy release` runs, **Then** exit
   code is non-zero and the three unit ids are listed with their sections.
2. **Given** a fully reviewed locale, **When** `status --policy release` runs, **Then** exit code
   is zero.

### Edge Cases

- Hand-edited catalog with broken syntax → hard error with file/line, never silent re-write.
- Unit id collisions after a bad manual edit → error naming both entries.
- Locale catalog for a locale not in the manifest → warning, excluded from policy.
- Merge conflicts in PO files → documented resolution guidance (stable ordering minimizes them).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Catalog writes MUST preserve translator-owned fields (translations, comments,
  review state) for untouched units.
- **FR-002**: `msgctxt` MUST be the stable unit id; extracted comments MUST carry source
  reference and source hash.
- **FR-003**: Source change MUST set fuzzy + previous-source on exactly the affected entries.
- **FR-004**: Removed units MUST become obsolete entries, never be deleted outright.
- **FR-005**: Output MUST be deterministic and stably ordered (clean git diffs).
- **FR-006**: `status` MUST report per locale × section × state, in human and JSON form, and
  enforce named policies via exit code.
- **FR-007**: Seeded or machine-drafted entries MUST enter as needs-review, distinguishable from
  human-reviewed entries (constitution V).

### Key Entities

- **Catalog**: `i18n/<locale>/<surface-or-section>.po`.
- **Entry state mapping**: gettext (untranslated / fuzzy / translated ± needs-review flag) ↔ core
  `UnitState`.
- **Policy**: named thresholds over state counts (`release`, `preview`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The "invalidate exactly the affected approvals after an English edit" scenario from
  the origin pack passes against the file backend.
- **SC-002**: A no-change `extract` produces a zero-byte diff across all catalogs.
- **SC-003**: `status --json` output is stable enough to drive both workshops' CI badges/reports
  without post-processing.

## Assumptions

- Catalogs are split per surface or section (decided in plan phase) — bounded file sizes for TMS
  and review ergonomics.
- Weblate's PO handling (review flag conventions) is verified against a fixture during spec 004,
  not assumed here.
