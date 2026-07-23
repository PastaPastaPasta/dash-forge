/**
 * Browse-plane reader — the zero-materialization, size-independent object layer.
 *
 * Read-side ports of `crates/forge-core/src/pack/{locator,flatindex,parse}.rs`, enough to:
 *   - parse an objectLocator (fanout + fixed-stride rows) and look up any OID
 *   - parse a flatIndex (list a dir / look up a path) for full-tree browsing
 *   - fetch a pack byte range and reconstruct a git blob/tree/commit (zlib inflate +
 *     OFS/REF delta apply), single-span for blobs, per-base walk for deep-delta trees
 *
 * This is what makes browsing a repo of ANY size cost O(view) bytes, not O(repo).
 */

export {
  FANOUT_LEN,
  LOCATOR_ROW_LEN,
  OID_LEN,
  ObjectLocator,
  SPAN_SENTINEL,
  SPAN_SINGLE_READ_THRESHOLD,
  lookupRanged,
  singleReadAdvised,
  type LocatorEntry,
  type RangeFetch,
} from './locator'
export {
  FlatIndex,
  MODE_GITLINK,
  MODE_TREE,
  type FlatEntry,
} from './flatindex'
export {
  PACK_TYPE,
  applyDelta,
  gitOidHex,
  inflateZlib,
  objTypeFromCode,
  parseObjHeader,
  parseOfsBase,
  reconstructFromSpan,
  type GitObject,
  type GitObjType,
} from './pack'
export { BrowseReader, type BrowseReaderOptions, type PackSource } from './reader'
