/**
 * The repository page's copy-paste commands carry the build's network (L-03, L-21): pasted on a
 * machine where nothing chose one, a bare `git clone dash://…` goes to testnet and fails E702.
 */

import { describe, expect, it } from 'vitest'

import { resolveNetworks } from '@/lib/constants'
import { DEPLOYMENTS } from '@/lib/deployments'
import { repoCommands, shellWord } from './repo-commands'

const OWNER = '8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB'

const network = (env: { network?: string; devnetName?: string }) => {
  const r = resolveNetworks(env, DEPLOYMENTS)
  return r.networks[r.active]
}

describe('repoCommands', () => {
  it('names the devnet in every command on a devnet build', () => {
    const cmd = repoCommands(OWNER, 'my-project', network({ network: 'devnet', devnetName: 'moutai' }))
    expect(cmd.remote).toBe(`dash://${OWNER}/my-project`)
    expect(cmd.gitClone).toBe(`git clone -c dash.network=devnet -c dash.devnetName=moutai dash://${OWNER}/my-project`)
    expect(cmd.dgClone).toBe(`dg repo clone ${OWNER}/my-project --network devnet --devnet-name moutai`)
    expect(cmd.remoteAdd).toBe(`git remote add origin dash://${OWNER}/my-project`)
    expect(cmd.setNetwork).toBe('git config dash.network devnet && git config dash.devnetName moutai')
    expect(cmd.authLogin).toBe('dg auth login <identity file> --network devnet --devnet-name moutai')
    expect(cmd.authNew).toBe('dg auth new --network devnet --devnet-name moutai')
  })

  it('names testnet and mainnet by kind alone', () => {
    const t = repoCommands(OWNER, 'p', network({ network: 'testnet' }))
    expect(t.gitClone).toBe(`git clone -c dash.network=testnet dash://${OWNER}/p`)
    expect(t.setNetwork).toBe('git config dash.network testnet')
    expect(repoCommands(OWNER, 'p', network({ network: 'mainnet' })).dgClone).toBe(`dg repo clone ${OWNER}/p --network mainnet`)
  })

  it('quotes a crafted owner or name, and leaves real ones bare', () => {
    const moutai = network({ network: 'devnet', devnetName: 'moutai' })
    const cmd = repoCommands('x;rm -rf ~', "it's", moutai)
    expect(cmd.remoteAdd).toBe(`git remote add origin 'dash://x;rm -rf ~/it'\\''s'`)
    expect(cmd.dgClone).toBe(`dg repo clone 'x;rm -rf ~/it'\\''s' --network devnet --devnet-name moutai`)
    expect(shellWord('forge-v2-empty')).toBe('forge-v2-empty')
  })

  it('keeps the network out of the dash:// URL', () => {
    const cmd = repoCommands(OWNER, 'p', network({ network: 'devnet', devnetName: 'moutai' }))
    expect(cmd.remote).not.toMatch(/moutai|devnet/)
  })
})
