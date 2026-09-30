/**
 * Retrying a write that a total-reading rule refused because the node judged it a block behind.
 *
 * `propertyConstraints` rules that read a `countOf` / `sumOf` total (RC1: `platformChunks`,
 * `dense`, `oneLive`, …) are judged against the validating node's state. A write sent right
 * after the writes it depends on (a pack manifest right after its chunks) can meet a node that
 * has not applied them yet and be refused with 10422, though the same write passes a block
 * later (seen while seeding bonsia). Such a refusal is retried after about a block, with a
 * bounded backoff; any other error, or the same refusal after the last wait, is the caller's.
 */

import { sleep } from '../sdk/facade'
import { ConsensusRefusal, RULE_REFUSED_CODE } from '../sdk'
import { refusedRule } from '../rules/transition'

/** The waits before each retry: about a block, then two more at doubling length (~28 s in all). */
export const LAG_RETRY_MS: readonly number[] = [4_000, 8_000, 16_000]

/** Whether `e` is a 10422 refusal by one of `rules`. */
export function isRuleRefusal(e: unknown, rules: ReadonlySet<string>): boolean {
  return e instanceof ConsensusRefusal && e.code === RULE_REFUSED_CODE && rules.has(refusedRule(e.message) ?? '')
}

/**
 * Run `write`; while it is refused by one of `rules` (a node a block behind the writes it
 * reads), wait out the next of `delays` and run it again. `write` is called afresh each time, so
 * it can re-read what it depends on first.
 */
export async function retryAfterLag<T>(write: () => Promise<T>, rules: ReadonlySet<string>, delays: readonly number[] = LAG_RETRY_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write()
    } catch (e) {
      const wait = delays[attempt]
      if (wait === undefined || !isRuleRefusal(e, rules)) throw e
      await sleep(wait)
    }
  }
}
