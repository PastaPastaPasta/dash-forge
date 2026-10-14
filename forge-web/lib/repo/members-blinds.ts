/**
 * A members reader's blinds (`docs/security/private-repos.md` §19.1, §19.4; mixed-visibility DESIGN
 * §4.4): every verified pair of a blind and the real commit it hides, learned from the members-only
 * documents this reader opened (ref updates, pull requests, head updates), per members-key session.
 *
 * Folds keep comparing blinds as written (a PR's head, reviews and check runs); the real commit is
 * for git only: the diff, the browse plane, a merge. A blind whose check failed is never learned,
 * so no real value is trusted for it. Lives with the session that opened the documents: a lock or a
 * key change drops it with the session's context.
 */

import { bytesToHex, checkBlind, type OpenContext } from '../private'

/** What introduced a commit's blind: the bytes and the salt every later field naming it copies (rule C). */
export interface Introduced {
  readonly blind: Uint8Array
  readonly salt: Uint8Array
}

/** One session's blinds. */
export class BlindBook {
  private readonly real = new Map<string, string>()
  private readonly intro = new Map<string, Introduced>()

  /** Learn (`plain`, `real`) when `plain` checks as the blind of `real` under `salt`. Returns whether it checked. */
  async learn(plain: Uint8Array, real: Uint8Array | undefined, salt: Uint8Array | undefined): Promise<boolean> {
    if (real === undefined || salt === undefined || (await checkBlind(plain, real, salt)) !== 'ok') return false
    this.real.set(bytesToHex(plain), bytesToHex(real))
    return true
  }

  /**
   * Record that branch `name`'s tip, the real commit `realHex`, was pushed by a ref update whose
   * verified blind and salt are `intro`: a new PR from that branch copies them (rule C).
   */
  introduce(name: string, realHex: string, intro: Introduced): void {
    this.intro.set(`${name}\0${realHex.toLowerCase()}`, intro)
  }

  /** The real commit behind the blind `hex`, if a verified document named it. */
  realOf(hex: string): string | undefined {
    return this.real.get(hex.toLowerCase())
  }

  /** The blind and salt of the members-only ref update that pushed branch `name`'s tip, the real commit `hex`. */
  introduced(name: string, hex: string): Introduced | undefined {
    return this.intro.get(`${name}\0${hex.toLowerCase()}`)
  }
}

const books = new WeakMap<OpenContext, BlindBook>()

/** The blinds learned under the members-key context `ctx` (a session's `ctx`). */
export function blindBook(ctx: OpenContext): BlindBook {
  let book = books.get(ctx)
  if (book === undefined) {
    book = new BlindBook()
    books.set(ctx, book)
  }
  return book
}
