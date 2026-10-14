/**
 * Likely secrets in files about to be published: one rule set for every Forge client. The
 * TypeScript twin of `crates/forge-secrets`, held equal by the vectors in
 * `forge-contracts/vectors/secret_scan/` (findings, severities, fingerprints, byte for byte).
 *
 * Pure: no I/O, no clock, no randomness. {@link scanFile} takes a path and bytes;
 * {@link scanUnread} a path and the git blob id of a file that was not read.
 *
 * Rules (severity): `env_file` (refuse), `envrc` (warn), `private_key` (refuse), `aws_key_pair`
 * (refuse), `github_token` (refuse), `gitlab_token` (refuse), `unverified_token` (warn), `wif`
 * (warn), `secret_assignment` (warn). A file over {@link MAX_SCAN_BYTES}, or with a NUL in its
 * first {@link BINARY_SNIFF_BYTES} bytes, is matched by name only.
 *
 * {@link verdict} warns instead of refusing for content rules under a test folder
 * ({@link TEST_DIRS}) and for anything in history; the `env_file` name rule is never downgraded by
 * a test folder. {@link decide} applies an {@link AllowList}: a listed fingerprint silences a
 * finding, a path glob only turns a refusal into a warning (`allowed_path`).
 *
 * A fingerprint is the first {@link FINGERPRINT_HEX} hex digits of
 * `SHA-256("forge-secrets/v1" 0x00 rule-id 0x00 path 0x00 material)`.
 */

export { AllowList, isFingerprint } from './allow'
export { githubChecksumOk, gitlabChecksumOk } from './content'
export { pathMatches } from './glob'
export { decide, fingerprint, gitBlobId, isEnvFileName, isScannable, isTestPath, scanFile, scanUnread, verdict } from './scan'
export {
  ALLOW_FILE,
  ALLOW_PUSH_OPTION,
  ASSIGNMENT_MAX_LEN,
  ASSIGNMENT_MIN_ENTROPY,
  ASSIGNMENT_MIN_LEN,
  AWS_ID_PREFIXES,
  BINARY_SNIFF_BYTES,
  ENV_TEMPLATE_SUFFIXES,
  FINGERPRINT_HEX,
  GITHUB_FINE_GRAINED_PREFIX,
  GITHUB_PREFIXES,
  GITLAB_PREFIXES,
  MAX_SCAN_BYTES,
  PEM_MAX_MARKERS,
  PEM_MIN_BODY,
  PLACEHOLDER_WORDS,
  RULES,
  SECRET_NAME_WORDS,
  TEST_DIRS,
  WIF_VERSIONS,
  describeRule,
  findingLocation,
  ruleFromId,
  ruleRefuses,
} from './types'
export type { Finding, Rule, Severity, Verdict, WarnReason } from './types'
