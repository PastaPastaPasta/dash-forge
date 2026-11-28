import { fileURLToPath } from 'node:url'
import { defineWorkspace } from 'vitest/config'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const noble = { find: /^@noble\/hashes\/(.*)$/, replacement: here('node_modules/@noble/hashes/$1') }

const sdk = (pkg: string) => ({ find: /^@dashevo\/evo-sdk$/, replacement: here(`node_modules/${pkg}/dist/evo-sdk.module.js`) })

const resolveWith = (pkg: string) => ({ alias: [sdk(pkg), noble] })

const builtWith = (name: string, pkg: string) => ({
  resolve: resolveWith(pkg),
  test: { name, include: ['cross-sdk/build.test.ts'], env: { EVO_SDK_PACKAGE: pkg }, testTimeout: 60_000 },
})

export default defineWorkspace([
  builtWith('evo-sdk-5.0.3', 'evo-sdk-503'),
  builtWith('current', '@dashevo/evo-sdk'),
  { resolve: resolveWith('@dashevo/evo-sdk'), test: { name: 'cross', include: ['cross-sdk/cross.test.ts'], testTimeout: 60_000 } },
])
