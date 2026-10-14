/**
 * The secret-scan rule set's constants and types: the TypeScript twin of `crates/forge-secrets`
 * (`src/lib.rs`). Every client runs the same rules; the `forge-contracts/vectors/secret_scan/`
 * vectors hold the two ports equal, findings, severities and fingerprints byte for byte. The
 * thresholds and word lists below are data copied from the crate, with the same meaning.
 */

/** Files larger than this are matched by name only. */
export const MAX_SCAN_BYTES = 1 << 20
/** A NUL byte this early marks a binary file: matched by name only. */
export const BINARY_SNIFF_BYTES = 8000
/** Hex digits in a fingerprint. */
export const FINGERPRINT_HEX = 12
/** Folders whose content findings warn instead of refusing (any folder of the path, exact name). */
export const TEST_DIRS: readonly string[] = ['test', 'tests', 'testdata', 'fixtures']
/** `.env.<name>` files with these endings are templates, not secrets. */
export const ENV_TEMPLATE_SUFFIXES: readonly string[] = ['.example', '.sample', '.template']
/** The committed allow file, at the root of a pushed branch or tag. */
export const ALLOW_FILE = '.forge/secret-scan-allow'
/** The push option that adds fingerprints for one push: `-o allow-secret=<fingerprint>`. */
export const ALLOW_PUSH_OPTION = 'allow-secret'
/** Fewest base64 characters in a PEM body for it to be a key. */
export const PEM_MIN_BODY = 64
/** `-----BEGIN ` markers examined per file at most (a file of thousands of markers stays cheap). */
export const PEM_MAX_MARKERS = 64
/** WIF version bytes: Bitcoin mainnet (0x80), Dash mainnet (0xCC), testnet and regtest (0xEF). */
export const WIF_VERSIONS: readonly number[] = [0x80, 0xcc, 0xef]
/** GitHub token prefixes whose last six characters are a CRC32 checksum. */
export const GITHUB_PREFIXES: readonly string[] = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']
/** GitHub's fine-grained personal access token prefix (no published checksum). */
export const GITHUB_FINE_GRAINED_PREFIX = 'github_pat_'
/** GitLab token prefixes checked for the routable format. */
export const GITLAB_PREFIXES: readonly string[] = [
  'glpat-',
  'glrt-',
  'glcbt-',
  'gldt-',
  'glptt-',
  'glft-',
  'glimt-',
  'glagent-',
  'glsoat-',
  'gloas-',
]
/** AWS access key id prefixes (`A3T` takes one more character of the id alphabet). */
export const AWS_ID_PREFIXES: readonly string[] = ['AKIA', 'ASIA', 'ABIA', 'ACCA', 'A3T']
/** Words that make a setting's name secret-like (matched in its lower-cased name). */
export const SECRET_NAME_WORDS: readonly string[] = [
  'secret',
  'token',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'api-key',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'auth_key',
  'credential',
]
/** Values containing one of these (lower-cased) are placeholders. */
export const PLACEHOLDER_WORDS: readonly string[] = [
  'example',
  'changeme',
  'change_me',
  'placeholder',
  'xxxx',
  'your_',
  'your-',
  '${',
  '<',
]
/** Shortest value a `secret_assignment` reports. */
export const ASSIGNMENT_MIN_LEN = 16
/** Longest value a `secret_assignment` reports. */
export const ASSIGNMENT_MAX_LEN = 256
/** Fewest bits of Shannon entropy per character for a `secret_assignment`. */
export const ASSIGNMENT_MIN_ENTROPY = 3.5

/** The rule ids, in report order (the order findings sort by). */
export const RULES = [
  'env_file',
  'envrc',
  'private_key',
  'aws_key_pair',
  'github_token',
  'gitlab_token',
  'unverified_token',
  'wif',
  'secret_assignment',
] as const

/** One rule of the set; the string is the stable id used in vectors and fingerprints. */
export type Rule = (typeof RULES)[number]

/** The rule with id `id`, or `null`. */
export function ruleFromId(id: string): Rule | null {
  return RULES.find((r) => r === id) ?? null
}

/** Whether a finding of `rule` refuses a push (before `verdict`'s exceptions). */
export function ruleRefuses(rule: Rule): boolean {
  return (
    rule === 'env_file' ||
    rule === 'private_key' ||
    rule === 'aws_key_pair' ||
    rule === 'github_token' ||
    rule === 'gitlab_token'
  )
}

const DESCRIPTIONS: Readonly<Record<Rule, string>> = {
  env_file: 'looks like a secret file',
  envrc: 'is a direnv file that sets variables',
  private_key: 'holds a private key',
  aws_key_pair: 'holds an AWS access key and its secret',
  github_token: 'holds a GitHub token',
  gitlab_token: 'holds a GitLab token',
  unverified_token: 'holds what looks like a GitHub or GitLab token',
  wif: 'holds what looks like a Dash or Bitcoin private key',
  secret_assignment: 'sets a secret-named value to a random-looking string',
}

/** What the file holds, as the end of a sentence about it ("`.env` looks like a secret file"). */
export function describeRule(rule: Rule): string {
  return DESCRIPTIONS[rule]
}

/** One likely secret in one file. */
export interface Finding {
  readonly rule: Rule
  /** The file's path in the tree, `/`-separated. */
  readonly path: string
  /** The 1-based line of the match; `null` for a whole-file rule. */
  readonly line: number | null
  /** Stable short id of this secret in this file. */
  readonly fingerprint: string
}

/** `path` or `path line N`. */
export function findingLocation(f: Finding): string {
  return f.line === null ? f.path : `${f.path} line ${f.line}`
}

/** What a finding does to a push. */
export type Severity = 'refuse' | 'warn'

/** Why a finding only warns. */
export type WarnReason = 'rule' | 'test_path' | 'history' | 'allowed_path'

/** A finding's severity, and the reason when it only warns (`null` when it refuses). */
export interface Verdict {
  readonly severity: Severity
  readonly reason: WarnReason | null
}
