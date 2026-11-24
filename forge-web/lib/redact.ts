/**
 * Scrub credentials from a message before it is shown or kept: URL userinfo, credential-looking
 * `key=value` pairs (`?token=`, `X-Amz-Signature=`, `password=`), `Authorization` values and
 * bearer tokens. Parity with forge-core `user_error::redact`; the primary defence is that
 * secrets never enter error text, this is the last line.
 */

const REDACTED = '[redacted]'

const SECRET_KEYS = ['token', 'secret', 'signature', 'sig', 'password', 'passwd', 'auth', 'credential', 'key', 'access_token', 'apikey']

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  if (k === 'allow-secret') return false
  return (k.startsWith('x-amz-') && k !== 'x-amz-date' && k !== 'x-amz-expires') || SECRET_KEYS.some((w) => k === w || k.endsWith(`_${w}`) || k.endsWith(`-${w}`))
}

export function redactSecrets(s: string): string {
  return s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/"'<>)@]*@/gi, `$1${REDACTED}@`)
    .replace(/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)[^"'\n,;]+/gi, `$1$2${REDACTED}`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/(^|[^A-Za-z0-9_-])([A-Za-z][A-Za-z0-9_-]*)=([^\s&"'),;>`]+)/g, (all, pre: string, key: string, value: string) =>
      isSecretKey(key) && !value.startsWith('<') && value !== REDACTED ? `${pre}${key}=${REDACTED}` : all,
    )
}
