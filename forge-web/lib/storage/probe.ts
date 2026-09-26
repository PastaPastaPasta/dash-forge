/**
 * The storage wizard's live test (`ux-dx-spec.md` §3.1 step 3), run from this page, so it
 * checks exactly what the browser will do later — including CORS, which a CLI test cannot see.
 *
 * S3 rows: signed PUT → signed GET → anonymous GET via the public URL → ranged read with
 * `Content-Range` visible → CORS for browser pushes (PUT) → delete probe.
 * IPFS rows: kubo API → add + CID + pin → gateway re-read (Range) → public gateway →
 * pinning service → unpin.
 *
 * A page cannot see WHY a cross-origin request failed: a CORS refusal, a refused redirect and a
 * dead host all reject `fetch`. {@link reachable} tells a dead host apart with an opaque
 * `no-cors` request to the same origin, which resolves whenever the host answers at all; a
 * `manual`-redirect probe then tells a redirect (wrong region or endpoint) from CORS.
 *
 * The public address is what everyone else reads, and it is recorded on chain: a row fails
 * when it is only reachable from this machine or its network, even if it answers here.
 */

import { S3Error, deleteObject, getObject, getPublic, objectUrl, publicObjectUrl, putObject, type S3Settings } from './s3'
import { IpfsError, addVerified, gatewayUrl, kuboVersion, pinningReachable, unpin, type IpfsSettings } from './ipfs'
import { normalizedPrefix, publishProblem, type ProfileSecrets, type StorageProfile } from './profiles'
import { sha256Hex } from './sigv4'
import { bytesEqual, errText, timedFetch } from './util'

export type RowId = 'put' | 'get' | 'public' | 'range' | 'cors-put' | 'delete' | 'api' | 'add' | 'gateway' | 'public-gateway' | 'pinning' | 'unpin'
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
  { id: 'range', label: 'ranged read (Content-Range visible)' },
  { id: 'cors-put', label: 'CORS preflight (PUT) for browser pushes' },
  { id: 'delete', label: 'delete probe' },
]

export const IPFS_ROWS: readonly { id: RowId; label: string }[] = [
  { id: 'api', label: 'kubo API' },
  { id: 'add', label: 'add + CID check + pin' },
  { id: 'gateway', label: 'gateway re-read (Range)' },
  { id: 'public-gateway', label: 'anonymous read via public gateway' },
  { id: 'pinning', label: 'pinning service' },
  { id: 'unpin', label: 'unpin probe' },
]

/** Whether `url`'s origin answers at all (an opaque no-cors request; never readable). */
async function reachable(url: string | URL): Promise<boolean> {
  try {
    await fetch(new URL(url).origin, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    return true
  } catch {
    return false
  }
}

/**
 * Whether `url` answers with a redirect. A redirect with a `Location` shows as an opaque
 * redirect; AWS's wrong-region answer is a bare `301 PermanentRedirect` with no `Location`,
 * which fetch hands back as an ordinary response, visible only through a CORS read of its
 * status (a `no-cors` one is opaque) — so both are tried.
 */
async function redirects(url: string | URL): Promise<boolean> {
  const opts = { redirect: 'manual' as const, credentials: 'omit' as const, cache: 'no-store' as const }
  try {
    const r = await fetch(url, { ...opts, mode: 'no-cors', signal: AbortSignal.timeout(10_000) })
    if (r.type === 'opaqueredirect') return true
  } catch {
    return false
  }
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) })
    return r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)
  } catch {
    return false
  }
}

/** Why a request to `url` never got an answer: down, redirected elsewhere, or CORS. */
async function whyBlocked(url: string | URL): Promise<'down' | 'redirect' | 'cors'> {
  if (!(await reachable(url))) return 'down'
  return (await redirects(url)) ? 'redirect' : 'cors'
}

/** A unique probe body, so a stale cached object can never pass for this run's upload. */
function probeBody(): Uint8Array {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  return new TextEncoder().encode(`dash-forge web storage probe ${Date.now()} ${nonce}\n`)
}

type Report = (id: RowId, state: RowState, detail: string, cors?: boolean) => void

/** Run the S3 test, reporting each row as it settles. */
async function probeS3(p: StorageProfile & { settings: S3Settings }, report: Report): Promise<void> {
  const s = p.settings
  const secrets = p.secrets
  const body = probeBody()
  const key = `${normalizedPrefix(s.prefix)}probe/forge-web-test-${await sha256Hex(body)}.txt`
  const apiUrl = objectUrl(s, key)

  // 1 + 5: a PUT that lands proves the PUT preflight passed; one refused before any answer is
  // CORS when the bucket's host answers and does not redirect.
  report('put', 'running', '')
  try {
    await putObject(s, secrets, key, body, 'text/plain')
    report('put', 'ok', `wrote ${key}`)
    report('cors-put', 'ok', 'the browser was allowed to send a signed PUT from this origin')
  } catch (e) {
    const why = e instanceof S3Error && e.status === 0 ? await whyBlocked(apiUrl) : null
    if (why === 'cors') {
      report('put', 'fail', 'the browser refused to send it (see the CORS row)')
      report('cors-put', 'fail', 'the bucket’s CORS rules do not allow a signed PUT from this origin', true)
    } else if (why === 'redirect') {
      report('put', 'fail', `${apiUrl.host} answered with a redirect: the bucket lives in another region or behind another endpoint; set that endpoint`)
      report('cors-put', 'skipped', 'needs a PUT that reaches the bucket')
    } else if (why === 'down') {
      report('put', 'fail', `${apiUrl.host} did not answer (check the endpoint${s.pathStyle ? '' : ', and that the bucket subdomain resolves'})`)
      report('cors-put', 'skipped', 'needs a PUT that reaches the bucket')
    } else {
      report('put', 'fail', errText(e))
      report('cors-put', 'skipped', 'needs a PUT that reaches the bucket')
    }
    for (const id of ['get', 'public', 'range', 'delete'] as const) report(id, 'skipped', 'needs the probe object')
    return
  }

  report('get', 'running', '')
  try {
    const got = await getObject(s, secrets, key)
    if (bytesEqual(got, body)) report('get', 'ok', 'read back byte for byte')
    else report('get', 'fail', 'the bucket returned different bytes (a cache or proxy in front of it?)')
  } catch (e) {
    report('get', 'fail', errText(e))
  }

  const publicUrl = publicObjectUrl(s, key)
  const publicHost = new URL(publicUrl).host
  const unpublishable = publishProblem(p)
  report('public', 'running', '')
  // Whether an anonymous read worked from here (the range row builds on it), apart from whether
  // the address is one others can use (a local MinIO answers here and nowhere else).
  let publicOk = false
  try {
    const got = await getPublic(s, key)
    if (got.status !== 200) report('public', 'fail', `HTTP ${got.status} from ${publicHost}: the objects are not publicly readable`)
    else if (!bytesEqual(got.bytes, body)) report('public', 'fail', `${publicHost} served different bytes (check the public URL)`)
    else {
      publicOk = true
      if (unpublishable) report('public', 'fail', `Readable from here, but ${unpublishable}`)
      else report('public', 'ok', `anonymous GET ${publicHost}`)
    }
  } catch {
    const why = await whyBlocked(publicUrl)
    report(
      'public',
      'fail',
      why === 'cors' ? 'the browser was not allowed to read it: no Access-Control-Allow-Origin on GET' : why === 'redirect' ? `${publicHost} redirected the read elsewhere` : `${publicHost} did not answer`,
      why === 'cors',
    )
  }

  report('range', 'running', '')
  if (!publicOk) report('range', 'skipped', 'needs a public read')
  else {
    try {
      const got = await getPublic(s, key, 'bytes=0-9')
      if (got.status !== 206) report('range', 'fail', `a ranged GET returned ${got.status} instead of 206: browsing needs HTTP Range support on the public URL`)
      else if (got.contentRange === null) report('range', 'fail', 'Content-Range is not exposed to scripts (Access-Control-Expose-Headers)', true)
      else report('range', 'ok', 'Range honoured, Content-Range exposed')
    } catch {
      report('range', 'fail', 'the ranged read was refused: allow the Range request header in the bucket’s CORS rules', true)
    }
  }

  report('delete', 'running', '')
  try {
    await deleteObject(s, secrets, key)
    report('delete', 'ok', 'probe removed')
  } catch (e) {
    const cors = e instanceof S3Error && e.status === 0 && (await whyBlocked(apiUrl)) === 'cors'
    report('delete', 'fail', `${errText(e)}. The probe object (a few bytes) stays at ${key}; delete it by hand.`, cors)
  }
}

/** Read `url` anonymously and require exactly `body`: a row's verdict. */
async function readBack(url: string, body: Uint8Array, range: boolean): Promise<{ ok: true } | { ok: false; detail: string; cors: boolean }> {
  try {
    const r = await timedFetch(url, { ...(range ? { headers: { Range: `bytes=0-${body.length - 1}` } } : {}), credentials: 'omit', cache: 'no-store' })
    const got = await r.bytes()
    if (!r.resp.ok) return { ok: false, detail: `HTTP ${r.resp.status}`, cors: false }
    if (!bytesEqual(got, body)) return { ok: false, detail: 'served different bytes', cors: false }
    return { ok: true }
  } catch {
    const why = await whyBlocked(url)
    return { ok: false, detail: why === 'cors' ? 'refused this origin (CORS)' : why === 'redirect' ? 'redirected elsewhere (use 127.0.0.1, not localhost, for a local gateway)' : 'did not answer', cors: why === 'cors' }
  }
}

/** Run the IPFS test (kubo, plus the pinning service for a pinning profile). */
async function probeIpfs(p: StorageProfile & { settings: IpfsSettings }, report: Report): Promise<void> {
  const s = p.settings
  const secrets: ProfileSecrets = p.secrets
  report('api', 'running', '')
  try {
    report('api', 'ok', `kubo ${await kuboVersion(s, secrets)}`)
  } catch (e) {
    const why = await whyBlocked(s.api)
    report('api', 'fail', why === 'down' ? `${new URL(s.api).host} did not answer` : errText(e), why === 'cors')
    for (const id of ['add', 'gateway', 'public-gateway', 'pinning', 'unpin'] as const) report(id, 'skipped', 'needs the kubo API')
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
    const r = await readBack(gatewayUrl(s.gateway, cid), body, true)
    if (r.ok) report('gateway', 'ok', `re-read through ${new URL(s.gateway).host}`)
    else report('gateway', 'fail', `the gateway ${r.detail}`, r.cors)
  }

  report('public-gateway', 'running', '')
  if (s.publicGateway === '') report('public-gateway', 'skipped', 'no public gateway: readers race public IPFS gateways, which may not find content only your node holds')
  else if (cid === '') report('public-gateway', 'skipped', 'needs the probe')
  else {
    const unpublishable = publishProblem(p)
    const r = await readBack(gatewayUrl(s.publicGateway, cid), body, false)
    if (!r.ok) report('public-gateway', 'fail', `the public gateway ${r.detail}`, r.cors)
    else if (unpublishable) report('public-gateway', 'fail', `Readable from here, but ${unpublishable}`)
    else report('public-gateway', 'ok', `anonymous read through ${new URL(s.publicGateway).host}`)
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
  if (s.kind === 's3') await probeS3({ ...p, settings: s }, tracked)
  else await probeIpfs({ ...p, settings: s }, tracked)
  return ok
}
