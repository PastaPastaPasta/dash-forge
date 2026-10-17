#!/usr/bin/env node
// check-release-network.mjs — refuse a final release whose network has no Forge deployment (CLIE-02, TEST-V-03).
//
//   node forge-contracts/scripts/check-release-network.mjs --version <semver> --publish true|false
//   node forge-contracts/scripts/check-release-network.mjs --self-test
//
// release.yml's `plan` job runs this before any build. Two networks are checked:
//   * `testnet`, the default network of every binary (crates/forge-core/src/network.rs), and
//   * the network the web build reads: RELEASE_NETWORK (and RELEASE_DEVNET_NAME for a devnet), parsed
//     from forge-web/scripts/ipfs-release.sh.
// A network is deployed when forge-contracts/deployments/<key>.json exists, is not `retired`, and its
// v2 record is complete by the rule the clients read it by (forge-web lib/deployments.ts `forgeV2Ids`,
// forge-core `V2Record::ids`): forge-core, forge-collab and forge-community (or a record that predates the
// split) registered, forge-meta registered when recorded, and a contract group.
//
// A final release (publishing, and the version has no `-`) is refused when a checked network is not
// deployed, or when the web build targets a devnet. Anything else (a pre-release, a dry run) gets the
// same findings as warnings, so the gap is visible long before the tag. Exit 1 on a refusal.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = resolve(HERE, '..', 'deployments');
const IPFS_RELEASE = resolve(HERE, '..', '..', 'forge-web', 'scripts', 'ipfs-release.sh');
const IPFS_RELEASE_NAME = 'forge-web/scripts/ipfs-release.sh';
const NETWORKS = ['devnet', 'testnet', 'mainnet'];

/** `NAME='value'` (single or double quoted, alone on its line) from a shell script; null when absent. */
export function shellValue(text, name) {
  const m = new RegExp(`^${name}=(['"])([^'"\\n]*)\\1[ \\t]*(?:#.*)?$`, 'm').exec(text);
  return m ? m[2] : null;
}

/** The deployment key the web build reads: `devnet-<name>`, `testnet` or `mainnet`. Throws when the script does not say. */
export function releaseKey(ipfsReleaseText) {
  const network = shellValue(ipfsReleaseText, 'RELEASE_NETWORK');
  if (network === null) throw new Error(`${IPFS_RELEASE_NAME}: no RELEASE_NETWORK='...' assignment found; the release network cannot be checked`);
  if (!NETWORKS.includes(network)) throw new Error(`${IPFS_RELEASE_NAME}: RELEASE_NETWORK='${network}' is not ${NETWORKS.join(', ')}`);
  if (network !== 'devnet') return { network, key: network };
  const name = shellValue(ipfsReleaseText, 'RELEASE_DEVNET_NAME');
  if (!name) throw new Error(`${IPFS_RELEASE_NAME}: RELEASE_NETWORK='devnet' but no RELEASE_DEVNET_NAME='...' assignment found`);
  return { network, key: `devnet-${name}`, devnetName: name };
}

const registered = (c) => c?.status === 'registered' && Boolean(c.contractId);

/** Why a deployment file is not a usable forge-v2 deployment, or null when it is (parity with `forgeV2Ids`). */
export function notDeployedReason(key, deploymentsDir) {
  const file = join(deploymentsDir, `${key}.json`);
  if (!existsSync(file)) return 'the file does not exist';
  let dep;
  try { dep = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return `the file is not valid JSON (${e.message})`; }
  if (dep.retired) return 'the network is retired';
  const v2 = dep.v2;
  if (!v2) return 'it records no forge-v2 deployment';
  const missing = [];
  if (!registered(v2.forgeCore)) missing.push('forgeCore');
  if (!registered(v2.forgeCollab)) missing.push('forgeCollab');
  if (v2.forgeCommunity != null && !registered(v2.forgeCommunity)) missing.push('forgeCommunity');
  if (v2.forgeMeta != null && !registered(v2.forgeMeta)) missing.push('forgeMeta');
  if (!v2.contractGroupId) missing.push('contractGroupId');
  if (missing.length > 0) return `a half-finished deployment: ${missing.join(', ')} not registered or recorded`;
  return null;
}

/**
 * The findings for a release: `{ final, findings }`, each finding `{ text }`. A final release turns them
 * into errors; otherwise they are warnings.
 */
export function check({ version, publish, deploymentsDir = DEPLOYMENTS, ipfsReleaseText = readFileSync(IPFS_RELEASE, 'utf8') }) {
  const final = publish && !version.includes('-');
  const release = releaseKey(ipfsReleaseText);
  const findings = [];
  const keys = [...new Set(['testnet', release.key])];
  for (const key of keys) {
    const why = notDeployedReason(key, deploymentsDir);
    if (why) {
      const where = key === 'testnet' ? 'every binary defaults to testnet' : `the web build reads ${key}`;
      findings.push(
        `v${version} ${final ? 'is a final release' : 'would be refused as a final release'}, but forge-contracts/deployments/${key}.json has no registered forge-v2 set (${why}): ` +
          `${where}${key === 'testnet' ? ' and would print "testnet  not deployed"' : ''} (CLIE-02). ` +
          'Register and commit the record first (P3, P4), or tag a pre-release (v<x.y.z>-rc.N).'
      );
    }
  }
  if (release.network === 'devnet') {
    findings.push(
      `a final release's web build targets devnet-${release.devnetName} (${IPFS_RELEASE_NAME} RELEASE_NETWORK); switch it to testnet first (M-IPFS).`
    );
  }
  return { final, findings };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    a[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

function run(argv) {
  const a = parseArgs(argv);
  if (a['self-test']) return selfTest();
  if (typeof a.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(a.version)) throw new Error('--version <semver> is required');
  if (a.publish !== 'true' && a.publish !== 'false') throw new Error('--publish true|false is required');
  const { final, findings } = check({ version: a.version, publish: a.publish === 'true' });
  const level = final ? 'error' : 'warning';
  for (const f of findings) console.log(`::${level}::${f}`);
  const row = findings.length === 0
    ? `- release network: deployed (v${a.version}${final ? ', final' : ''})`
    : `- release network: ${final ? 'REFUSED' : 'not ready for a final release'} (${findings.length} finding(s); see the annotations)`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${row}\n`);
  if (findings.length === 0) console.log(`release network check: ok (v${a.version}, publish=${a.publish})`);
  return final && findings.length > 0 ? 1 : 0;
}

// ---- --self-test: fixture dirs with the expected verdicts ----
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'check-release-network-'));
  const fail = [];
  const expect = (what, cond) => { if (!cond) fail.push(what); };
  try {
    const c = (id) => ({ status: 'registered', contractId: id });
    const full = { v2: { forgeCore: c('A'), forgeCollab: c('B'), forgeCommunity: c('C'), forgeMeta: c('D'), contractGroupId: 'G' } };
    const deployments = (files) => {
      const root = mkdtempSync(join(dir, 'd-'));
      mkdirSync(root, { recursive: true });
      for (const [k, v] of Object.entries(files)) writeFileSync(join(root, `${k}.json`), JSON.stringify(v));
      return root;
    };
    const script = (network, name) => `RELEASE_NETWORK='${network}'\n${name ? `RELEASE_DEVNET_NAME='${name}'\n` : ''}`;
    const verdict = (files, ipfs, version, publish) => check({ version, publish, deploymentsDir: deployments(files), ipfsReleaseText: ipfs });

    const ok = verdict({ testnet: full }, script('testnet'), '0.2.0', true);
    expect('a deployed testnet, released on testnet, is clean', ok.findings.length === 0 && ok.final);
    const undeployed = verdict({ testnet: { dapiAddresses: [] } }, script('testnet'), '0.2.0', true);
    expect('an undeployed testnet refuses a final release', undeployed.final && undeployed.findings.length === 1 && /has no registered forge-v2 set \(it records no forge-v2 deployment\).*CLIE-02/.test(undeployed.findings[0]));
    expect('a missing testnet file refuses', verdict({}, script('testnet'), '0.2.0', true).findings[0].includes('the file does not exist'));
    expect('a retired testnet refuses', /network is retired/.test(verdict({ testnet: { ...full, retired: true } }, script('testnet'), '0.2.0', true).findings[0]));
    const half = verdict({ testnet: { v2: { ...full.v2, forgeMeta: { status: 'broadcasting', contractId: 'D' } } } }, script('testnet'), '0.2.0', true);
    expect('a half-finished testnet (forgeMeta broadcasting) refuses', /half-finished.*forgeMeta/.test(half.findings[0]));
    expect('a testnet without a group refuses', /contractGroupId/.test(verdict({ testnet: { v2: { ...full.v2, contractGroupId: '' } } }, script('testnet'), '0.2.0', true).findings[0]));
    const legacy = { v2: { forgeCore: c('A'), forgeCollab: c('B'), contractGroupId: 'G' } };
    expect('a record that predates the community split is deployed', verdict({ testnet: legacy }, script('testnet'), '0.2.0', true).findings.length === 0);
    const devnetRelease = verdict({ testnet: full, 'devnet-sakura': full }, script('devnet', 'sakura'), '0.2.0', true);
    expect('a devnet release network refuses a final release', devnetRelease.findings.length === 1 && /targets devnet-sakura.*switch it to testnet first \(M-IPFS\)/.test(devnetRelease.findings[0]));
    const undeployedRelease = verdict({ testnet: full }, script('devnet', 'sakura'), '0.2.0', true);
    expect('an undeployed release devnet adds its own finding', undeployedRelease.findings.length === 2 && undeployedRelease.findings[0].includes('devnet-sakura.json'));
    expect('a pre-release is a warning, never final', !verdict({}, script('testnet'), '0.2.0-rc.1', true).final && verdict({}, script('testnet'), '0.2.0-rc.1', true).findings.length === 1);
    expect('a dry run is never final', !verdict({}, script('testnet'), '0.2.0', false).final);
    expect('the pre-release finding says a final release would be refused', /would be refused as a final release/.test(verdict({}, script('testnet'), '0.2.0-rc.1', true).findings[0]));
    expect('mainnet release network is checked by its own key', verdict({ testnet: full }, script('mainnet'), '1.0.0', true).findings[0].includes('mainnet.json'));
    for (const [what, text] of [['an unset RELEASE_NETWORK', '# nothing\n'], ['an unknown network', script('regtest')], ['a devnet without a name', script('devnet')]]) {
      let threw = false;
      try { check({ version: '0.2.0', publish: true, deploymentsDir: deployments({}), ipfsReleaseText: text }); } catch { threw = true; }
      expect(`${what} is an error`, threw);
    }
    expect('double quotes and a trailing comment parse', shellValue('RELEASE_NETWORK="testnet"  # switch\n', 'RELEASE_NETWORK') === 'testnet');
    // and the real script parses
    const real = releaseKey(readFileSync(IPFS_RELEASE, 'utf8'));
    expect('the real ipfs-release.sh names a release network', NETWORKS.includes(real.network));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (fail.length > 0) {
    for (const f of fail) console.error(`FAIL: ${f}`);
    return 1;
  }
  console.log('check-release-network self-test: ok');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
}
