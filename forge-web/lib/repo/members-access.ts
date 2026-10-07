/**
 * How a signed-in viewer reads a public repo's members-only content (DESIGN §4.1, §12 item 6):
 * the decision `usePrivateHome` takes, apart from React and the SDK so it can be tested.
 *
 * - A current member: `none` (nothing turned on), `no-key`, `locked`, `no-key-shared` (E311), or
 *   `member` with their members-key session.
 * - Anyone else who holds key shares of the repo (a member removed since): `former` with the same
 *   kind of session, which opens what was written under the epochs they held and leaves later
 *   writing as placeholders, as `dg` reads. Writes still need a current membership.
 * - Anyone else: no lane at all (null), exactly what an outsider reads. A repo without members-only
 *   content costs a non-member no read here: its config timeline, read with the page, already
 *   said so (`repoHasMembersKey`'s cache).
 */

import { base58Encode } from '../auth/base58'
import type { MembersAccess } from '../view/repo-view'
import type { PrivateSession } from './private-session'

/** What {@link membersAccessOf} reads, each only when it needs it. */
export interface MembersAccessSource<Ops> {
  /** The viewer's identity id. */
  readonly identity: string
  /** Whether the viewer is a current member of the repo. */
  readonly isMember: boolean
  /** Whether the repo has a members key (members-only content turned on). */
  readonly hasMembersKey: () => Promise<boolean>
  /** This browser's encryption-key operations for the viewer, or null (no key here). */
  readonly ops: () => Promise<Ops | null>
  /** Whether the tab holds only the signing key (unlock to use the encryption key). */
  readonly locked: () => boolean
  /** The viewer's members-key session, opened with `ops`. */
  readonly session: (ops: Ops) => Promise<PrivateSession>
  /**
   * Whether a key share of the repo is addressed to the viewer (one read; the shares name their
   * recipient in plaintext). Asked only of a non-member whose tab is locked: a member removed
   * since is then offered the unlock, as a member is.
   */
  readonly holdsShare: () => Promise<boolean>
}

/** The viewer's members access, or null: none at all (an outsider's view). */
export async function membersAccessOf<Ops>(src: MembersAccessSource<Ops>): Promise<MembersAccess | null> {
  if (!(await src.hasMembersKey())) return src.isMember ? { access: 'none' } : null
  const ops = await src.ops()
  if (ops === null) return src.isMember ? { access: 'no-key' } : null
  if (src.locked()) return src.isMember || (await src.holdsShare()) ? { access: 'locked' } : null
  const session = await src.session(ops)
  const opens = session.resolution.keys.size > 0
  if (!src.isMember) return opens ? { access: 'former', session } : null
  if (opens) return { access: 'member', session }
  // E311: a member nobody has shared the key with yet (added by an older client). No key, no
  // wrap to them: a maintainer's Repair (the repair check) shares it.
  const mine = session.wraps.some((w) => base58Encode(w.row.memberId) === src.identity)
  // Shared with them, and still nothing opens: this browser holds another encryption key than
  // the one it was shared to (a wallet's, while theirs is held elsewhere).
  return { access: mine ? 'no-key' : 'no-key-shared' }
}
