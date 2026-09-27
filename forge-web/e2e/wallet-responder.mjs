// A scripted Dash Wallet for the wallet-login e2e: what Dash Wallet Android / iOS do when they
// approve a `dash-key:` request and a `dash-st:` key registration, done with a devnet test
// identity's own keys in Node. It never signs the app's transition: like the wallets, it
// rebuilds the update from its own state (the keys it derives) and signs with its master key.
//
//   approve({ uri, identityFile, chainKeyHex, keyExchange, devnet })
//     parse the request as the wallets do, derive the login key, publish (or replace) the
//     loginKeyResponse in the legacy key-exchange contract, like the shipped wallets.
//   register({ uri, identityFile, chainKeyHex, devnet })
//     check the dash-st transition adds exactly this wallet's derived keys (iOS rules), then
//     add them with an IdentityUpdate signed by the identity's master key, bounds kept (iOS)
//     or dropped (Android: { android: true }), never limits.
//
// `chainKeyHex` stands in for the wallet's BLOCKCHAIN_IDENTITY chain key (fixed per test run).

import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
const node = (p) => pathToFileURL(join(ROOT, 'forge-web/node_modules', p)).href
const secp = await import(node('@noble/secp256k1/index.js'))
const { hkdf } = await import(node('@noble/hashes/hkdf.js'))
const { sha256 } = await import(node('@noble/hashes/sha2.js'))
const { ripemd160 } = await import(node('@noble/hashes/legacy.js'))
const { hmac } = await import(node('@noble/hashes/hmac.js'))
secp.hashes.sha256 = sha256
secp.hashes.hmacSha256 = (k, m) => hmac(sha256, k, m)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58decode(s) {
  let n = 0n
  for (const c of s) {
    const v = B58.indexOf(c)
    if (v < 0) throw new Error('invalid Base58 payload')
    n = n * 58n + BigInt(v)
  }
  const out = []
  while (n > 0n) {
    out.unshift(Number(n % 256n))
    n /= 256n
  }
  for (const c of s) {
    if (c === '1') out.unshift(0)
    else break
  }
  return Uint8Array.from(out)
}
function b58encode(b) {
  let n = BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`)
  let s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s
    n /= 58n
  }
  for (const x of b) {
    if (x === 0) s = `1${s}`
    else break
  }
  return s
}
const hash160 = (b) => ripemd160(sha256(b))
const enc = new TextEncoder()

/** DashConnectUri.parseKeyRequest (Android), with the iOS length ceiling. */
export function parseKeyRequest(uri) {
  if (!uri.startsWith('dash-key:') || uri.startsWith('dash-key://')) throw new Error('not a dash-key URI')
  const [body, query] = uri.slice(9).split('?')
  const params = Object.fromEntries(query.split('&').map((p) => p.split('=')))
  if (params.v !== '1') throw new Error('unsupported version')
  if (!['m', 't', 'd'].includes(params.n)) throw new Error('unknown network')
  const p = b58decode(body)
  if (p.length < 67 || p.length > 131) throw new Error('bad payload length')
  if (p[0] !== 1) throw new Error('unsupported payload version')
  const labelLen = p[66]
  if (labelLen > 64 || 67 + labelLen > p.length) throw new Error('bad label')
  return { appPub: p.slice(1, 34), contractId: p.slice(34, 66), label: new TextDecoder().decode(p.slice(67, 67 + labelLen)), network: params.n }
}

function loginKeyFor(chainKey, identityId, contractId) {
  return hkdf(sha256, chainKey, b58decode(identityId), Uint8Array.from([...enc.encode('dash:login-key:v1'), ...contractId]), 32)
}
function derived(login, identityId) {
  const authPriv = hkdf(sha256, login, b58decode(identityId), enc.encode('auth'), 32)
  const encPriv = hkdf(sha256, login, b58decode(identityId), enc.encode('encryption'), 32)
  return { authPriv, authData: hash160(secp.getPublicKey(authPriv, true)), encPriv, encPub: secp.getPublicKey(encPriv, true) }
}

async function connect(devnet) {
  const evo = await import(node('@dashevo/evo-sdk/dist/evo-sdk.module.js'))
  const dep = JSON.parse(readFileSync(join(ROOT, `forge-contracts/deployments/devnet-${devnet}.json`), 'utf8'))
  const sdk = new evo.EvoSDK({ network: 'devnet', devnetName: devnet, addresses: dep.dapiAddresses ?? dep.v2.devnet.addresses, trusted: true, settings: { timeoutMs: 60000, retries: 3 } })
  await sdk.connect()
  return { evo, sdk, dep }
}

function identityKey(evo, rec, level) {
  const k = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === level)
  return { k, pub: new evo.IdentityPublicKey({ keyId: k.id, purpose: k.purpose, securityLevel: k.securityLevel, keyType: k.keyType, isReadOnly: false, data: Buffer.from(k.publicKeyHex, 'hex') }) }
}

/** Approve a login request: publish the loginKeyResponse in the legacy contract (create or replace). */
export async function approve({ uri, identityFile, chainKeyHex, devnet }) {
  const req = parseKeyRequest(uri)
  const rec = JSON.parse(readFileSync(identityFile, 'utf8'))
  const { evo, sdk, dep } = await connect(devnet)
  const keyExchange = dep.keyExchange.contractId
  const login = loginKeyFor(Buffer.from(chainKeyHex, 'hex'), rec.identityId, req.contractId)
  const walletPriv = secp.utils.randomSecretKey()
  const shared = secp.getSharedSecret(walletPriv, req.appPub, true).slice(1, 33)
  const aes = hkdf(sha256, shared, enc.encode('dash:key-exchange:v1'), new Uint8Array(0), 32)
  const key = await webcrypto.subtle.importKey('raw', aes, { name: 'AES-GCM' }, false, ['encrypt'])
  const nonce = randomBytes(12)
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, login))
  const fields = {
    contractId: req.contractId,
    appEphemeralPubKeyHash: hash160(req.appPub),
    walletEphemeralPubKey: secp.getPublicKey(walletPriv, true),
    encryptedPayload: Uint8Array.from([...nonce, ...ct]),
    keyIndex: 0,
  }
  const { k, pub } = identityKey(evo, rec, 'HIGH')
  const signer = new evo.IdentitySigner()
  signer.addKey(evo.PrivateKey.fromWIF(k.privateKeyWif))
  const version = sdk.version()
  // One response per (owner, app contract): replace the one a previous run left.
  const existing = [...(await sdk.documents.query({ dataContractId: keyExchange, documentTypeName: 'loginKeyResponse', where: [['$ownerId', '==', rec.identityId], ['contractId', '==', b58encode(req.contractId)]], limit: 1 })).values()].find(Boolean)
  if (existing) {
    const obj = existing.toObject()
    const document = evo.Document.fromObject({ ...obj, ...fields, $revision: BigInt(obj.$revision ?? 1) + 1n }, version)
    await sdk.documents.replace({ document, identityKey: pub, signer })
  } else {
    const base = new evo.Document({ properties: {}, documentTypeName: 'loginKeyResponse', dataContractId: keyExchange, ownerId: rec.identityId })
    const document = evo.Document.fromObject({ ...base.toObject(), ...fields }, version)
    await sdk.documents.create({ document, identityKey: pub, signer })
  }
  const d = derived(login, rec.identityId)
  const identity = await sdk.identities.fetch(rec.identityId)
  const registered = identity.publicKeys.some((x) => x.disabledAt === undefined && Buffer.from(x.data, 'hex').equals(Buffer.from(d.authData)))
  return { identityId: rec.identityId, contractId: b58encode(req.contractId), label: req.label, registered }
}

/** Complete a dash-st key registration the way the wallets do (verify, then rebuild and sign). */
export async function register({ uri, identityFile, chainKeyHex, contractId, devnet, android = false }) {
  if (!uri.startsWith('dash-st:')) throw new Error('not a dash-st URI')
  const bytes = b58decode(uri.slice(8).split('?')[0])
  const rec = JSON.parse(readFileSync(identityFile, 'utf8'))
  const { evo, sdk } = await connect(devnet)
  const t = evo.IdentityUpdateTransition.fromBytes(bytes).toJSON()
  const login = loginKeyFor(Buffer.from(chainKeyHex, 'hex'), rec.identityId, b58decode(contractId))
  const d = derived(login, rec.identityId)
  const data = (k) => Buffer.from(k.data, 'base64')
  // iOS validateKeyRegistration.
  if (t.identityId !== rec.identityId) throw new Error('dash-st is for a different identity')
  if (t.disablePublicKeys.length !== 0 || t.addPublicKeys.length !== 2) throw new Error('unexpected mutation')
  const auth = t.addPublicKeys.find((k) => k.purpose === 0)
  const encKey = t.addPublicKeys.find((k) => k.purpose === 1)
  if (!auth || auth.type !== 2 || auth.securityLevel !== 2 || !data(auth).equals(Buffer.from(d.authData))) throw new Error('auth key mismatch (forged QR?)')
  if (!encKey || encKey.type !== 0 || encKey.securityLevel !== 3 || !data(encKey).equals(Buffer.from(d.encPub))) throw new Error('encryption key mismatch (forged QR?)')
  if (auth.contractBounds?.$type === 'contractGroup') throw new Error('keyRegistrationUnexpectedMutation (iOS refuses group bounds)')

  const identity = await sdk.identities.fetch(rec.identityId)
  const next = Math.max(...identity.publicKeys.map((k) => k.keyId)) + 1
  const bounds = !android && auth.contractBounds ? evo.ContractBounds.SingleContract(auth.contractBounds.id) : undefined
  const addAuth = new evo.IdentityPublicKeyInCreation({ keyId: next, purpose: 'authentication', securityLevel: 'high', keyType: 'ecdsa_hash160', data: d.authData, ...(bounds ? { contractBounds: bounds } : {}) })
  const addEnc = new evo.IdentityPublicKeyInCreation({ keyId: next + 1, purpose: 'encryption', securityLevel: 'medium', keyType: 'ecdsa_secp256k1', data: d.encPub })
  const master = rec.identityKeys.find((x) => x.securityLevel === 'MASTER')
  const signer = new evo.IdentitySigner()
  signer.addKey(evo.PrivateKey.fromWIF(master.privateKeyWif))
  signer.addKey(evo.PrivateKey.fromBytes(d.encPriv, 'testnet'))
  signer.addKey(evo.PrivateKey.fromBytes(d.authPriv, 'testnet'))
  await sdk.identities.update({ identity, addPublicKeys: [addAuth, addEnc], signer })
  return { authKeyId: next }
}

/** Disable the keys a run added (cleanup): the auth keys that the chain key derives for these contracts. */
export async function disableDerived({ identityFile, chainKeyHex, contractIds, devnet }) {
  const rec = JSON.parse(readFileSync(identityFile, 'utf8'))
  const { evo, sdk } = await connect(devnet)
  const identity = await sdk.identities.fetch(rec.identityId)
  const want = new Set()
  for (const c of contractIds) {
    const d = derived(loginKeyFor(Buffer.from(chainKeyHex, 'hex'), rec.identityId, b58decode(c)), rec.identityId)
    want.add(Buffer.from(d.authData).toString('hex'))
    want.add(Buffer.from(d.encPub).toString('hex'))
  }
  const ids = identity.publicKeys.filter((k) => k.disabledAt === undefined && want.has(String(k.data))).map((k) => k.keyId)
  if (ids.length === 0) return []
  const master = rec.identityKeys.find((x) => x.securityLevel === 'MASTER')
  const signer = new evo.IdentitySigner()
  signer.addKey(evo.PrivateKey.fromWIF(master.privateKeyWif))
  await sdk.identities.update({ identity, disablePublicKeys: ids, signer })
  return ids
}

export const _test = { createHash }
