# Networks

Dash Forge runs on Dash Platform. Each network has its own identities, repositories and DASH, and nothing moves between them. The web app shows the same table at [forge.dashhq.org/networks](https://forge.dashhq.org/networks/), read from the deployment files in [`forge-contracts/deployments/`](../forge-contracts/deployments/).

## Where Forge runs today

| Network | Status | Notes |
|---|---|---|
| **Devnet sakura** | Live since 2026-10-01 | Dash Platform v5.0.0-beta.2, chain id `dash-devnet-sakura`. [forge.dashhq.org](https://forge.dashhq.org) and the guides use it. DASH is free from the [sakura faucet](https://faucet.sakura.networks.dash.org). A devnet can be reset, and everything on it would go with it except your git clones and your own storage. |
| **Testnet** | Not yet | Forge is registered on testnet once Dash Platform v5 reaches it. |
| **Mainnet** | Not yet | Forge is registered on mainnet after Dash Platform v5 activates there ([runbook](mainnet-runbook.md)). |

`dg` and `git-remote-dash` default to testnet, so select sakura explicitly: `--network devnet --devnet-name sakura`. On a network with no Forge deployment, `dg`, `git-remote-dash` and the web app stop with a "not deployed" error ([E702](errors.md#e702)).

## History

| Network | Dates | What happened |
|---|---|---|
| Devnet sakura (after its reset) | 2026-10-07 to now | On 2026-10-06 sakura's Platform chain was reset onto Platform v5.0.0-beta.2, and everything Forge kept there went with it: repositories, issues, pull requests, identities and their balances. Your git clones and your own storage were not affected. Forge's contracts were registered again on 2026-10-07 with new ids, from the same schema. |
| Devnet sakura | 2026-10-01 to 2026-10-06 | The second release candidate of the contracts (RC2) was registered on Platform v5.0.0-beta.1. Sakura replaced bonsia. Forge's three contracts (forge-core, forge-collab, forge-community) are registered in one contract group. |
| Devnet bonsia | 2026-09-29 to 2026-10-01 | The first release candidate (RC1, Platform v4.2.0-beta.7, tag `contracts-rc1-frozen`) was registered here. The web app ran on bonsia from 2026-09-30. The devnet was retired and everything on it is gone: [Dash Forge moved to devnet sakura](guides/devnet-move.md) says what was lost, what was kept and how to push again. |
| Devnet moutai | to 2026-09-29 | Moutai was upgraded in place to Platform v4.2.0-beta.7, which made the contracts registered there unreadable. Forge left it. |

The first version of Forge (forge-v1) was removed on 2026-09-26 with no backwards compatibility. See the [FAQ](FAQ.md#when-is-it-on-mainnet) for mainnet timing.
