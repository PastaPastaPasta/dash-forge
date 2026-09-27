// Register a copy of yappr's key-exchange contract (the `loginKeyResponse` home of the shipped
// Dash wallets) on a devnet, so mobile-wallet sign-in can be tested where the testnet contract
// 7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P does not exist.
//
//   (cd forge-contracts/sdk-v2 && npm ci)
//   node forge-contracts/scripts/deploy-key-exchange.mjs --identity <deployer.identity.json> \
//        [--network devnet --devnet-name moutai] [--dry-run]
//
// The schema is forge-contracts/contracts/third-party/key-exchange.json (fetched from testnet).
// The result goes to deployments/<key>.json as a top-level `keyExchange` record, which forge-web
// reads (lib/auth/app-connect.ts `legacyKeyExchangeId`). Rerunning after success is a no-op.
// Testnet and mainnet are refused: testnet has yappr's own copy, which the wallets pin.
//
// On a devnet the wallets must be pointed at the copy: iOS Settings → Devnet → "DashConnect
// login contract"; Android has no setting (it pins the testnet id), so Android is testnet-only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { contractId, loadEvoSdk } from './deploy-v2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROTOCOL_VERSION = 14;
const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 90000, retries: 3 };
const DEFAULT_ADDRESSES = { moutai: [254, 207, 192, 194, 195, 196, 253, 198, 199, 84].map((o) => `https://68.67.122.${o}:1443`) };
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[k] = true;
    else { a[k] = next; i++; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = args.network || 'devnet';
  if (network !== 'devnet') throw new Error('only devnets: testnet has yappr’s copy, which the wallets pin');
  const devnetName = args['devnet-name'] || 'moutai';
  if (!args.identity || args.identity === true) throw new Error('--identity <deployer.identity.json> required');
  const key = `devnet-${devnetName}`;
  const depFile = join(ROOT, 'deployments', `${key}.json`);
  const dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, 'utf8')) : {};
  const addresses = dep.dapiAddresses ?? dep.v2?.devnet?.addresses ?? DEFAULT_ADDRESSES[devnetName];

  const rec = JSON.parse(readFileSync(resolve(String(args.identity)), 'utf8'));
  const ownerId = rec.identityId;
  const crit = rec.identityKeys.find((x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === 'CRITICAL');
  if (!crit) throw new Error('the identity has no CRITICAL authentication key');

  const evo = await loadEvoSdk();
  const { EvoSDK, DataContract, DataContractCreateTransition, PrivateKey, IdentityPublicKey } = evo;
  const sdk = new EvoSDK({ network, devnetName, addresses, trusted: true, settings: PUT_SETTINGS, version: PROTOCOL_VERSION });
  await sdk.connect();

  if (dep.keyExchange?.contractId && (await sdk.contracts.fetch(dep.keyExchange.contractId))) {
    log(`already registered: ${dep.keyExchange.contractId}`);
    console.log(JSON.stringify(dep.keyExchange, null, 2));
    return;
  }

  const schema = JSON.parse(readFileSync(join(ROOT, 'contracts', 'third-party', 'key-exchange.json'), 'utf8'));
  const nonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;
  const id = contractId(ownerId, nonce);
  // Protocol 14 accepts config version 1 only; the testnet original is version 0. Same settings,
  // with version 1's extra fields at their defaults (no sized integer types).
  const config = { ...schema.config, $formatVersion: '1', sizedIntegerTypes: false };
  const contract = DataContract.fromJSON(
    { $formatVersion: '1', id, ownerId, version: 1, config, documentSchemas: schema.documentSchemas },
    true,
    PROTOCOL_VERSION,
  );
  const st = new DataContractCreateTransition(contract, nonce, PROTOCOL_VERSION).toStateTransition();
  const privateKey = PrivateKey.fromWIF(crit.privateKeyWif);
  const publicKey = new IdentityPublicKey({
    keyId: crit.id,
    purpose: 'AUTHENTICATION',
    securityLevel: 'CRITICAL',
    keyType: crit.keyType,
    isReadOnly: false,
    data: Buffer.from(crit.publicKeyHex, 'hex'),
  });
  st.sign(privateKey, publicKey);
  log(`key-exchange copy: id ${id}, nonce ${nonce}, ${st.toBytes().length} B`);
  if (args['dry-run']) return;

  const before = await sdk.identities.balance(ownerId);
  await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
  if (!(await sdk.contracts.fetch(id))) throw new Error(`broadcast confirmed but ${id} cannot be fetched`);
  const after = await sdk.identities.balance(ownerId);
  const record = {
    contractId: id,
    ownerId,
    identityNonce: nonce.toString(),
    copyOf: '7UaqHGBJBbRLJ4fUWS45cnud8PPUugJWoGTt1SKwHJ2P',
    deployedAt: new Date().toISOString(),
    costDash: Number(before - after) / 1e11,
  };
  const fresh = existsSync(depFile) ? JSON.parse(readFileSync(depFile, 'utf8')) : {};
  fresh.keyExchange = record;
  writeFileSync(depFile, `${JSON.stringify(fresh, null, 2)}\n`);
  log(`registered; recorded in ${depFile}`);
  console.log(JSON.stringify(record, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(() => process.exit(0), (e) => { log(`ERROR: ${e?.message || e}`); process.exit(1); });
}
