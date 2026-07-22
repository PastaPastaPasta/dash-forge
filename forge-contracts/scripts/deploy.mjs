// Deploy a Dash Forge data contract to a network and record its id.
//
//   node scripts/deploy.mjs --contract registry --identity <deployer.json> [--network testnet]
//
// The registry is deployed once per network (global discovery contract). The
// repo template is NOT deployed here — clients instantiate it per repo (see
// forge-core). Deployed ids are written to forge-contracts/deployments/<network>.json.
//
// Pattern proven in spikes/S0.7-token-acl/01-register.mjs (DataContract.fromJSON,
// CRITICAL key signing, broadcastAndWait for a single contract create).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as evoSdk from '@dashevo/evo-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PUT_SETTINGS = { connectTimeoutMs: 10000, timeoutMs: 60000, retries: 3 };
const log = (m) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      a[k] = v;
    } else a._.push(t);
  }
  return a;
}

const CONTRACT_FILES = {
  registry: 'contracts/registry.json',
};

function pickAuthKey(rec, level) {
  const k = rec.identityKeys.find(
    (x) => x.purpose === 'AUTHENTICATION' && x.securityLevel === level,
  );
  if (!k) throw new Error(`no ${level} AUTHENTICATION key in identity`);
  return k;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const which = args.contract || 'registry';
  const network = args.network || 'testnet';
  const idFile = args.identity;
  if (!idFile || idFile === true) throw new Error('--identity <deployer.json> required');
  if (!CONTRACT_FILES[which]) throw new Error(`unknown contract: ${which}`);

  const rec = JSON.parse(readFileSync(resolve(String(idFile)), 'utf8'));
  const ownerId = rec.identityId;
  const contractJson = JSON.parse(readFileSync(join(ROOT, CONTRACT_FILES[which]), 'utf8'));

  const { EvoSDK, DataContract, DataContractCreateTransition, PrivateKey, IdentityPublicKey } = evoSdk;
  const sdk = network === 'mainnet' ? EvoSDK.mainnetTrusted({ settings: PUT_SETTINGS }) : EvoSDK.testnetTrusted({ settings: PUT_SETTINGS });
  log(`connecting (${network})...`);
  await sdk.connect();

  const pv = EvoSDK.getLatestVersionNumber ? await EvoSDK.getLatestVersionNumber() : undefined;

  // identity nonce for contract-id derivation (facade returns the masked value)
  const nextNonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;

  const schemas = contractJson.documentSchemas;
  const idProbe = new DataContract({ ownerId, identityNonce: nextNonce, schemas, fullValidation: false, platformVersion: pv });
  const contractId = idProbe.id.toString();
  const fullJson = {
    $formatVersion: '1', id: contractId, ownerId, version: 1,
    documentSchemas: schemas,
    ...(contractJson.keywords ? { keywords: contractJson.keywords } : {}),
    ...(contractJson.description ? { description: contractJson.description } : {}),
  };
  const contract = DataContract.fromJSON(fullJson, true, pv);
  log(`built ${which} contract; id: ${contractId}`);

  const critKey = pickAuthKey(rec, 'CRITICAL');
  const publicKey = new IdentityPublicKey({
    keyId: critKey.id,
    purpose: critKey.purpose, // UPPERCASE enum strings (wasm-sdk convention)
    securityLevel: critKey.securityLevel,
    keyType: critKey.keyType,
    isReadOnly: false,
    data: Buffer.from(critKey.publicKeyHex, 'hex'),
  });
  const priv = PrivateKey.fromWIF(critKey.privateKeyWif);

  const tr = new DataContractCreateTransition(contract, nextNonce, pv);
  const st = tr.toStateTransition();
  st.sign(priv, publicKey);
  log(`signed DataContractCreate (${st.toBytes().length} B); broadcasting...`);

  const balBefore = Number(await sdk.identities.balance(ownerId));
  await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
  const balAfter = Number(await sdk.identities.balance(ownerId));
  log(`deployed. cost ${((balBefore - balAfter) / 1e11).toFixed(6)} DASH`);

  // verify by fetch
  const fetched = await sdk.contracts.fetch(contractId);
  if (!fetched) throw new Error('post-deploy fetch returned nothing');
  log('post-deploy fetch OK.');

  // record
  const depDir = join(ROOT, 'deployments');
  if (!existsSync(depDir)) mkdirSync(depDir, { recursive: true });
  const depFile = join(depDir, `${network}.json`);
  const dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, 'utf8')) : {};
  dep[which] = { contractId, ownerId, deployedAt: new Date().toISOString(), version: 1 };
  writeFileSync(depFile, `${JSON.stringify(dep, null, 2)}\n`);
  log(`recorded ${which} -> ${depFile}`);

  console.log(JSON.stringify({ contract: which, network, contractId, cost: (balBefore - balAfter) / 1e11 }, null, 2));
  await sdk.disconnect?.();
}

main().catch((e) => { log(`ERROR: ${e.message || e}`); process.exit(1); });
