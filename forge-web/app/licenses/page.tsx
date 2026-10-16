'use client'

/**
 * `/licenses` — the open-source notices for what this app is built from. The notice for every
 * package is `third-party-licenses.txt` and the Rust crates inside the Platform SDK's wasm module
 * are in `wasm-sdk-licenses.txt` (both written at build time, scripts/third-party-licenses.mjs);
 * the full GPL-3.0 and LGPL-3.0 texts sit beside this page (public/licenses/). The page itself
 * carries what the LGPL asks for OpenPGP.js: that it is used, under which license, and where its
 * exact source is.
 */

import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppShell } from '@/components/app-shell'
import { REPO_URL, verifyGuideUrl } from '@/lib/build-info'
import { BASE_PATH } from '@/lib/short-url'

/** The OpenPGP.js release this build contains (next.config.js reads it from the lockfile's tree). */
const OPENPGP_VERSION = process.env.FORGE_OPENPGP_VERSION ?? ''

const LINK = 'hit-area inline-flex items-center gap-1 text-forge-700 underline dark:text-forge-400'

function File({ path, children }: { path: string; children: ReactNode }): JSX.Element {
  // The files sit at the site root; BASE_PATH is the base the app runs under (a project site or
  // an IPFS gateway path), known at run time.
  return (
    <a href={`${BASE_PATH}/${path}`} target="_blank" rel="noreferrer noopener" className={LINK}>
      {children} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )
}

function Outside({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
      {children} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )
}

export default function LicensesPage(): JSX.Element {
  const v = OPENPGP_VERSION
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4" data-testid="licenses">
        <div>
          <h1 className="text-2xl">Third-party licenses</h1>
          <p className="mt-2 text-prose text-anvil-600 dark:text-anvil-300">
            Dash Forge is open source, under the MIT license or the Apache License 2.0, at your option. Its full source is at{' '}
            <Outside href={REPO_URL}>{REPO_URL.replace('https://', '')}</Outside>.
          </p>
          <p className="mt-2 text-prose text-anvil-600 dark:text-anvil-300">This app is built from other open-source software. These are the licenses it comes with.</p>
        </div>

        <section aria-labelledby="licenses-notices" className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
          <h2 id="licenses-notices" className="text-prose font-semibold">
            Notices
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-dense text-anvil-700 dark:text-anvil-300">
            <li>
              <File path="third-party-licenses.txt">Every package in this app</File>, each with the license text it ships.
            </li>
            <li>
              <File path="wasm-sdk-licenses.txt">The Rust crates inside the Dash Platform SDK</File> (its WebAssembly module).
            </li>
            <li>
              <File path="licenses/LGPL-3.0.txt">GNU LGPL 3.0</File> and <File path="licenses/GPL-3.0.txt">GNU GPL 3.0</File>, in full.
            </li>
          </ul>
        </section>

        <section aria-labelledby="licenses-openpgp" className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
          <h2 id="licenses-openpgp" className="text-prose font-semibold">
            OpenPGP.js
          </h2>
          <div className="mt-2 space-y-2 text-dense text-anvil-700 dark:text-anvil-300">
            <p data-testid="licenses-openpgp-version">
              This app uses OpenPGP.js {v} to read OpenPGP keys and check OpenPGP signatures. OpenPGP.js is free software under the GNU Lesser General Public License, version 3 or any later
              version.
            </p>
            <p>It is the published release, unmodified, in a file of its own that the app loads only when it needs it.</p>
            <p>
              You may change it and use your version with this app. The app is open source and its web build is reproducible, so you can swap OpenPGP.js in the lockfile or with a pnpm patch and
              rebuild (<Outside href={verifyGuideUrl()}>how to rebuild and check the app</Outside>).
            </p>
            <p>The source of the release this app contains:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <Outside href={`https://github.com/openpgpjs/openpgpjs/tree/v${v}`}>github.com/openpgpjs/openpgpjs, tag v{v}</Outside>
              </li>
              <li>
                <Outside href={`https://registry.npmjs.org/openpgp/-/openpgp-${v}.tgz`}>openpgp-{v}.tgz</Outside>, the package on npm
              </li>
            </ul>
          </div>
        </section>

        <section aria-labelledby="licenses-platform" className="rounded-lg border border-anvil-200 bg-white p-4 dark:border-anvil-800 dark:bg-anvil-900">
          <h2 id="licenses-platform" className="text-prose font-semibold">
            Dash Platform SDK
          </h2>
          <p className="mt-2 text-dense text-anvil-700 dark:text-anvil-300">
            The SDK this app talks to Dash Platform with is built from{' '}
            <Outside href="https://github.com/dashpay/platform">github.com/dashpay/platform</Outside>, under the MIT license. It ships as JavaScript and a WebAssembly module, and the Rust crates in the module carry
            their own licenses, which are listed above.
          </p>
        </section>
      </div>
    </AppShell>
  )
}
