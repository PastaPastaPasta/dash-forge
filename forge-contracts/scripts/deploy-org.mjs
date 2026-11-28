// Register forge-org (docs/design/organizations.md §10) and enrol it in the network's existing
// dash-forge contract group (lib/group-contract.mjs), as deploy-user.mjs does for forge-user.
// Additive: no other Forge contract changes.
//
//   (cd forge-contracts/sdk-v2 && npm ci)
//   node forge-contracts/scripts/deploy-org.mjs --network testnet --identity <deployer.identity.json> [--dry-run]
//   node forge-contracts/scripts/deploy-org.mjs --emit <file>   # offline: the JSON it registers, for contract-validate
//
// The record goes to deployments/<network>.json as a top-level `org` record; rerunning after
// success is a no-op. Organizations are testnet-only: mainnet needs --i-have-owner-approval-for-orgs.
import { pathToFileURL } from 'node:url';

import { runCli } from './lib/group-contract.mjs';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli({ recordKey: 'org', schemaFile: 'contracts/org/forge-org.json', label: 'forge-org', mainnetApproval: 'i-have-owner-approval-for-orgs' });
}
