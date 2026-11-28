// Register forge-user (docs/design/identity-synced-state.md) and enrol it in the network's
// existing dash-forge contract group (lib/group-contract.mjs). Additive: no other Forge contract changes.
//
//   (cd forge-contracts/sdk-v2 && npm ci)
//   node forge-contracts/scripts/deploy-user.mjs --network testnet --identity <deployer.identity.json> [--dry-run]
//
// The deployer must own the group (the same identity that registered the set). The record goes
// to deployments/<network>.json as a top-level `user` record; rerunning after success is a no-op.
// Mainnet needs --i-have-owner-approval: registration is permanent and spends DASH.
import { pathToFileURL } from 'node:url';

import { runCli } from './lib/group-contract.mjs';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli({ recordKey: 'user', schemaFile: 'contracts/user/forge-user.json', label: 'forge-user' });
}
