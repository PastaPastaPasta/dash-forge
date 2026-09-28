/**
 * dashpay/platform#5053 (4.2.0-beta.6) restored the 4.1 order of `BasicError`, which bincode
 * encodes by position: `InvalidTokenDistributionEpochIntervalTooShortError` had been inserted at
 * position 140 and now sits at the end. The wasm-sdk this app pins (4.2.0-beta.5, like beta.4)
 * still has the shifted order, so it decodes positions 140–199 of an error from a beta.6 node
 * (moutai), and positions 140–172 from a 4.1 node (testnet, mainnet), one variant off.
 *
 * Only a refusal at the broadcast check reaches the browser this way: the SDK decodes the
 * node's serialized error into its own text, and the wasm error's `code` is -1. The result
 * wait's verdict carries the node's own numeric code, which is right. The protocol version
 * cannot tell the orders apart (beta.5 and beta.6 both run protocol 14), and every network
 * this app talks to uses the restored order, so the remap is keyed on the SDK: it applies only
 * while {@link PINNED_WASM_SDK} is exactly 4.2.0-beta.5, the version the table was measured
 * against. A node still on 4.2.0-beta.5 (or an earlier 4.2 beta) would share the SDK's order,
 * and the remap would then mislabel its refusals; no network this app reads runs one (moutai is
 * on beta.6, testnet and mainnet on 4.1).
 *
 * The table is generated from `packages/rs-dpp/src/errors/consensus/basic/basic_error.rs` at
 * v4.2.0-beta.5 and v4.2.0-beta.6 with `codes.rs` (the two positions without a code are left
 * out). Measured with the beta.6 serializer and the beta.5 wasm decoder: a 10422 arrives as the
 * 10421 text, a 10421 as the 11001 text, a 10419 as the 10904 text.
 *
 * Remove this module when forge-web moves to wasm-sdk >= 4.2.0-beta.6 (BACKLOG).
 */

/** The `@dashevo/wasm-sdk` version in package.json (a unit test keeps the two equal). */
export const PINNED_WASM_SDK = '4.2.0-beta.5'

/** [code a pre-beta.6 SDK decodes, code the node sent]. */
const SHIFTED: ReadonlyArray<readonly [number, number]> = [
  [10828, 10275], [10275, 10359], [10359, 10533], [10533, 10603], [10603, 10800], [10800, 10801],
  [10801, 10802], [10802, 10803], [10803, 10804], [10804, 10817], [10817, 10805], [10805, 10806],
  [10806, 10807], [10807, 10808], [10808, 10809], [10809, 10810], [10810, 10811], [10811, 10812],
  [10812, 10813], [10813, 10818], [10818, 10814], [10814, 10815], [10815, 10816], [10816, 10819],
  [10819, 10825], [10825, 10820], [10820, 10821], [10821, 10822], [10822, 10823], [10823, 10534],
  [10534, 10826], [10826, 10827], [10827, 10461], [10360, 10361], [10361, 10362], [10362, 10363],
  [10363, 10364], [10364, 10366], [10366, 10367], [10367, 10535], [10535, 10536], [10536, 10537],
  [10537, 10538], [10538, 10539], [10539, 10829], [10829, 10277], [10277, 10900], [10900, 10901],
  [10901, 10903], [10903, 10902], [10902, 10904], [10904, 10419], [10419, 10420], [10420, 11000],
  [11000, 11001], [11001, 10421], [10421, 10422], [10422, 10828],
]

/** The table holds for exactly the SDK it was measured against. */
const TRUE_CODE: ReadonlyMap<number, number> = PINNED_WASM_SDK === '4.2.0-beta.5' ? new Map(SHIFTED) : new Map()

/** The code the node sent, given the code whose text the pinned SDK rendered for it. */
export function trueCodeOf(decoded: number): number {
  return TRUE_CODE.get(decoded) ?? decoded
}
