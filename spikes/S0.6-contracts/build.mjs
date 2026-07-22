// S0.6 — Dash Forge data-contract builder.
// Emits forge-contracts/contracts/registry.json and forge-contracts/templates/repo-v1.json
// (+ repo-core.json / repo-collab.json if the single template exceeds the 16 KiB estimate).
//
// Schema-syntax deviations from docs/contracts/data-contracts.md, forced by the v1
// document meta-schema (protocol v12) and verified empirically in validate.mjs:
//   D1. Arrays must be byteArrays ("only byte arrays are supported now"). Every
//       string/object list in the design is therefore encoded as EITHER a JSON string
//       (human-readable, non-indexed lists) OR a packed byteArray (binary id lists).
//   D2. Index sort direction may only be "asc" in the contract; the doc's "desc"
//       markers are query-time reverse traversal, not part of the index definition.
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = '/Users/pasta/workspace/dash-forge/forge-contracts';
const DUMMY = '11111111111111111111111111111111'; // base58 of 32 zero bytes (dummy owner)

// ---- property helpers ----------------------------------------------------
let P = 0;
const reset = () => { P = 0; };
const str    = (maxLength, extra={}) => ({ type:'string', maxLength, position:P++, ...extra });
const int    = (extra={})            => ({ type:'integer', position:P++, ...extra });
const bool   = ()                    => ({ type:'boolean', position:P++ });
const ident  = ()                    => ({ type:'array', byteArray:true, minItems:32, maxItems:32, contentMediaType:'application/x.dash.dpp.identifier', position:P++ });
const hash32 = ()                    => ({ type:'array', byteArray:true, minItems:32, maxItems:32, position:P++ });
const oid    = ()                    => ({ type:'array', byteArray:true, minItems:20, maxItems:32, position:P++ });
const bytes  = (maxItems)            => ({ type:'array', byteArray:true, maxItems, position:P++ });
// D1: list encoded as a JSON string (non-indexed, human-readable).
const jsonList = (maxLength)         => ({ type:'string', maxLength, position:P++, description:'JSON-encoded array (D1: v1 meta-schema forbids non-byteArray arrays)' });

// ---- token config builder ------------------------------------------------
const OWNER_RULE = { $formatVersion:'0', authorizedToMakeChange:'ContractOwner', adminActionTakers:'ContractOwner',
  changingAuthorizedActionTakersToNoOneAllowed:false, changingAdminActionTakersToNoOneAllowed:false, selfChangingAdminActionTakersAllowed:false };
const GROUP_RULE = { $formatVersion:'0', authorizedToMakeChange:'MainGroup', adminActionTakers:'MainGroup',
  changingAuthorizedActionTakersToNoOneAllowed:false, changingAdminActionTakersToNoOneAllowed:false, selfChangingAdminActionTakersAllowed:false };
function token(singular, plural) {
  return {
    $formatVersion:'0',
    conventions:{ $formatVersion:'0', localizations:{ en:{ $formatVersion:'0', shouldCapitalize:true, singularForm:singular, pluralForm:plural } }, decimals:0 },
    conventionsChangeRules: OWNER_RULE,
    baseSupply: 1000000000,          // 10^9, credited to the owner atomically at DataContractCreate
    maxSupply: null,
    keepsHistory:{ $formatVersion:'0', keepsTransferHistory:true, keepsFreezingHistory:true, keepsMintingHistory:true, keepsBurningHistory:true, keepsDirectPricingHistory:true, keepsDirectPurchaseHistory:true },
    startAsPaused:false,
    allowTransferToFrozenBalance:true,
    maxSupplyChangeRules: OWNER_RULE,
    distributionRules:{ $formatVersion:'0', perpetualDistribution:null, perpetualDistributionRules:OWNER_RULE,
      preProgrammedDistribution:null, newTokensDestinationIdentity:null, newTokensDestinationIdentityRules:OWNER_RULE,
      mintingAllowChoosingDestination:true, mintingAllowChoosingDestinationRules:OWNER_RULE, changeDirectPurchasePricingRules:OWNER_RULE },
    marketplaceRules:{ $formatVersion:'0', tradeMode:'NotTradeable', tradeModeChangeRules:OWNER_RULE },
    manualMintingRules: GROUP_RULE,      // mint  → control group
    manualBurningRules: GROUP_RULE,
    freezeRules: GROUP_RULE,             // suspend → control group
    unfreezeRules: GROUP_RULE,
    destroyFrozenFundsRules: GROUP_RULE, // revoke → control group
    emergencyActionRules: GROUP_RULE,
    mainControlGroup: 0,
    mainControlGroupCanBeModified:'ContractOwner',
    description:null,
  };
}
const tc = (pos) => ({ tokenPosition: pos, amount: 1 }); // tokenCost entry for an own token
const WRITE = 0, MAINTAIN = 1;

// ---- REGISTRY CONTRACT ---------------------------------------------------
function registry() {
  reset(); const repoListing = { type:'object',
    properties:{
      name: str(100),
      normalizedName: { type:'string', pattern:'^[a-z0-9][a-z0-9._-]{0,62}$', maxLength:63, position:P++ },
      repoContractId: ident(),
      templateVersion: int({ minimum:0 }),
      description: str(500),
      topics: jsonList(400),        // D1: was array<=10 of string<=30
      forkOf: ident(),
    },
    indices:[
      { name:'ownerName', properties:[{ $ownerId:'asc' },{ normalizedName:'asc' }], unique:true, countable:'countable' }, // "N repositories" O(1)
      { name:'name', properties:[{ normalizedName:'asc' }] },                       // startsWith name search
      { name:'forkOf', properties:[{ forkOf:'asc' }], nullSearchable:false, countable:'countable' }, // fork count O(1)
    ],
    required:['name','normalizedName','repoContractId','templateVersion'],
    additionalProperties:false };

  reset(); const profile = { type:'object',
    properties:{ displayName: str(60), bio: str(500), avatarConfig: str(200), links: jsonList(900) /* D1: was array<=4 of <=200 */ },
    indices:[ { name:'owner', properties:[{ $ownerId:'asc' }], unique:true } ],
    required:[], additionalProperties:false };

  reset(); const star = { type:'object', documentsMutable:false, // immutable; unstar = delete
    properties:{ listingId: ident() },
    indices:[
      { name:'ownerListing', properties:[{ $ownerId:'asc' },{ listingId:'asc' }], unique:true },
      { name:'listing', properties:[{ listingId:'asc' },{ $createdAt:'asc' }], countable:'countable' }, // star count O(1)
      { name:'owner', properties:[{ $ownerId:'asc' },{ $createdAt:'asc' }] },                            // my stars
    ],
    required:['listingId'], additionalProperties:false };

  reset(); const follow = { type:'object', documentsMutable:false,
    properties:{ identityId: ident() },
    indices:[
      { name:'ownerIdentity', properties:[{ $ownerId:'asc' },{ identityId:'asc' }], unique:true },
      { name:'identity', properties:[{ identityId:'asc' },{ $createdAt:'asc' }], countable:'countable' }, // follower count O(1)
      { name:'owner', properties:[{ $ownerId:'asc' },{ $createdAt:'asc' }], countable:'countable' },      // following count O(1)
    ],
    required:['identityId'], additionalProperties:false };

  return { $formatVersion:'1', id:DUMMY, ownerId:DUMMY, version:1,
    documentSchemas:{ repoListing, profile, star, follow },
    keywords:['git','forge','repository','vcs'], description:'Dash Forge registry: repository discovery and social graph.' };
}

// ---- REPO CONTRACT document types ---------------------------------------
function repoDocTypes() {
  const d = {};

  reset(); d.config = { type:'object', documentsMutable:false, canBeDeleted:false, // append-only, non-deletable
    tokenCost:{ create: tc(MAINTAIN) },
    properties:{
      defaultBranch: str(255),
      protectedPatterns: jsonList(900),   // D1: was array<=8 of string<=100
      backend: { type:'object', properties:{ mode: int({ minimum:0, maximum:4 }), uris: jsonList(1300) /* D1 */ }, required:['mode'], additionalProperties:false, position:P++ },
      archived: bool(),
    },
    indices:[ { name:'created', properties:[{ $createdAt:'asc' }] } ],
    required:['defaultBranch'], additionalProperties:false };

  const refFields = () => ({ refNameHash: hash32(), refName: str(255), newOid: oid(), prevOid: oid(), force: bool() });
  const refIndices = () => ([
    { name:'refState', properties:[{ refNameHash:'asc' },{ $createdAt:'asc' }] },
    { name:'reflog',   properties:[{ $createdAt:'asc' }] },
    { name:'pusher',   properties:[{ $ownerId:'asc' },{ $createdAt:'asc' }] },
  ]);
  reset(); d.refUpdate = { type:'object', documentsMutable:false, canBeDeleted:false, tokenCost:{ create: tc(WRITE) },
    properties: refFields(), indices: refIndices(), required:['refNameHash','refName','newOid'], additionalProperties:false };
  reset(); d.protectedRefUpdate = { type:'object', documentsMutable:false, canBeDeleted:false, tokenCost:{ create: tc(MAINTAIN) },
    properties: refFields(), indices: refIndices(), required:['refNameHash','refName','newOid'], additionalProperties:false };

  reset(); d.packManifest = { type:'object', documentsMutable:false, documentsCountable:true, // pack count O(1)
    tokenCost:{ create: tc(WRITE), delete: tc(WRITE) },
    properties:{
      packHash: hash32(), kind: int({ minimum:0 }), sizeBytes: int({ minimum:0 }), objectCount: int({ minimum:0 }),
      chunkCount: int({ minimum:0 }), storage: int({ minimum:0, maximum:1 }),
      uris: jsonList(2600),   // D1: was array<=8 of <=300
      tips: bytes(512),       // D1: was array<=16 of oid  -> packed 16*32 bytes
      supersedes: bytes(1024),// D1: was array<=32 of hash32 -> packed 32*32 bytes
      offsetIndexParts: int({ minimum:0 }),
    },
    indices:[
      { name:'packHash', properties:[{ packHash:'asc' }], unique:true },
      { name:'created',  properties:[{ $createdAt:'asc' }] },
      { name:'kind',     properties:[{ kind:'asc' },{ $createdAt:'asc' }] },
    ],
    required:['packHash','kind','sizeBytes','objectCount','chunkCount','storage','offsetIndexParts'], additionalProperties:false };

  reset(); d.manifestPart = { type:'object', documentsMutable:false, tokenCost:{ create: tc(WRITE), delete: tc(WRITE) },
    properties:{ packHash: hash32(), partSeq: int({ minimum:0 }), entries: bytes(4900) },
    indices:[ { name:'part', properties:[{ packHash:'asc' },{ partSeq:'asc' }], unique:true } ],
    required:['packHash','partSeq','entries'], additionalProperties:false };

  reset(); d.chunk = { type:'object', documentsMutable:false, tokenCost:{ create: tc(WRITE), delete: tc(WRITE) },
    properties:{ packHash: hash32(), seq: int({ minimum:0 }), d0: bytes(4900), d1: bytes(4900), d2: bytes(4900) },
    indices:[ { name:'chunk', properties:[{ packHash:'asc' },{ seq:'asc' }], unique:true, countable:'countable' } ], // availability audit O(1)
    required:['packHash','seq','d0'], additionalProperties:false };

  const importedObj = () => ({ type:'object', properties:{ author: str(120), createdAt: int({ minimum:0 }), url: str(300) }, required:[], additionalProperties:false, position:P++ });

  reset(); d.issue = { type:'object', documentsKeepHistory:true, documentsCountable:true, // total issues O(1)
    properties:{ number: int({ minimum:1 }), title: str(256), body: str(5120), imported: importedObj() },
    indices:[
      { name:'number', properties:[{ number:'asc' }], unique:true },
      { name:'created', properties:[{ $createdAt:'asc' }] },
      { name:'owner',   properties:[{ $ownerId:'asc' },{ $createdAt:'asc' }] },
    ],
    required:['number','title'], additionalProperties:false };

  reset(); d.patch = { type:'object', documentsKeepHistory:true, documentsCountable:true, // total PRs O(1)
    properties:{
      number: int({ minimum:1 }), title: str(256), body: str(5120),
      baseRefNameHash: hash32(), baseRefName: str(255),
      sourceListingId: ident(), sourceContractId: ident(), sourceRefNameHash: hash32(), sourceRefName: str(255),
      headOid: oid(), patchManifestHash: hash32(), imported: importedObj(),
    },
    indices:[
      { name:'number', properties:[{ number:'asc' }], unique:true },
      { name:'created', properties:[{ $createdAt:'asc' }] },
      { name:'source',  properties:[{ sourceListingId:'asc' }] },
    ],
    required:['number','title','baseRefNameHash','sourceContractId','headOid'], additionalProperties:false };

  reset(); d.comment = { type:'object', documentsKeepHistory:true,
    properties:{ targetId: ident(), body: str(5120), replyTo: ident(), commitOid: oid(), path: str(500), line: int({ minimum:0 }), side: int({ minimum:0, maximum:1 }), imported: importedObj() },
    indices:[ { name:'target', properties:[{ targetId:'asc' },{ $createdAt:'asc' }], countable:'countable' } ], // per-target count O(1)
    required:['targetId','body'], additionalProperties:false };

  reset(); d.event = { type:'object', documentsMutable:false, canBeDeleted:false, // audit log, non-deletable
    properties:{ targetId: ident(), kind: int({ minimum:1 }), value: str(120), oid: oid() },
    indices:[
      { name:'target', properties:[{ targetId:'asc' },{ $createdAt:'asc' }] },
      { name:'feed',   properties:[{ $createdAt:'asc' }] },
    ],
    required:['targetId','kind'], additionalProperties:false };

  reset(); d.review = { type:'object', documentsMutable:false,
    properties:{ patchId: ident(), verdict: int({ minimum:1, maximum:3 }), commitOid: oid(), body: str(5120), imported: importedObj() },
    indices:[ { name:'patch', properties:[{ patchId:'asc' },{ $createdAt:'asc' }] } ],
    required:['patchId','verdict','commitOid'], additionalProperties:false };

  // newest-wins team types: append-only, NO unique indices, MAINTAIN-gated
  reset(); d.label = { type:'object', documentsMutable:false, tokenCost:{ create: tc(MAINTAIN), delete: tc(MAINTAIN) },
    properties:{ name: str(30), color: str(7), description: str(200), retired: bool() },
    indices:[ { name:'name', properties:[{ name:'asc' },{ $createdAt:'asc' }] } ], // newest-per-name wins; NOT unique
    required:['name'], additionalProperties:false };

  reset(); d.release = { type:'object', documentsMutable:false, tokenCost:{ create: tc(MAINTAIN), delete: tc(MAINTAIN) },
    properties:{ tagName: str(63), name: str(120), notes: str(5120), yanked: bool(), assets: jsonList(4096) /* D1: was array<=10 of object */ },
    indices:[
      { name:'tag',     properties:[{ tagName:'asc' },{ $createdAt:'asc' }] }, // newest-per-tag wins; NOT unique
      { name:'created', properties:[{ $createdAt:'asc' }] },
    ],
    required:['tagName'], additionalProperties:false };

  reset(); d.checkRun = { type:'object', documentsMutable:true, tokenCost:{ create: tc(WRITE), delete: tc(WRITE) }, // status progression => mutable
    properties:{ headOid: oid(), name: str(100), status: str(30), conclusion: str(30), detailsUrl: str(300), summary: str(1000) },
    indices:[ { name:'head', properties:[{ headOid:'asc' },{ $createdAt:'asc' }] } ],
    required:['headOid','name','status'], additionalProperties:false };

  reset(); d.webhook = { type:'object', documentsMutable:false, tokenCost:{ create: tc(MAINTAIN), delete: tc(MAINTAIN) },
    properties:{ hookId: hash32(), url: str(300), events: jsonList(600) /* D1 */, relayIdentityId: ident(), encryptedSecret: bytes(128), disabled: bool() },
    indices:[
      { name:'hook', properties:[{ hookId:'asc' },{ $createdAt:'asc' }] }, // newest-per-hook wins; NOT unique
      { name:'list', properties:[{ $createdAt:'asc' }] },
    ],
    required:['hookId','url','relayIdentityId'], additionalProperties:false };

  return d;
}

function repoContract(docKeys, all) {
  const documentSchemas = {};
  for (const k of docKeys) documentSchemas[k] = all[k];
  return { $formatVersion:'1', id:DUMMY, ownerId:DUMMY, version:1,
    documentSchemas,
    groups:{ 0:{ $formatVersion:'0', members:{ [DUMMY]:1 }, requiredPower:1 } }, // control group: mint/freeze/destroy admin
    tokens:{ 0: token('write','writes'), 1: token('maintain','maintains') },
    keywords:['git','forge','repository'], description:'Dash Forge per-repository contract (template v1).' };
}

// ---- emit ----------------------------------------------------------------
mkdirSync(`${OUT}/contracts`, { recursive:true });
mkdirSync(`${OUT}/templates`, { recursive:true });

const reg = registry();
const all = repoDocTypes();
const ALL_KEYS = Object.keys(all);
const CORE_KEYS   = ['config','refUpdate','protectedRefUpdate','packManifest','manifestPart','chunk'];
const COLLAB_KEYS = ['issue','patch','comment','event','review','label','release','checkRun','webhook'];

const repoFull  = repoContract(ALL_KEYS, all);
const repoCore  = repoContract(CORE_KEYS, all);
const repoCollab= repoContract(COLLAB_KEYS, all);

writeFileSync(`${OUT}/contracts/registry.json`, JSON.stringify(reg, null, 2));
writeFileSync(`${OUT}/templates/repo-v1.json`, JSON.stringify(repoFull, null, 2));
writeFileSync(`${OUT}/templates/repo-core.json`, JSON.stringify(repoCore, null, 2));
writeFileSync(`${OUT}/templates/repo-collab.json`, JSON.stringify(repoCollab, null, 2));

console.log('wrote registry.json, repo-v1.json, repo-core.json, repo-collab.json');
