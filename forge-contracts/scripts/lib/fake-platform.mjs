// An in-memory stand-in for the slice of @dashevo/evo-sdk that deploy-v2.mjs drives, so its
// registration, resume, supersede, ledger and refusal logic is tested without a network or a key.
//
//   const fake = createFakePlatform();
//   await main([...argv, '--identity', fake.writeIdentity(dir)], { evo: fake.evo, git, now, deploymentsRoot });
//
// It models what deploy-v2 relies on and nothing more: identity and contract nonces, a contract
// store keyed by the real id derivation (a create at the wrong nonce or id is refused, as a node
// would), contract groups with owners and admins, a balance that every landed transition spends,
// and proof metadata with a chain id. A broadcast can be made to fail before it lands or after
// (the connection dies while the node accepted it), the chain can be reset (another id, empty
// state), something else can consume the deployer's nonce, and the node can lag: answer the
// deployer's identity nonce from an earlier block. It is not offline-chain.mjs, which models
// documents.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b58encode, contractGroupId, contractId } from '../deploy-v2.mjs';

const PUBLIC_KEY_HEX = `02${'ab'.repeat(32)}`;

/** A deployer identity file as mint-identity writes it (only the fields deploy-v2 reads). */
export function fakeIdentityFile({ identityId = b58encode(Buffer.alloc(32, 9)), txid = 'ab'.repeat(32) } = {}) {
  return {
    identityId,
    txid,
    identityKeys: [{ id: 1, purpose: 'AUTHENTICATION', securityLevel: 'CRITICAL', keyType: 'ECDSA_SECP256K1', publicKeyHex: PUBLIC_KEY_HEX, privateKeyWif: 'not-a-real-wif' }],
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.chainId]
 * @param {object} [opts.identityFile]
 * @param {bigint} [opts.balance] the deployer's credits
 * @param {(kind: string, json: object) => number} [opts.sizeOf] a signed transition's size (the real one is binary; this is a fraction of the JSON)
 * @param {boolean} [opts.deployerExists]
 */
export function createFakePlatform({ chainId = 'dash-testnet-51', identityFile = fakeIdentityFile(), balance = 5_000_000_000_000n, sizeOf, deployerExists = true } = {}) {
  const ownerId = identityFile.identityId;
  const state = {
    chainId,
    proofChainId: null, // when set, proofs report this chain id (a node that disagrees with itself)
    height: 624_000n,
    identities: new Map(),
    contracts: new Map(), // id -> { json, ownerId, version, contractNonce }
    groups: new Map(), // id -> { ownerId, adminIds, name, description }
    memberships: new Map(), // contract id -> [group id]
    broadcasts: 0,
    sdkOptions: [],
    failure: null, // { mode: 'before' | 'after' }
    forceAdmins: null, // when set, the next group registered has these admins
    updateWaitThrows: true, // evo-sdk's wait refuses a contract update's proof ("affected state only")
    lag: null, // while lagging: { nonce }, the deployer's identity nonce as of an earlier block
    lagAfter: null, // when set, the node's identity nonce stays at the block before this broadcast lands
    sizeOf: sizeOf ?? ((kind, json) => Math.round(JSON.stringify(json).length * 0.85)),
  };
  if (deployerExists) state.identities.set(ownerId, { balance, nonce: 0n, contractNonces: new Map() });
  const deployer = () => state.identities.get(ownerId);
  const COST_PER_BYTE = 3_000_000n;

  class DataContract {
    constructor(json) {
      this.json = json;
      this.id = { toString: () => json.id };
      this.version = json.version;
    }
    static fromJSON(json) {
      if (!json?.documentSchemas || typeof json.id !== 'string') throw new Error('invalid data contract');
      return new DataContract(json);
    }
  }
  const stOf = (kind, transition) => ({
    kind,
    transition,
    signed: false,
    sign() { this.signed = true; },
    toBytes() { return new Uint8Array(state.sizeOf(kind, transition.contract.json)); },
  });
  class DataContractCreateTransition {
    constructor(contract, nonce) { this.contract = contract; this.nonce = BigInt(nonce); this.group = null; this.memberships = []; }
    setContractGroup(group) { this.group = group; }
    setContractGroupMemberships(memberships) { this.memberships = memberships; }
    toStateTransition() { return stOf('create', this); }
  }
  class DataContractUpdateTransition {
    constructor(contract, nonce) { this.contract = contract; this.nonce = BigInt(nonce); }
    toStateTransition() { return stOf('update', this); }
  }

  function land(st) {
    if (!st.signed) throw new Error('state transition is not signed');
    const me = deployer();
    if (!me) throw new Error('identity not found');
    const { transition } = st;
    const json = transition.contract.json;
    if (json.ownerId !== ownerId) throw new Error('owner mismatch');
    me.balance -= BigInt(st.toBytes().length) * COST_PER_BYTE;
    state.height += 1n;
    if (st.kind === 'create') {
      if (transition.nonce !== me.nonce + 1n) throw new Error(`invalid identity nonce ${transition.nonce}, expected ${me.nonce + 1n}`);
      if (json.id !== contractId(ownerId, transition.nonce)) throw new Error('contract id does not derive from the owner and nonce');
      if (transition.group) {
        state.groups.set(contractGroupId(ownerId, transition.nonce), {
          ownerId,
          adminIds: state.forceAdmins ?? transition.group.admins,
          name: transition.group.name,
          description: transition.group.description,
        });
        state.forceAdmins = null;
      }
      const groupIds = transition.memberships.map((m) => b58encode(Buffer.from(m.contractGroupId)));
      for (const g of groupIds) if (!state.groups.has(g)) throw new Error(`contract group ${g} does not exist`);
      state.contracts.set(json.id, { json, ownerId, version: 1, contractNonce: 0n });
      state.memberships.set(json.id, groupIds);
      me.nonce = transition.nonce;
      return;
    }
    const stored = state.contracts.get(json.id);
    if (!stored) throw new Error('contract not found');
    if (json.version !== stored.version + 1) throw new Error(`invalid version ${json.version}`);
    const have = me.contractNonces.get(json.id) ?? 0n;
    if (transition.nonce !== have + 1n) throw new Error(`invalid identity contract nonce ${transition.nonce}, expected ${have + 1n}`);
    me.contractNonces.set(json.id, transition.nonce);
    stored.json = json;
    stored.version = json.version;
  }

  const contractOf = (id) => {
    const c = state.contracts.get(id);
    return c ? { id: { toString: () => id }, version: c.version, toJSON: () => c.json } : undefined;
  };

  class EvoSDK {
    constructor(options) {
      state.sdkOptions.push(options);
      this.system = {
        status: async () => ({
          version: { protocol: { drive: { current: 14 } }, software: { drive: '5.0.0-rc.3' } },
          network: { chain_id: state.chainId },
          chain: { latest_block_height: state.height },
        }),
      };
      this.identities = {
        fetch: async (id) => {
          const me = state.identities.get(id);
          return me ? { getPublicKeyById: (kid) => (kid === 1 ? { data: PUBLIC_KEY_HEX, disabledAt: null } : undefined) } : undefined;
        },
        balance: async (id) => state.identities.get(id)?.balance,
        nonce: async (id) => (state.lag && id === ownerId ? state.lag.nonce : state.identities.get(id)?.nonce),
        contractNonce: async (id, contract) => state.identities.get(id)?.contractNonces.get(contract) ?? 0n,
      };
      this.contracts = {
        fetch: async (id) => contractOf(id),
        fetchWithProof: async (id) => ({
          data: contractOf(id),
          metadata: { height: state.height, coreChainLockedHeight: 1_234_567, epoch: 19_653, timeMs: 1_792_195_200_000n, protocolVersion: 14, chainId: new TextEncoder().encode(state.proofChainId ?? state.chainId) },
          proof: {},
        }),
      };
      this.contractGroups = {
        info: async (id) => {
          const g = state.groups.get(id);
          return g ? { ownerId: g.ownerId, adminIds: [...g.adminIds], name: g.name, description: g.description } : undefined;
        },
        forContract: async (id) => ({ contract: state.memberships.get(id) ?? [] }),
      };
      this.stateTransitions = {
        broadcastAndWait: async (st) => {
          state.broadcasts += 1;
          const failure = state.failure;
          state.failure = null;
          if (failure?.mode === 'before') throw new Error('connection lost before the node accepted the transition');
          const nonceBefore = deployer()?.nonce ?? 0n;
          land(st);
          if (state.lagAfter !== null && state.broadcasts >= state.lagAfter) { state.lag = { nonce: nonceBefore }; state.lagAfter = null; }
          if (failure?.mode === 'after') throw new Error('timed out waiting for the transition result');
          if (st.kind === 'update' && state.updateWaitThrows) throw new Error('affected state only: VerifiedDataContract snapshot is not a proof of the update');
        },
      };
    }
    async connect() {}
  }

  const evo = {
    EvoSDK,
    DataContract,
    DataContractCreateTransition,
    DataContractUpdateTransition,
    PrivateKey: { fromWIF: (wif) => ({ wif }) },
    IdentityPublicKey: class IdentityPublicKey { constructor(options) { Object.assign(this, options); } },
  };

  return {
    evo,
    state,
    ownerId,
    /** Write the identity file into `dir` and return its path. */
    writeIdentity(dir) {
      const path = join(dir, 'deployer.identity.json');
      writeFileSync(path, JSON.stringify(identityFile));
      return path;
    },
    /** The next broadcast fails: 'before' (never lands) or 'after' (lands, then the caller sees an error). */
    failNext: (mode) => { state.failure = { mode }; },
    /** Something other than deploy-v2 signs with the deployer: its identity nonce moves. */
    externalTransition: (count = 1) => { deployer().nonce += BigInt(count); },
    /** Platform resets: another chain id, no contracts, groups or nonces; the deployer is minted again. */
    reset: (newChainId) => {
      state.chainId = newChainId;
      state.contracts.clear();
      state.groups.clear();
      state.memberships.clear();
      state.identities.set(ownerId, { balance, nonce: 0n, contractNonces: new Map() });
    },
    /**
     * The node lags (as one behind a load-balanced DAPI can): once the n-th broadcast lands, the
     * deployer's identity nonce reads as of the block before it until catchUp().
     */
    lagAfter: (n) => { state.lagAfter = n; },
    catchUp: () => { state.lag = null; },
    /** The next group registered has these admins. */
    forceAdmins: (ids) => { state.forceAdmins = ids; },
    get broadcasts() { return state.broadcasts; },
  };
}
