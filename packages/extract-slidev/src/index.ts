/**
 * Lossless extraction and composition for Slidev decks (spec 001, ADR 0012).
 *
 * Extraction **locates**; it never re-serializes. It returns the original file text plus
 * the half-open ranges of the prose inside it, and `composeSkeleton` splices
 * translations back into those ranges. Everything else — fences, frontmatter machinery,
 * Vue islands, `src:` includes, image references, HTML — is copied byte-for-byte, so
 * composing a skeleton with an empty catalog reproduces the source exactly.
 *
 * Pure and offline: no `node:fs`, no network, and consumer content is never executed.
 * Reading files is the CLI's job (constitution IV).
 */

export {
  type FrontmatterBlock,
  parseSlidevDeck,
  type SlideRange,
  type SlidevDeck,
} from './deck.js'
export {
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
  hasErrors,
} from './diagnostic.js'
export {
  locateProse,
  type ProseLocation,
  type ProseOptions,
  type ProseSpan,
} from './prose.js'
export {
  CompositionError,
  type CompositionIssue,
  composeSkeleton,
  createSkeleton,
  type Hole,
  type HoleContext,
  type HoleEncoding,
  type ReplacementRejection,
  type Skeleton,
  SkeletonError,
  skeletonUnits,
  stripContinuationPrefix,
  type TranslationLookup,
} from './skeleton.js'
export { decodeSource, type Position, positionAt, SourceDecodeError } from './source.js'
