// Experiment 1: register the minimal token contract from DEPLOYER, and confirm
// baseSupply 10^9 WRITE is auto-credited to DEPLOYER at DataContractCreate.
//
// Minimal contract:
//   token 0 "write" (WRITE): baseSupply 10^9, all control rules -> ContractOwner
//     (DEPLOYER), no control group. mintingAllowChoosingDestination:true so the
//     owner can mint straight to a collaborator (the "grant").
//   doc type "refUpdate": tokenCost.create {pos0, amount1} AND tokenCost.delete
//     {pos0, amount1}. DELETABLE (canBeDeleted default true) so experiment 5 can
//     probe whether a frozen identity is blocked from DELETING as well as creating.
//     (In the production design refUpdate is non-deletable; the delete-gating being
//     validated here is the packManifest/chunk pattern from data-contracts.md 2.2.)
//
// Set DRYRUN=1 to only build+validate locally (no broadcast, no cost).
import { writeFileSync } from 'node:fs';
import { getSdk, disconnectSdk, loadIdentity, pickAuthKey, buildKeyAndSigner, log, evoSdk, errText, PUT_SETTINGS, STATE_FILE } from './lib.mjs';

const { DataContract, DataContractCreateTransition, PrivateKey } = evoSdk;

const OWNER_RULE = {
  $formatVersion: '0',
  authorizedToMakeChange: 'ContractOwner',
  adminActionTakers: 'ContractOwner',
  changingAuthorizedActionTakersToNoOneAllowed: false,
  changingAdminActionTakersToNoOneAllowed: false,
  selfChangingAdminActionTakersAllowed: false,
};

function writeToken() {
  return {
    $formatVersion: '0',
    conventions: { $formatVersion: '0', localizations: { en: { $formatVersion: '0', shouldCapitalize: true, singularForm: 'write', pluralForm: 'writes' } }, decimals: 0 },
    conventionsChangeRules: OWNER_RULE,
    baseSupply: 1000000000, // 10^9 credited to the owner atomically at DataContractCreate
    maxSupply: null,
    keepsHistory: { $formatVersion: '0', keepsTransferHistory: true, keepsFreezingHistory: true, keepsMintingHistory: true, keepsBurningHistory: true, keepsDirectPricingHistory: true, keepsDirectPurchaseHistory: true },
    startAsPaused: false,
    allowTransferToFrozenBalance: true,
    maxSupplyChangeRules: OWNER_RULE,
    distributionRules: {
      $formatVersion: '0', perpetualDistribution: null, perpetualDistributionRules: OWNER_RULE,
      preProgrammedDistribution: null, newTokensDestinationIdentity: null, newTokensDestinationIdentityRules: OWNER_RULE,
      mintingAllowChoosingDestination: true, mintingAllowChoosingDestinationRules: OWNER_RULE, changeDirectPurchasePricingRules: OWNER_RULE,
    },
    marketplaceRules: { $formatVersion: '0', tradeMode: 'NotTradeable', tradeModeChangeRules: OWNER_RULE },
    manualMintingRules: OWNER_RULE,     // grant  -> owner
    manualBurningRules: OWNER_RULE,
    freezeRules: OWNER_RULE,            // suspend -> owner
    unfreezeRules: OWNER_RULE,
    destroyFrozenFundsRules: OWNER_RULE, // revoke -> owner
    emergencyActionRules: OWNER_RULE,
    mainControlGroup: null,
    mainControlGroupCanBeModified: 'ContractOwner',
    description: null,
  };
}

const WRITE = 0;
const tc = (pos) => ({ tokenPosition: pos, amount: 1 });

const schemas = {
  refUpdate: {
    type: 'object',
    documentsMutable: false,
    tokenCost: { create: tc(WRITE), delete: tc(WRITE) },
    properties: {
      refNameHash: { type: 'array', byteArray: true, minItems: 32, maxItems: 32, position: 0 },
      refName: { type: 'string', maxLength: 255, position: 1 },
      newOid: { type: 'array', byteArray: true, minItems: 20, maxItems: 32, position: 2 },
    },
    indices: [
      { name: 'refState', properties: [{ refNameHash: 'asc' }, { $createdAt: 'asc' }] },
      { name: 'reflog', properties: [{ $createdAt: 'asc' }] },
    ],
    required: ['refNameHash', 'refName', 'newOid'],
    additionalProperties: false,
  },
};

const tokens = { 0: writeToken() };

const rec = loadIdentity('DEPLOYER');
const ownerId = rec.identityId;

const sdk = await getSdk();
const pv = sdk.version();
log(`platform/protocol version: ${pv}`);

const nextNonce = ((await sdk.identities.nonce(ownerId)) ?? 0n) + 1n;
log(`DEPLOYER identity nonce -> ${nextNonce}`);

// The DataContract wasm constructor requires TokenConfiguration *instances* for
// `tokens`; the far simpler path (proven in S0.6) is DataContract.fromJSON with a
// plain-JSON token config. Contract id = hash(ownerId, identityNonce) and does NOT
// depend on schemas/tokens, so we derive the id from a schemas-only constructor,
// then rebuild the full contract (with tokens) via fromJSON using that id.
let contract, contractId;
try {
  const idProbe = new DataContract({ ownerId, identityNonce: nextNonce, schemas, fullValidation: false, platformVersion: pv });
  contractId = idProbe.id.toString();
  const fullJson = {
    $formatVersion: '1', id: contractId, ownerId, version: 1,
    documentSchemas: schemas,
    tokens,
  };
  contract = DataContract.fromJSON(fullJson, true, pv);
} catch (e) {
  log(`CONTRACT BUILD FAILED: ${errText(e)}`);
  await disconnectSdk();
  throw e;
}
log(`built contract OK (fromJSON, tokens attached). id: ${contractId}`);

// token id for position 0
let tokenId;
try {
  tokenId = await sdk.tokens.calculateId(contractId, 0);
  log(`token[0] id: ${tokenId}`);
} catch (e) {
  log(`token id calc failed (non-fatal): ${errText(e)}`);
}

if (process.env.DRYRUN) {
  log('DRYRUN: skipping broadcast.');
  console.log(JSON.stringify({ contractId, tokenId, ownerId }, null, 2));
  await disconnectSdk();
  process.exit(0);
}

const critKey = pickAuthKey(rec, 'CRITICAL');
const { publicKey } = buildKeyAndSigner(critKey);
const priv = PrivateKey.fromWIF(critKey.privateKeyWif);

const tr = new DataContractCreateTransition(contract, nextNonce, pv);
const st = tr.toStateTransition();
st.sign(priv, publicKey);
log(`signed DataContractCreate ST size: ${st.toBytes().length} bytes`);

const balBefore = Number(await sdk.identities.balance(ownerId));
log(`DEPLOYER DASH balance before: ${balBefore}`);

log('broadcasting DataContractCreate...');
try {
  await sdk.stateTransitions.broadcastAndWait(st, PUT_SETTINGS);
  log('broadcast OK (contract created).');
} catch (e) {
  log(`BROADCAST ERROR: ${errText(e)}`);
  await disconnectSdk();
  throw e;
}

const balAfter = Number(await sdk.identities.balance(ownerId));
log(`DEPLOYER DASH balance after: ${balAfter}. cost: ${balBefore - balAfter} credits (~${((balBefore - balAfter) / 1e11).toFixed(6)} DASH)`);

// --- confirm baseSupply auto-credit ---
if (!tokenId) tokenId = await sdk.tokens.calculateId(contractId, 0);
const balMap = await sdk.tokens.balances([ownerId], tokenId);
const ownerTokenBal = balMap.get(ownerId);
log(`DEPLOYER WRITE-token balance after create: ${ownerTokenBal} (expect 1000000000)`);

const supply = await sdk.tokens.totalSupply(tokenId);
log(`WRITE token total supply: ${JSON.stringify(supply, (k, v) => typeof v === 'bigint' ? v.toString() : v)}`);

const out = {
  contractId, tokenId, ownerId,
  registrationCostCredits: balBefore - balAfter,
  deployerWriteTokenBalance: String(ownerTokenBal),
  baseSupplyExpected: '1000000000',
  baseSupplyCredited: String(ownerTokenBal) === '1000000000',
};
writeFileSync(STATE_FILE, JSON.stringify(out, null, 2));
log(`wrote state.json`);
console.log(JSON.stringify(out, null, 2));
await disconnectSdk();
