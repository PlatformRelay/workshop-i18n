/**
 * `@workshop-i18n/catalog-po` — gettext PO as the working exchange format (ADR 0004),
 * with the codec owned rather than depended on (ADR 0013).
 *
 * Three layers, smallest first:
 *
 * 1. **The codec** (`parsePo`/`serializePo`) — the gettext format and nothing else:
 *    total on read, lossless on constructs it does not interpret, and deterministic on
 *    write so a no-change run is a zero-byte diff (spec 002 FR-005, SC-002).
 * 2. **The catalog** (`parseCatalog`/`serializeCatalog`) — this tool's conventions on top
 *    of it: `msgctxt` is the stable unit id, `#.` carries source reference and source
 *    hash, `#~` preserves work for units that left the English source.
 * 3. **The update algorithm** (`updateCatalog`) — spec 002 User Story 1.
 *
 * The gettext to `UnitState` mapping lives here rather than in `packages/core`, so core
 * stays free of a format dependency. It maps *state only*: requiredness is an operator
 * decision and can never be derived from catalog content (constitution V) — see
 * `state.ts` for the constraint in full.
 *
 * Catalog identity is a parameter, never a path this package invents.
 */

export {
  type Catalog,
  type CatalogEntry,
  CatalogError,
  type CatalogIdentity,
  catalogStatuses,
  DuplicateCatalogEntryError,
  emptyCatalog,
  parseCatalog,
  type ReadCatalogOptions,
  readCatalog,
  serializeCatalog,
  toCatalogEntry,
} from './catalog.js'

export { type PoLocation, PoSyntaxError, UnsupportedPoError } from './errors.js'
export { type ParsePoOptions, parsePo } from './parse.js'
export {
  isHeaderEntry,
  type PoComment,
  type PoEntry,
  type PoFile,
  type PoPrevious,
} from './po-file.js'
export {
  HASH_COMMENT_KEY,
  type Provenance,
  readProvenance,
  SOURCE_COMMENT_KEY,
} from './provenance.js'
export { serializePo } from './serialize.js'
export { FUZZY_FLAG, NEEDS_REVIEW_FLAG, unitStateOf } from './state.js'
export {
  applyDraftTranslation,
  type ExtractedUnit,
  isDraftable,
  type UpdateCatalogOptions,
  type UpdateResult,
  type UpdateSummary,
  updateCatalog,
} from './update.js'
