/**
 * Where this build is served: the address a user should see in the browser's address bar, and
 * the one the wallet sign-in tells them to check before scanning (SECU-08). forge.dashhq.org
 * (served from its root) unless a self-hosted deploy sets `NEXT_PUBLIC_SITE_URL`; that deploy's
 * `NEXT_PUBLIC_BASE_PATH` is added unless the site URL already ends with it, since Next joins
 * `metadataBase`'s path with the image's. Ends with a slash.
 */
export const SITE_URL = siteUrl(process.env.NEXT_PUBLIC_SITE_URL, process.env.NEXT_PUBLIC_BASE_PATH)

/** The host of {@link SITE_URL}, with a port when it has one: `forge.dashhq.org`. */
export const SITE_HOST = new URL(SITE_URL).host

/** {@link SITE_URL} from a build's two environment variables (pure, for the tests). */
export function siteUrl(site: string | undefined, basePath: string | undefined): string {
  const trimmed = site?.replace(/\/+$/, '')
  if (!trimmed) return 'https://forge.dashhq.org/'
  const base = (basePath || '').replace(/\/+$/, '')
  return `${base && !trimmed.endsWith(base) ? trimmed + base : trimmed}/`
}
