import Link from 'next/link'
import { DOCS } from '@/lib/docs-links'
import { CopyBlock } from './copy-block'

/** backend.sh with an https name, which the web app needs to reach the node. */
export const BACKEND_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh | sudo sh -s -- --domain ipfs.example.org'

/** The kubo tile's "Run your own backend" entry: collapsed, under the one-command connect flow. */
export function SelfHostBackend(): JSX.Element {
  return (
    <details>
      <summary className="cursor-pointer text-dense">Run it on a server or NAS</summary>
      <div className="mt-2 space-y-2 text-dense">
        <p>On a Linux machine with Docker, replace ipfs.example.org with a name that points at it, and run:</p>
        <CopyBlock text={BACKEND_COMMAND} label="Copy the backend setup command" />
        <p>It prints what to enter under Set it up by hand. <Link className="underline" href={DOCS.selfHostBackend}>Run your own backend</Link></p>
      </div>
    </details>
  )
}
