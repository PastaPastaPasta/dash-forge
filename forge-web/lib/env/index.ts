/**
 * Environments (mixed-visibility design §4.5, D9, D24): per-environment configuration and
 * secrets kept outside git, one kind-8 `packManifest` snapshot per change. This module is the
 * codec the web reads and writes them with: the artifact ({@link encodeSnapshot},
 * {@link decodeSnapshot}), opening one snapshot with D24's checks ({@link openSnapshot}),
 * authorization, the chain and fork detection ({@link resolveSnapshots}), and the removal
 * checklist ({@link exposureOf}). The Rust twin is `crates/forge-core/src/env/`; the
 * `env_snapshot__*` vectors hold the two equal. No UI here.
 */

export {
  ACCESS_SENTENCE,
  BUCKET,
  MAX_RECIPIENTS,
  MAX_RECIPIENTS_V1,
  MAX_SNAPSHOT,
  OLD_FORMAT_HISTORY_SENTENCE,
  OLD_FORMAT_SENTENCE,
  SnapshotTooLargeError,
  audienceLabel,
  decodeSnapshot,
  diffSnapshots,
  encodeSnapshot,
  groupLabel,
  membersKey,
  snapshotProblem,
  validEnvName,
  validVarName,
  type Audience,
  type Change,
  type EnvVar,
  type Group,
  type Snapshot,
  type VarType,
} from './format'
export {
  SnapshotOpenError,
  openErrorReason,
  openSnapshot,
  recipientsMatch,
  sealLetterSnapshot,
  sealOldMembersSnapshotForVectors,
  type ManifestCheck,
  type OpenErrorCode,
  type OpenKeys,
} from './codec'
export {
  MAX_SUPERSEDES,
  changedEnvironments,
  exposureOf,
  resolveSnapshots,
  supersedesWindow,
  type EnvHistory,
  type EnvState,
  type EnvStateKind,
  type Exposure,
  type HiddenEnv,
  type Ignored,
  type IgnoredReason,
  type Resolution,
  type SnapshotRef,
} from './chain'
