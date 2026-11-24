import { bls12_381 } from '@noble/curves/bls12-381.js'

import { hex, unhex } from './util'

export const DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_'
const Fr = bls12_381.fields.Fr
const sigs = bls12_381.longSignatures
export const R = Fr.ORDER
export const G1 = bls12_381.G1.Point
const G2 = bls12_381.G2.Point
export type G1Point = InstanceType<typeof G1>

export const mod = (a: bigint): bigint => {
  const x = a % R
  return x >= 0n ? x : x + R
}
export const bytesToScalar = (bytes: Uint8Array): bigint => BigInt(`0x${hex(bytes) || '0'}`)
export const scalarToHex = (s: bigint): string => s.toString(16).padStart(64, '0')
export const scalarFromHex = (h: string): bigint => mod(BigInt(`0x${h}`))

export const g1 = (scalar: bigint): G1Point => G1.BASE.multiply(scalar)
export const g1Hex = (point: G1Point): string => point.toHex(true)

export function evalPoly(coefficients: readonly bigint[], x: number): bigint {
  let acc = 0n
  let xk = 1n
  for (const a of coefficients) {
    acc = mod(acc + a * xk)
    xk = mod(xk * BigInt(x))
  }
  return acc
}

export function evalCommitments(commitmentsHex: readonly string[], x: number): G1Point {
  let acc = G1.ZERO
  let xk = 1n
  for (const c of commitmentsHex) {
    acc = acc.add(G1.fromHex(c).multiply(xk))
    xk = mod(xk * BigInt(x))
  }
  return acc
}

export function lagrangeAtZero(i: number, indices: readonly number[]): bigint {
  let num = 1n
  let den = 1n
  for (const j of indices) {
    if (j === i) continue
    num = mod(num * BigInt(j))
    den = mod(den * BigInt(j - i))
  }
  return mod(num * Fr.inv(den))
}

const hashToG2 = (message: Uint8Array) => sigs.hash(message, DST)

export function signShare(share: bigint, message: Uint8Array): string {
  return hex(sigs.Signature.toBytes(hashToG2(message).multiply(share)))
}

export function verify(signatureHex: string, message: Uint8Array, publicKeyHex: string): boolean {
  try {
    const pk = G1.fromHex(publicKeyHex)
    const sig = sigs.Signature.fromBytes(unhex(signatureHex))
    if (pk.equals(G1.ZERO) || sig.equals(G2.ZERO)) return false
    return sigs.verify(sig, hashToG2(message), pk.toBytes(true))
  } catch {
    return false
  }
}

export function combineShares(sharesByIndex: Readonly<Record<number, string>>): string {
  const indices = Object.keys(sharesByIndex)
    .map(Number)
    .sort((a, b) => a - b)
  let acc: ReturnType<typeof sigs.Signature.fromBytes> | null = null
  for (const i of indices) {
    const term = sigs.Signature.fromBytes(unhex(sharesByIndex[i] as string)).multiply(lagrangeAtZero(i, indices))
    acc = acc ? acc.add(term) : term
  }
  if (acc === null) throw new Error('no shares to combine')
  return hex(sigs.Signature.toBytes(acc))
}
