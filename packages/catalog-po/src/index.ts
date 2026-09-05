/**
 * `@workshop-i18n/catalog-po` — gettext PO as the working exchange format (ADR 0004),
 * with the codec owned rather than depended on (ADR 0013).
 *
 * The codec is the gettext format and nothing else: total on read, lossless on
 * constructs it does not interpret, and deterministic on write so a no-change run is a
 * zero-byte diff (spec 002 FR-005, SC-002).
 */

export { type PoLocation, PoSyntaxError, UnsupportedPoError } from './errors.js'
export { type ParsePoOptions, parsePo } from './parse.js'
export {
  isHeaderEntry,
  type PoComment,
  type PoEntry,
  type PoFile,
  type PoPrevious,
} from './po-file.js'
export { serializePo } from './serialize.js'
