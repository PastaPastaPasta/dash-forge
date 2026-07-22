// S0.6 deliverable #5 — isolate every flag combination the design leans on and
// report whether the platform (fullValidation) accepts it. Flag any rejects.
import init, * as sdk from '/Users/pasta/workspace/platform/packages/wasm-sdk/dist/sdk.js';
await init();
const O = '11111111111111111111111111111111';
const PV = 9;

// minimal valid token (baseSupply credit) reused where a tokenCost references a position
const rule = { $formatVersion:'0', authorizedToMakeChange:'ContractOwner', adminActionTakers:'ContractOwner',
  changingAuthorizedActionTakersToNoOneAllowed:false, changingAdminActionTakersToNoOneAllowed:false, selfChangingAdminActionTakersAllowed:false };
const tok = () => ({ $formatVersion:'0',
  conventions:{ $formatVersion:'0', localizations:{ en:{ $formatVersion:'0', shouldCapitalize:true, singularForm:'write', pluralForm:'writes' } }, decimals:0 },
  conventionsChangeRules:rule, baseSupply:1000000000, maxSupply:null,
  keepsHistory:{ $formatVersion:'0', keepsTransferHistory:true, keepsFreezingHistory:true, keepsMintingHistory:true, keepsBurningHistory:true, keepsDirectPricingHistory:true, keepsDirectPurchaseHistory:true },
  startAsPaused:false, allowTransferToFrozenBalance:true, maxSupplyChangeRules:rule,
  distributionRules:{ $formatVersion:'0', perpetualDistribution:null, perpetualDistributionRules:rule, preProgrammedDistribution:null,
    newTokensDestinationIdentity:null, newTokensDestinationIdentityRules:rule, mintingAllowChoosingDestination:true,
    mintingAllowChoosingDestinationRules:rule, changeDirectPurchasePricingRules:rule },
  marketplaceRules:{ $formatVersion:'0', tradeMode:'NotTradeable', tradeModeChangeRules:rule },
  manualMintingRules:rule, manualBurningRules:rule, freezeRules:rule, unfreezeRules:rule,
  destroyFrozenFundsRules:rule, emergencyActionRules:rule, mainControlGroup:null, mainControlGroupCanBeModified:'ContractOwner', description:null });

function run(name, docType, { tokens } = {}) {
  const c = { $formatVersion:'1', id:O, ownerId:O, version:1, documentSchemas:{ t: docType } };
  if (tokens) c.tokens = tokens;
  try { const dc = sdk.DataContract.fromJSON(c, true, PV); dc.free(); return { name, ok:true }; }
  catch (e) { return { name, ok:false, err:(e.message||e).toString().slice(0,180) }; }
}

const P = (n) => ({ type:'string', maxLength:20, position:n });
const H = (n) => ({ type:'array', byteArray:true, minItems:32, maxItems:32, position:n });

const checks = [
  // 1. countable string enum on a UNIQUE compound index (repoListing ownerName)
  run('countable on unique compound index ($ownerId+name)',
    { type:'object', properties:{ n:P(0) }, indices:[{ name:'i', properties:[{ $ownerId:'asc' },{ n:'asc' }], unique:true, countable:'countable' }], required:[], additionalProperties:false }),
  // 2. countable on non-unique index (comment targetId)
  run('countable on non-unique index',
    { type:'object', properties:{ n:H(0) }, indices:[{ name:'i', properties:[{ n:'asc' },{ $createdAt:'asc' }], countable:'countable' }], required:[], additionalProperties:false }),
  // 3. documentsCountable on primary tree (issue/patch totals)
  run('documentsCountable (primary-tree total)',
    { type:'object', documentsCountable:true, properties:{ n:P(0) }, required:[], additionalProperties:false }),
  // 4. tokenCost.delete (delete-gating on packManifest/chunk/label/release/webhook)
  run('tokenCost.delete',
    { type:'object', tokenCost:{ create:{ tokenPosition:0, amount:1 }, delete:{ tokenPosition:0, amount:1 } }, properties:{ n:P(0) }, required:[], additionalProperties:false },
    { tokens:{ 0:tok() } }),
  // 5. canBeDeleted:false (refUpdate/protectedRefUpdate/event/config non-deletables)
  run('canBeDeleted:false + documentsMutable:false',
    { type:'object', canBeDeleted:false, documentsMutable:false, properties:{ n:P(0) }, required:[], additionalProperties:false }),
  // 6. documentsKeepHistory:true on a MUTABLE type (issue/patch/comment)
  run('documentsKeepHistory:true (mutable, replaceable)',
    { type:'object', documentsKeepHistory:true, properties:{ n:P(0) }, required:[], additionalProperties:false }),
  // 7. documentsKeepHistory + documentsCountable together (issue/patch)
  run('documentsKeepHistory + documentsCountable together',
    { type:'object', documentsKeepHistory:true, documentsCountable:true, properties:{ n:P(0) }, required:[], additionalProperties:false }),
  // 8. baseSupply token credit (10^9) accepted at contract create
  run('token with baseSupply 10^9 (owner auto-credit)',
    { type:'object', properties:{ n:P(0) }, required:[], additionalProperties:false }, { tokens:{ 0:tok() } }),
  // --- DEVIATIONS the design assumed but the meta-schema forces changes on ---
  // D1. non-byteArray (string) array — design assumed these are fine
  run('[D1] string array (design assumption)',
    { type:'object', properties:{ a:{ type:'array', items:{ type:'string', maxLength:30 }, maxItems:10, position:0 } }, required:[], additionalProperties:false }),
  // D2. index direction "desc" (design wrote $createdAt desc)
  run('[D2] index direction "desc"',
    { type:'object', properties:{ n:P(0) }, indices:[{ name:'i', properties:[{ n:'desc' }] }], required:[], additionalProperties:false }),
];

console.log('FLAG-COMBINATION VERIFICATION (fullValidation, platform v9)\n' + '-'.repeat(60));
for (const r of checks) {
  console.log(`  ${r.ok ? 'ACCEPT' : 'REJECT'}  ${r.name}${r.ok ? '' : `\n            -> ${r.err}`}`);
}
