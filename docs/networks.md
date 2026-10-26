# Networks

Dash Forge runs on Dash Platform. Each network has its own identities, repositories and DASH, and nothing moves between them. The web app shows the same table at [forge.dashhq.org/networks](https://forge.dashhq.org/networks/), read from the deployment files in [`forge-contracts/deployments/`](../forge-contracts/deployments/).

## Where Forge runs today

| Network | Status | Notes |
|---|---|---|
| **Testnet** | Live since 2026-10-26 | Dash Platform v5.0.0-rc.8 (protocol 14), chain id `dash-testnet-51`. Forge's four contracts (forge-core, forge-collab, forge-community, forge-meta) are registered in one contract group, `EXgzBMpwC7RMjSU4WQghLAnfboswsssMGiXRtiV1hmBC`. [forge.dashhq.org](https://forge.dashhq.org) and the guides use it. DASH is free test money from the [Dash testnet faucet](https://faucet.testnet.networks.dash.org) or [faucet.thepasta.org](https://faucet.thepasta.org). Testnet can be reset, and everything on it would go with it except your git clones and your own storage. |
| **Mainnet** | Not yet | Forge is registered on mainnet after Dash Platform v5 activates there ([runbook](mainnet-runbook.md)). |

`dg` and `git-remote-dash` default to testnet, so no flag is needed. On a network with no Forge deployment, `dg`, `git-remote-dash` and the web app stop with a "not deployed" error ([E702](errors.md#e702)). Used Forge on a devnet before testnet? [Dash Forge moved to testnet](guides/devnet-move.md) says what was kept and how to push again.

## History

| Network | Dates | What happened |
|---|---|---|
| Testnet | 2026-10-26 to now | The production four-contract set (forge-core, forge-collab, forge-community, forge-meta) was registered on testnet (Platform v5.0.0-rc.8, protocol 14) by a dedicated deployer, from the same JSON that will be registered on mainnet. forge.dashhq.org, `dg` and the guides moved to testnet. Nothing was carried over from sakura: create your identity again and re-push from your clone ([how](guides/devnet-move.md)). The registration evidence is in [`forge-contracts/evidence/testnet/`](../forge-contracts/evidence/testnet/). |
| Devnet sakura (down) | 2026-10-24 | Sakura's nodes stopped answering around 2026-10-24 and its DNS names were removed. It is not coming back, and everything Forge kept there is gone; your git clones and your own storage were not affected. |
| Devnet sakura (four-contract set) | 2026-10-17 to 2026-10-24 | Forge moved sakura to the release's four-contract set (forge-core, forge-collab, forge-community, forge-meta), the set later registered on testnet, and re-seeded the demo fixtures on it. |
| Devnet sakura (after its third reset) | 2026-10-13 to 2026-10-17 | On 2026-10-13 sakura's Platform chain was reset a third time, onto Platform v5.0.0-beta.6, and everything Forge kept there went with it again. Forge's contracts were registered again the same day **with the same ids** as before, from the same schema. Repositories, issues, pull requests and your own identities and their balances were not carried over, so create your identity again; the demo fixtures were seeded again. Your git clones and your own storage were not affected. |
| Devnet sakura (after its second reset) | 2026-10-08 to 2026-10-13 | On 2026-10-08 sakura's Platform chain was reset again, onto Platform v5.0.0-beta.3, and everything Forge kept there went with it again. Forge's contracts were registered again the same day **with the same ids** as before (the deployer was re-created from its original funding), from the same schema. Repositories, issues, pull requests and your own identities and their balances were not carried over, so create your identity again; the demo fixtures were seeded again. Your git clones and your own storage were not affected. |
| Devnet sakura (after its first reset) | 2026-10-07 to 2026-10-08 | On 2026-10-06 sakura's Platform chain was reset onto Platform v5.0.0-beta.2, and everything Forge kept there went with it: repositories, issues, pull requests, identities and their balances. Your git clones and your own storage were not affected. Forge's contracts were registered again on 2026-10-07 with new ids, from the same schema. |
| Devnet sakura | 2026-10-01 to 2026-10-06 | The second release candidate of the contracts (RC2) was registered on Platform v5.0.0-beta.1. Sakura replaced bonsia. Forge's three contracts (forge-core, forge-collab, forge-community) are registered in one contract group. |
| Devnet bonsia | 2026-09-29 to 2026-10-01 | The first release candidate (RC1, Platform v4.2.0-beta.7, tag `contracts-rc1-frozen`) was registered here. The web app ran on bonsia from 2026-09-30. The devnet was retired and everything on it is gone: [Dash Forge moved to devnet sakura](archive/devnet-move.md) says what was lost, what was kept and how to push again. |
| Devnet moutai | to 2026-09-29 | Moutai was upgraded in place to Platform v4.2.0-beta.7, which made the contracts registered there unreadable. Forge left it. |

The first version of Forge (forge-v1) was removed on 2026-09-26 with no backwards compatibility. See the [FAQ](FAQ.md#when-is-it-on-mainnet) for mainnet timing.
