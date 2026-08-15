# Feature Specification: Locale composition with governed overrides and gates

**Feature Branch**: `003-compose-overrides-gates`

**Created**: 2026-08-15

**Status**: Draft

**Input**: `compose --locale <l>` generates a runnable locale tree; override files replace/split
slides anchored to a source revision; `verify` gates fence identity, protected terms, and length
budgets; `--strict` fails closed. (ADRs 0007, 0008, 0009; constitution I, III, V.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Compose a locale deck (Priority: P1)

A maintainer runs `workshop-i18n compose --locale de`. The tool merges the protected skeleton with
the German catalog and emits a generated locale tree that Slidev builds and exports unchanged.
Missing/fuzzy units render as visibly watermarked English fallback in default (preview) mode.

**Why this priority**: The first German deck a facilitator can open is the product's first real
value.

**Independent Test**: Compose the hostile corpus for `de` and `pt-BR`; the output builds with
Slidev in CI; fences byte-identical to English.

**Acceptance Scenarios**:

1. **Given** a fully reviewed section, **When** `compose --locale de` runs, **Then** the generated
   section renders German prose with all code fences byte-identical to English.
2. **Given** a fuzzy unit, **When** default compose runs, **Then** the English text appears with a
   visible fallback watermark; **When** `compose --strict` runs, **Then** the command fails
   listing that unit.

### User Story 2 - Override and split a crowded slide (Priority: P2)

German prose overflows a tight statement slide. A reviewer writes
`i18n/de/overrides/<slideId>.md` containing two replacement slides. `compose` substitutes them;
when the English source slide later changes, `status` reports the override as stale and `--strict`
compose fails until a human re-anchors it.

**Why this priority**: Overflow handling (goal 6) is what separates this design from plain string
substitution; it is also the pt-BR PR's structural lesson.

**Independent Test**: Fixture with a real split; deterministic composition; hash-invalidation
scenario covered by golden test.

**Acceptance Scenarios**:

1. **Given** an override with two slides, **When** compose runs, **Then** the English slide is
   replaced by both, in order, with new slide ids minted per ADR 0008.
2. **Given** the English slide's content changes, **When** `status` runs, **Then** the override is
   reported stale (anchored hash mismatch) and strict compose fails.
3. **Given** an override whose fenced code differs from the English slide's fences, **When**
   `verify` runs, **Then** it fails naming the fence.

### Edge Cases

- Override referencing a nonexistent `slideId` → hard error.
- Override chains (override of a split fragment) → out of scope v1, rejected with a clear error.
- Length-budget heuristic on layouts with no budget configured → skipped, reported as uncovered.
- RTL locales, CJK line-length semantics → explicitly out of scope for v1 budgets (assumption).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `compose` MUST produce a locale tree that the consumer's Slidev build accepts
  without modification (labs and quiz composed analogously).
- **FR-002**: Generated output MUST carry a "generated — do not edit" banner and MUST be fully
  reproducible from sources + catalogs + overrides.
- **FR-003**: Overrides MUST be revision-anchored (`sourceSlideHash`) and invalidated wholesale on
  source change.
- **FR-004**: `verify` MUST enforce: fence/command byte-identity, protected-term integrity
  (glossary from the manifest), and length-budget heuristics per configured layout.
- **FR-005**: `--strict` MUST fail on any fuzzy/missing/needs-review required unit or stale
  override (release mode); default mode MUST watermark fallback visibly.
- **FR-006**: All gates MUST be deterministic and run offline.

### Key Entities

- **Composition**: skeleton × catalog × overrides → locale tree.
- **Override**: 1..n replacement slides + anchor hash + minted ids.
- **Gate result**: machine-readable findings at slide/unit coordinates.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A real German split of one crowded slide from the k8s corpus builds and exports via
  Slidev in CI (the origin pack's "hostile section" success loop, steps 4–7, minus TMS).
- **SC-002**: Fence-identity gate catches 100% of seeded fence mutations in adversarial fixtures.
- **SC-003**: `compose --strict` on a locale passing `status --policy release` never fails
  (policy/gate consistency).

## Assumptions

- Consumer decks build from a generated sibling tree (e.g. `pages-de/` or dist-level), decided
  with consumers during plan; the tool does not require committing generated output.
- Length budgets start as ratio heuristics (e.g. de/en > 1.35 on constrained layouts); rendered
  visual QA stays deferred per ADR 0009.
