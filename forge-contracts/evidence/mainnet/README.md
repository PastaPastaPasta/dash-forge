# Mainnet registration evidence (2026-11-24)

forge-v2 was registered on mainnet (`evo1`, Platform 5.0, protocol 14, @dashevo/evo-sdk@5.0.0-rc.8) from the committed
`forge-contracts/contracts/mainnet/` set by the dedicated deployer `CL4UTHLAyjYDvWNSgzmY7cXiBBba6fDt4BarAqt2XT3y`, with
`forge-contracts/scripts/launch-network.mjs --network mainnet --execute`. The live record is
`forge-contracts/deployments/mainnet.json`; the registered bytes are in
`forge-contracts/contracts/registered/mainnet/`.

| Contract | Id |
|---|---|
| forge-core | `GPHh5EAjvh346epUPQSijmz1xgJp6APjn45EPkGMCjLo` |
| forge-collab | `7zfipc1sq39fr49L5nrkFoxaJVfYpw3NUjsNkbQe6rp4` |
| forge-community | `83qUBePxmhKgajCUC8Z6hrEXRytVSsTjPgrZ2Uuxdbyv` |
| forge-meta | `9M8qFSM4vSsnRArtEzeFkTJb5dHso3qxfVWUGkwHguQp` |
| contract group | `H5gXhGVabbSdDdZMesVXevfbvNU8CgSCcHdhx6ekL2eJ` |

| File | What it shows |
|---|---|
| `signed-sums.sha256` | The sums the owner signed in P4 (`deploy-v2.mjs --print-sha256 --set mainnet` at `6da7d1c5`), passed as `--expect-sha256`. `launch-network.mjs` refuses to register unless they equal `sha256sums.txt`; this copy is that file. |
| `sha256sums.txt` | The sums `launch-network.mjs` computed from the checkout it registered from. |
| `c1.json` | C1 on the live registration: every contract on chain equals the signed JSON. |
| `group.json` | The contract group: owned by the deployer, with no admins. The record shows all four contracts carry this `contractGroupId`. |

The same steps were rehearsed on testnet the same night with a scratch deployer
([docs/launch/mainnet-runbook.md §8](../../../docs/launch/mainnet-runbook.md#8-testnet-rehearsal)).
