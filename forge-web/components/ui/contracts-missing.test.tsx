// @vitest-environment jsdom
/**
 * The "contracts not on this network" state: plain words naming the network, devnet and mainnet
 * worded differently, a devnet the forge left (moutai, bonsia) worded as its move to sakura rather
 * than a generic reset, the raw error only under Details, and no endless retry.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NetworkConfig } from '@/lib/constants'
import { ContractsMissingState } from './contracts-missing'

const RAW =
  'transport error: grpc error: code: \'Client specified an invalid argument\', message: "contract not found error: contract not found when querying from value with contract info"'

const forge = { core: 'CoreId111', collab: 'CollabId222', community: 'CollabId222', group: 'GroupId333' }
const MOUTAI: NetworkConfig = {
  network: 'devnet',
  devnetName: 'moutai',
  key: 'devnet-moutai',
  dapiAddresses: [],
  quorumBaseUrl: null,
  dpnsContractId: 'dpns',
  v2: forge,
}
const MAINNET: NetworkConfig = { ...MOUTAI, network: 'mainnet', devnetName: null, key: 'mainnet' }
const BONSIA: NetworkConfig = { ...MOUTAI, devnetName: 'bonsia', key: 'devnet-bonsia' }
const OTHER_DEVNET: NetworkConfig = { ...MOUTAI, devnetName: 'sakura', key: 'devnet-sakura' }

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function render(config: NetworkConfig): { title: string; body: string; details: HTMLDetailsElement } {
  act(() => root.render(<ContractsMissingState detail={RAW} config={config} />))
  const details = el.querySelector('details')!
  return {
    title: el.querySelector('h2')!.textContent ?? '',
    body: el.querySelector('p')!.textContent ?? '',
    details,
  }
}

describe('ContractsMissingState', () => {
  it('on a devnet the forge left (moutai, bonsia): says it moved to sakura, not a generic reset', () => {
    for (const [config, name] of [[MOUTAI, 'Devnet moutai'], [BONSIA, 'Devnet bonsia']] as const) {
      const { title, body } = render(config)
      expect(title).toBe('Dash Forge moved to a new devnet')
      expect(body).toContain(`${name} was retired`)
      expect(body).toContain('devnet sakura (Platform v5.0.0-beta.1)')
      expect(body).not.toMatch(/reset/i)
    }
  })

  it('on another devnet: names it, says devnets are reset and it is being redeployed', () => {
    const { title, body } = render(OTHER_DEVNET)
    expect(title).toBe("Dash Forge isn't deployed on devnet sakura right now")
    expect(body).toContain('devnets are reset from time to time')
    expect(body).toContain('redeployed')
  })

  it('on mainnet: neutral wording (a misconfigured build), no talk of resets', () => {
    const { title, body } = render(MAINNET)
    expect(title).toBe("This build's contracts were not found on mainnet")
    expect(body).not.toMatch(/reset/i)
    expect(body).toContain('misconfigured')
  })

  it('keeps the raw error and the contract ids behind Details, and offers no "Try again"', () => {
    const { title, body, details } = render(MOUTAI)
    expect(details.open).toBe(false)
    expect(details.textContent).toContain(RAW)
    expect(details.textContent).toContain('forge-core CoreId111')
    expect(title + body).not.toContain('grpc')
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).toEqual(['Reload for a newer build'])
    expect(el.textContent).not.toContain('Try again')
  })

  it('on moutai: still links to the GitHub repo for status', () => {
    act(() => root.render(<ContractsMissingState detail={RAW} config={MOUTAI} />))
    const link = el.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://github.com/PastaPastaPasta/dash-forge#readme')
    expect(link?.textContent).toBe('Dash Forge on GitHub')
  })
})
