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
import { formatBytes, plural, selectedTip, tipOidOf, type RepoHome, type SelectedRef } from '@/lib/view'
import { repoCommands } from '@/lib/view/repo-commands'
import { resolveTip } from '@/lib/view/tip'
import { repoKey } from '@/lib/repo'
import {
  compressInWorker,
  planArchive,
  readZipFiles,
  substituteFiles,
  type ArchiveRefs,
  storedSize,
  ZIP_MAX_BYTES,
  zipFileName,
  ZipTooLargeError,
  type ZipProgress,
} from '@/lib/view/zip'

export function CloneBox({ home, addr, selected }: { home: RepoHome; addr: RepoAddress; selected: SelectedRef }): JSX.Element {
  const cmd = repoCommands(addr.owner, addr.name)
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
        <CopyRow text={cmd.remote} label="Copy clone URL" />
        <div className="hidden sm:block">
          <CopyRow text={cmd.gitClone} label="Copy git clone command" />
          <p className="-mt-0.5 mb-1.5 text-[11px] text-anvil-500 dark:text-anvil-400">
            needs git-remote-dash ·{' '}
            <button type="button" onClick={() => setInstalling(true)} className="hit-area underline hover:text-forge-800 dark:hover:text-forge-400">
              install
            </button>
          </p>
          <CopyRow text={cmd.dgClone} label="Copy dg repo clone command" />
        </div>
        <p className="mb-1.5 text-[11px] text-anvil-500 dark:text-anvil-400" data-testid="clone-default-branch">
          A clone checks out <span className="font-mono">{home.defaultBranch}</span>, the default branch.
        </p>
        <ZipDownload home={home} addr={addr} selected={selected} />
      </div>
      <InstallSheet open={installing} onClose={() => setInstalling(false)} />
    </section>
  )
}

/** The repo's tags and branches, as `%(describe)` and `%d` in an export-subst file read them. */
function archiveRefs(home: RepoHome): ArchiveRefs {
  const named = (refs: RepoHome['tags'], prefix: string) =>
    refs.flatMap((r) => {
      const oid = tipOidOf(r)
      return oid === null ? [] : [{ name: r.refName.replace(prefix, ''), oid }]
    })
  return { tags: named(home.tags, 'refs/tags/'), heads: named(home.branches, 'refs/heads/') }
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
      // A short pinned id resolved to its commit, and a tag to what it names (L-01, L-32).
      // As `git archive` (QW-026): the tree's export-ignore and export-subst, modes, the commit's time.
      const plan = await planArchive(reader, (await resolveTip(reader, tip, { repoKey: repoKey(home.repo), pinned: selected.pinned !== undefined })).oid)
      const { files } = plan
      const stored = storedSize(files)
      if (stored > ZIP_MAX_BYTES) throw new ZipTooLargeError(stored)
      const entries = await readZipFiles(reader, files, setProgress, cancel.current.signal)
      await substituteFiles(reader, plan, entries, archiveRefs(home), { signal: cancel.current.signal, onProgress: setProgress })
      const name = zipFileName(addr.name, selected.name)
      const prefix = `${name.replace(/\.zip$/, '')}/`
      const rooted: Record<string, Uint8Array> = {}
      const modes: Record<string, number> = {}
      for (const f of files) modes[prefix + f.path] = f.mode
      for (const [path, bytes] of Object.entries(entries)) rooted[prefix + path] = bytes
      const zip = await compressInWorker(rooted, setProgress, cancel.current.signal, { modes, mtime: plan.mtime, comment: plan.commit?.oid ?? null })
      saveBytes(zip, name, 'application/zip')
      setMessage(`Saved ${name} (${formatBytes(zip.length)}, ${plural(files.length, 'file')}, each verified).`)
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
          ? `Reading ${progress.files} of ${plural(progress.filesTotal, 'file')} (${formatBytes(progress.bytes)})`
          : progress.phase === 'describing'
            ? 'Describing the commit for export-subst (git describe)…'
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

/** The release list, for "is there a release yet" (L-11). */
const RELEASES_URL = 'https://github.com/PastaPastaPasta/dash-forge/releases'
const BUILDING_URL = 'https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/BUILDING.md'

/**
 * Where the CLI comes from (`ux-dx-spec.md` §7.6; `docs/INSTALL.md`). No release has been
 * published yet (L-11), so building from source leads, and the prebuilt routes say they need a
 * release: install.sh stops with that message until one exists.
 */
function InstallSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const link = 'text-forge-700 underline dark:text-forge-400'
  return (
    <Dialog open={open} onClose={onClose} title="Install git-remote-dash and dg" description="Needed for git clone dash://… and pushes.">
      <div className="space-y-3 text-dense">
        <div>
          <h3 className="mb-1 font-medium">From source (works today, any OS)</h3>
          <CopyRow text="git clone https://github.com/PastaPastaPasta/dash-forge && cd dash-forge" label="Copy the source clone command" />
          <CopyRow text="cargo install --locked --path crates/dg && cargo install --locked --path crates/git-remote-dash" label="Copy the cargo install command" />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            Needs Rust and protoc 25 or newer (
            <a href={BUILDING_URL} target="_blank" rel="noreferrer noopener" className={link}>
              build guide
            </a>
            ). On Windows, run the same commands in PowerShell.
          </p>
        </div>
        <div>
          <h3 className="mb-1 font-medium">Prebuilt binaries (once a release is published)</h3>
          <p className="mb-1 text-[12px] text-anvil-500 dark:text-anvil-400">
            No release has been published yet; check the{' '}
            <a href={RELEASES_URL} target="_blank" rel="noreferrer noopener" className={link}>
              Releases page
            </a>
            . Until there is one, the installer stops and says so. Linux and macOS:
          </p>
          <CopyRow text="curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/install.sh | sh" label="Copy the install command" />
          <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
            It checks the release&apos;s SHA-256 (and its GitHub attestation when <span className="font-mono">gh</span> is signed in),
            then installs into <span className="font-mono">~/.local/bin</span>. Windows: the .zip on the Releases page.
          </p>
        </div>
        <p className="text-[12px] text-anvil-500 dark:text-anvil-400">
          Then check it: <span className="font-mono">dg doctor</span>. Shell completions: <span className="font-mono">dg completions zsh</span>.
        </p>
      </div>
    </Dialog>
  )
}
