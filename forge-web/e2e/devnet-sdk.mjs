// A trusted SDK connection to the e2e network, for the scripted App Connect v2 wallet
// (wallet-responder-v2.ts). `devnet` is the devnet's name, or '' on testnet (the e2e convention:
// network.ts E2E_DEVNET).

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
const node = (p) => pathToFileURL(join(ROOT, 'forge-web/node_modules', p)).href

export async function connect(devnet) {
  const evo = await import(node('@dashevo/evo-sdk/dist/evo-sdk.module.js'))
  const testnet = devnet === ''
  const dep = JSON.parse(readFileSync(join(ROOT, `forge-contracts/deployments/${testnet ? 'testnet' : `devnet-${devnet}`}.json`), 'utf8'))
  const network = testnet ? { network: 'testnet' } : { network: 'devnet', devnetName: devnet, addresses: dep.dapiAddresses ?? dep.v2.devnet.addresses }
  const sdk = new evo.EvoSDK({ ...network, trusted: true, settings: { timeoutMs: 60000, retries: 3 } })
  await sdk.connect()
  return { evo, sdk, dep }
}
