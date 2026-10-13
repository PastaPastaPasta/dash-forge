/**
 * Choosing a DPNS username (#452): what a typed name is, before anything is read or signed.
 *
 * The rules are Platform's (v5.0.0-beta.3, cited in gaps1 `dpns-research.md`):
 *   - a valid label is 3-63 characters, letters / digits / `-`, a letter or digit at each end and no
 *     `--` (`dash-platform-queries/src/dpns_usernames.rs` `is_valid_username`, lines 38-71: what the
 *     SDK and `dg auth name register` check; the contract's own pattern is the same less the `--`);
 *   - a name is CONTESTED when its homograph-safe form (`o`->`0`, `i`/`l`->`1`, lowercase) is 3-19
 *     characters of only `a-z`, `0`, `1` and `-` (same file, `is_contested_username`, lines 86-98;
 *     the contract's `parentNameAndLabel` index, `^[a-zA-Z01-]{3,19}$`). Such a name goes to a
 *     masternode vote: the registration pays the contest's fund (0.1 DASH from protocol 14) and the
 *     vote runs 2 weeks on mainnet, 90 minutes elsewhere (`dpp_voting_versions/v2.rs`).
 *
 * Like `dg`, the web does not enter contests: a contested name is explained and a variant that is
 * not contested is offered instead.
 */

import { ACTIVE_NETWORK, type NetworkConfig } from '../constants'
import { homographSafe } from './dpns'
import { dgNetworkFlags, shellWord } from './repo-commands'

/** What a typed name is. `label` is as typed (case kept: DPNS stores it), less `@` and `.dash`. */
export type UsernameCheck =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'contested'; readonly label: string }
  | { readonly kind: 'ok'; readonly label: string }

/** `input` without spaces around it, a leading `@` or a trailing `.dash` (any case). */
export function usernameLabel(input: string): string {
  return input.trim().replace(/^@/, '').replace(/\.dash$/i, '')
}

/** Why `label` cannot be a DPNS username, or null when it can. */
export function usernameProblem(label: string): string | null {
  if (label.length < 3) return 'At least 3 characters.'
  if (label.length > 63) return 'At most 63 characters.'
  if (!/^[A-Za-z0-9-]+$/.test(label)) return label.includes('.') ? 'No dots: the name is the part before .dash.' : 'Only letters a–z, digits and “-”.'
  if (label.startsWith('-') || label.endsWith('-')) return 'Starts and ends with a letter or a digit.'
  if (label.includes('--')) return 'No two “-” in a row.'
  return null
}

/** Whether a valid `label` goes to a masternode vote (see the header). */
export function isContestedUsername(label: string): boolean {
  const normalized = homographSafe(label)
  return normalized.length >= 3 && normalized.length <= 19 && /^[a-z01-]+$/.test(normalized)
}

/** What the typed `input` is (see {@link UsernameCheck}). */
export function checkUsername(input: string): UsernameCheck {
  const label = usernameLabel(input)
  if (label === '') return { kind: 'empty' }
  const reason = usernameProblem(label)
  if (reason !== null) return { kind: 'invalid', reason }
  return isContestedUsername(label) ? { kind: 'contested', label } : { kind: 'ok', label }
}

/**
 * Names close to a contested `label` that are not contested: a digit other than 0 or 1 takes a
 * name out of the vote's `a-z 0 1 -` alphabet. Each is a valid label (a contested one is at most
 * 19 characters, so one more fits).
 */
export function uncontestedVariants(label: string): string[] {
  return ['2', '7', '42'].map((d) => `${label}${d}`).filter((v) => usernameProblem(v) === null && !isContestedUsername(v))
}

/**
 * The `dg` command that registers `label` (`crates/dg/src/auth/mod.rs` `NameCommand::Register`:
 * `--master <file>` is the identity file; without it `dg` asks for the recovery phrase), with this
 * build's network flags, as the repository page's commands carry them.
 */
export function nameRegisterCommand(label: string, config: NetworkConfig = ACTIVE_NETWORK): string {
  return `dg auth name register ${label === '' ? '<name>' : shellWord(label)} --master <identity file> ${dgNetworkFlags(config)}`
}
