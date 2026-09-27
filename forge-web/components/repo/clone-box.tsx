'use client'

/**
 * Clone box (`ux-dx-spec.md` §5.4): the `dash://owner/name` remote with copy, the git and dg
 * commands, and a .zip of the shown ref built in the browser. There is deliberately no https
 * clone URL: it would need a git server, and Forge runs none. On mobile only the remote and
 * the zip show.
 */

import { useRef, useState } from 'react'
import { Download, TerminalSquare } from 'lucide-react'
import { BackendBadge } from '@/components/ui/backend-badge'
import { Button } from '@/components/ui/button'
import { CopyRow } from '@/components/ui/copy-row'
import { Dialog } from '@/components/ui/dialog'
import { useBrowseReader } from '@/hooks/use-browse-reader'
import type { RepoAddress } from '@/hooks/use-query-param'
import { errorMessage } from '@/lib/utils'
import { saveBytes } from '@/lib/view/release-download'
import { formatBytes, selectedTip, type RepoHome, type SelectedRef } from '@/lib/view'
import {
  compressInWorker,
  listFiles,
  readZipFiles,
  storedSize,
  ZIP_MAX_BYTES,
  zipFileName,
  ZipTooLargeError,
  type ZipProgress,
} from '@/lib/view/zip'

export function CloneBox({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element {
  const slug = `${addr.owner}/${addr.name}`
  const remote = `dash://${slug}`
  const [installing, setInstalling] = useState(false)

  return (
    <section
      aria-label="Clone"
      data-testid="clone-box"
      className="rounded-lg border border-anvil-200 bg-white dark:border-anvil-750 dark:bg-anvil-900"
    >
      <div className="flex items-center justify-between border-b border-anvil-200 px-3 py-2 dark:border-anvil-800">
        <h2 className="flex items-center gap-1.5 text-dense font-medium">
          <TerminalSquare className="h-3.5 w-3.5 text-anvil-500 dark:text-anvil-400" aria-hidden /> Clone
        </h2>
        <BackendBadge backend={home.backend} />
      </div>
      <div className="p-3">
        <CopyRow text={remote} label="Copy clone URL" />
        <div className="hidden sm:block">
          <CopyRow text={`git clone ${remote}`} />
          <p className="-mt-0.5 mb-1.5 text-[11px] text-anvil-500 dark:text-anvil-400">
            needs git-remote-dash ·{' '}
            <button type="button" onClick={() => setInstalling(true)} className="underline hover:text-forge-800 dark:hover:text-forge-400">
              install
            </button>
          </p>
          <CopyRow text={`dg repo clone ${slug}`} />
        </div>
        <p className="mb-1.5 text-[11px] text-anvil-500 dark:text-anvil-400" data-testid="clone-default-branch">
          A clone checks out <span className="font-mono">{home.defaultBranch}</span>, the default branch.
        </p>
        <ZipDownload home={home} addr={addr} selected={selected} />
        <p className="mt-2 hidden text-[11px] leading-snug text-anvil-500 dark:text-anvil-400 sm:block">
          No https clone URL: that needs a git server, and Forge runs none. git talks to the chain and your storage
          directly through the helper.
        </p>
      </div>
      <InstallSheet open={installing} onClose={() => setInstalling(false)} />
    </section>
  )
}

function ZipDownload({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element | null {
  const state = useBrowseReader(home.repo)
  const [progress, setProgress] = useState<ZipProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Keyed by ref: another ref may well fit.
  const [tooLargeRef, setTooLargeRef] = useState<string | null>(null)
  const cancel = useRef<AbortController | null>(null)
  const tip = selectedTip(selected)
  if (tip === null) return null

  const busy = progress !== null
  const run = async (): Promise<void> => {
    if (state.kind !== 'ready') return
    const reader = state.reader
    cancel.current = new AbortController()
    setMessage(null)
    setProgress({ phase: 'listing', files: 0, filesTotal: 0, bytes: 0 })
    try {
      const files = await listFiles(reader, tip)
      const stored = storedSize(reader, files)
      if (stored > ZIP_MAX_BYTES) throw new ZipTooLargeError(stored)
      const entries = await readZipFiles(reader, files, setProgress, cancel.current.signal)
      const name = zipFileName(addr.name, selected.name)
      const rooted: Record<string, Uint8Array> = {}
      for (const [path, bytes] of Object.entries(entries)) rooted[`${name.replace(/\.zip$/, '')}/${path}`] = bytes
      const zip = await compressInWorker(rooted, setProgress, cancel.current.signal)
      saveBytes(zip, name, 'application/zip')
      setMessage(`Saved ${name} (${formatBytes(zip.length)}, ${files.length} files, each hash-checked).`)
    } catch (e) {
      if (e instanceof ZipTooLargeError) setTooLargeRef(tip)
      else setMessage(cancel.current?.signal.aborted ? 'Cancelled.' : `The zip could not be built: ${errorMessage(e)}`)
    } finally {
      setProgress(null)
      cancel.current = null
    }
  }

  const label =
    progress === null
      ? null
      : progress.phase === 'listing'
        ? 'Listing files…'
        : progress.phase === 'reading'
          ? `Reading ${progress.files} of ${progress.filesTotal} files (${formatBytes(progress.bytes)})`
          : `Compressing ${formatBytes(progress.bytes)}…`

  return (
    <div className="mt-2">
      {tooLargeRef === tip ? (
        <p className="text-[12px] text-caution-700 dark:text-caution-400">This ref is too large for a browser zip; clone instead.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void run()} disabled={busy || state.kind !== 'ready'} loading={busy} data-testid="zip-download">
            {busy ? null : <Download className="h-3.5 w-3.5" aria-hidden />}
            Download .zip of {selected.name}
          </Button>
          {busy ? (
            <button type="button" onClick={() => cancel.current?.abort()} className="text-[12px] underline">
              Cancel
            </button>
          ) : null}
        </div>
      )}
      <p role="status" className="mt-1 text-[11px] text-anvil-500 dark:text-anvil-400">
        {label ?? message ?? (state.kind === 'ready' ? `Built in your browser, up to ${formatBytes(ZIP_MAX_BYTES)}.` : 'Available once the code loads.')}
      </p>
    </div>
  )
}

/** Where the CLI comes from (`ux-dx-spec.md` §7.6; `docs/INSTALL.md`). */
function InstallSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Dialog open={open} onClose={onClose} title="Install git-remote-dash and dg" description="Needed for git clone dash://… and pushes.">
      <div className="space-y-3 text-dense">
        <div>
          <h3 className="mb-1 font-medium">Linux and macOS</h3>
          <CopyRow text="curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh" />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Checks the release&apos;s SHA-256 (and its GitHub attestation when <span className="font-mono">gh</span> is signed in),
            then installs into <span className="font-mono">~/.local/bin</span>. Read the script first if you like.
          </p>
        </div>
        <div>
          <h3 className="mb-1 font-medium">With cargo</h3>
          <CopyRow text="cargo binstall --git https://github.com/PastaPastaPasta/dash-forge dg git-remote-dash" />
        </div>
        <div>
          <h3 className="mb-1 font-medium">Windows</h3>
          <p className="text-anvil-600 dark:text-anvil-300">
            Download the zip from the{' '}
            <a
              href="https://github.com/PastaPastaPasta/dash-forge/releases"
              target="_blank"
              rel="noreferrer noopener"
              className="text-forge-700 underline dark:text-forge-400"
            >
              GitHub Releases page
            </a>{' '}
            and put both binaries on your PATH.
          </p>
        </div>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Then check it: <span className="font-mono">dg doctor</span>. Shell completions: <span className="font-mono">dg completion zsh</span>.
        </p>
      </div>
    </Dialog>
  )
}
