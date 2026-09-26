/**
 * The storage wizard's live test (`ux-dx-spec.md` §3.1 step 3), run from this page, so it
 * checks exactly what the browser will do later — including CORS, which a CLI test cannot see.
 *
 * S3 rows: signed PUT → signed GET → anonymous GET via the public URL → CORS for ranged reads
 * (GET + Range, `Content-Range` visible) → CORS for browser pushes (PUT) → delete probe.
 * IPFS rows: kubo API → add + CID + pin → gateway re-read (Range) → pinning service → unpin.
 *
 * A page cannot see WHY a cross-origin request failed: a CORS refusal and a dead host both
 * reject `fetch`. {@link reachable} tells them apart with an opaque `no-cors` request, which
 * resolves whenever the host answers at all, so a red row says "blocked by CORS" only when the
 * host is up.
 */

import { S3Error, deleteObject, getObject, publicObjectUrl, putObject, type S3Settings } from './s3'
import { IpfsError, addVerified, gatewayUrl, kuboVersion, pinningReachable, unpin, type IpfsSettings } from './ipfs'
import { normalizedPrefix, type ProfileSecrets, type StorageProfile } from './profiles'
import { sha256Hex } from './sigv4'
import { bytesEqual, errText } from './util'

export type RowId = 'put' | 'get' | 'public' | 'cors-range' | 'cors-put' | 'delete' | 'api' | 'add' | 'gateway' | 'pinning' | 'unpin'
export type RowState = 'pending' | 'running' | 'ok' | 'fail' | 'skipped'

/** One row of the live test. `cors` marks a failure the CORS fix block addresses. */
export interface ProbeRow {
  readonly id: RowId
  readonly label: string
  readonly state: RowState
  readonly detail: string
  readonly cors?: boolean
}

export const S3_ROWS: readonly { id: RowId; label: string }[] = [
  { id: 'put', label: 'signed PUT' },
  { id: 'get', label: 'signed GET' },
  { id: 'public', label: 'anonymous GET via public URL' },
  { id: 'cors-range', label: 'CORS preflight (GET, Range)' },
  { id: 'cors-put', label: 'CORS preflight (PUT) for browser pushes' },
  { id: 'delete', label: 'delete probe' },
]

export const IPFS_ROWS: readonly { id: RowId; label: string }[] = [
  { id: 'api', label: 'kubo API' },
  { id: 'add', label: 'add + CID check + pin' },
  { id: 'gateway', label: 'gateway re-read (Range)' },
  { id: 'pinning', label: 'pinning service' },
  { id: 'unpin', label: 'unpin probe' },
]

/** Whether `url`'s host answers at all (an opaque no-cors request; never readable). */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    return true
  } catch {
    return false
  }
}

/** A unique probe body, so a stale cached object can never pass for this run's upload. */
function probeBody(): Uint8Array {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  return new TextEncoder().encode(`dash-forge web storage probe ${Date.now()} ${nonce}\n`)
}

type Report = (id: RowId, state: RowState, detail: string, cors?: boolean) => void

/** Run the S3 test, reporting each row as it settles. */
async function probeS3(s: S3Settings, secrets: ProfileSecrets, report: Report): Promise<void> {
  const body = probeBody()
  const key = `${normalizedPrefix(s.prefix)}probe/forge-web-test-${await sha256Hex(body)}.txt`

  // 1 + 5: a PUT that lands proves the PUT preflight passed; one refused before any answer is
  // CORS when the endpoint is reachable.
  report('put', 'running', '')
  try {
    await putObject(s, secrets, key, body, 'text/plain')
    report('put', 'ok', `wrote ${key}`)
    report('cors-put', 'ok', 'the browser was allowed to send a signed PUT from this origin')
  } catch (e) {
    const blocked = e instanceof S3Error && e.status === 0 && (await reachable(s.endpoint))
    if (blocked) {
      report('put', 'fail', 'the browser refused to send it (see the CORS row)')
      report('cors-put', 'fail', 'the bucket’s CORS rules do not allow a signed PUT from this origin', true)
    } else {
      report('put', 'fail', errText(e))
      report('cors-put', 'skipped', 'needs a PUT that reaches the bucket')
    }
    for (const id of ['get', 'public', 'cors-range', 'delete'] as const) report(id, 'skipped', 'needs the probe object')
    return
  }

  report('get', 'running', '')
  try {
    const got = await getObject(s, secrets, key)
    if (bytesEqual(got, body)) report('get', 'ok', 'read back byte for byte')
    else report('get', 'fail', 'the bucket returned different bytes (a cache or proxy in front of it?)')
  } catch (e) {
    report('get', 'fail', errText(e), e instanceof S3Error && e.status === 0)
  }

  const publicUrl = publicObjectUrl(s, key)
  report('public', 'running', '')
  const publicHost = new URL(publicUrl).host
  let publicOk = false
  try {
    const resp = await fetch(publicUrl, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    const got = new Uint8Array(await resp.arrayBuffer())
    if (!resp.ok) report('public', 'fail', `HTTP ${resp.status} from ${publicHost}: the objects are not publicly readable`)
    else if (!bytesEqual(got, body)) report('public', 'fail', `${publicHost} served different bytes (check the public URL)`)
    else {
      publicOk = true
      report('public', 'ok', `anonymous GET ${publicHost}`)
    }
  } catch {
    const up = await reachable(publicUrl)
    report('public', 'fail', up ? 'the browser was not allowed to read it: no Access-Control-Allow-Origin on GET' : `${publicHost} did not answer`, up)
  }

  report('cors-range', 'running', '')
  if (!publicOk) report('cors-range', 'skipped', 'needs a public read')
  else {
    try {
      const resp = await fetch(publicUrl, { headers: { Range: 'bytes=0-9' }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      const range = resp.headers.get('content-range')
      if (resp.status !== 206) report('cors-range', 'fail', `a ranged GET returned ${resp.status} instead of 206: browsing needs HTTP Range support on the public URL`)
      else if (range === null) report('cors-range', 'fail', 'Content-Range is not exposed to scripts (Access-Control-Expose-Headers)', true)
      else report('cors-range', 'ok', 'Range allowed, Content-Range exposed')
    } catch {
      report('cors-range', 'fail', 'the CORS preflight for a Range request was refused: allow the Range request header', true)
    }
  }

  report('delete', 'running', '')
  try {
    await deleteObject(s, secrets, key)
    report('delete', 'ok', 'probe removed')
  } catch (e) {
    report('delete', 'fail', `${errText(e)}. The probe object (a few bytes) stays at ${key}; delete it by hand.`, e instanceof S3Error && e.status === 0)
  }
}

/** Run the IPFS test (kubo, plus the pinning service for a pinning profile). */
async function probeIpfs(s: IpfsSettings, secrets: ProfileSecrets, report: Report): Promise<void> {
  report('api', 'running', '')
  try {
    report('api', 'ok', `kubo ${await kuboVersion(s, secrets)}`)
  } catch (e) {
    const up = await reachable(s.api)
    report('api', 'fail', up ? errText(e) : `${new URL(s.api).host} did not answer`, up)
    for (const id of ['add', 'gateway', 'pinning', 'unpin'] as const) report(id, 'skipped', 'needs the kubo API')
    return
  }

  const body = probeBody()
  let cid = ''
  report('add', 'running', '')
  try {
    cid = await addVerified(s, secrets, body)
    report('add', 'ok', `${cid} matches the local derivation and is pinned`)
  } catch (e) {
    report('add', 'fail', errText(e))
  }

  report('gateway', 'running', '')
  if (cid === '' || s.gateway === '') report('gateway', 'skipped', s.gateway === '' ? 'no gateway configured: uploads are verified by CID and pin only' : 'needs the probe')
  else {
    const url = gatewayUrl(s.gateway, cid)
    try {
      const resp = await fetch(url, { headers: { Range: `bytes=0-${body.length - 1}` }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
      const got = new Uint8Array(await resp.arrayBuffer())
      if (!resp.ok) report('gateway', 'fail', `HTTP ${resp.status} from the gateway`)
      else if (!bytesEqual(got, body)) report('gateway', 'fail', 'the gateway served different bytes')
      else report('gateway', 'ok', `re-read through ${new URL(url).host}`)
    } catch {
      const up = await reachable(url)
      report('gateway', 'fail', up ? 'the gateway refused this origin (CORS)' : 'the gateway did not answer', up)
    }
  }

  report('pinning', 'running', '')
  if (s.kind !== 'ipfs-pinning-service') report('pinning', 'skipped', 'no pinning service in this profile')
  else {
    try {
      await pinningReachable(s, secrets)
      report('pinning', 'ok', 'the service accepted the token')
    } catch (e) {
      report('pinning', 'fail', errText(e), e instanceof IpfsError && /CORS/.test(e.message))
    }
  }

  report('unpin', 'running', '')
  if (cid === '') report('unpin', 'skipped', 'nothing was added')
  else {
    try {
      await unpin(s, secrets, cid)
      report('unpin', 'ok', 'probe unpinned (a gc removes it)')
    } catch (e) {
      report('unpin', 'fail', errText(e))
    }
  }
}

/**
 * Run the test for any profile kind, reporting each row as it settles. Resolves with whether
 * every row passed (no row failed). A Platform profile needs none.
 */
export async function probeProfile(p: StorageProfile, report: Report): Promise<boolean> {
  const s = p.settings
  if (s.kind === 'platform') return true
  let ok = true
  const tracked: Report = (id, state, detail, cors) => {
    if (state === 'fail') ok = false
    report(id, state, detail, cors)
  }
  if (s.kind === 's3') await probeS3(s, p.secrets, tracked)
  else await probeIpfs(s, p.secrets, tracked)
  return ok
}
