//! Release asset hashes (D-517).
//!
//! A release asset is referenced, never re-uploaded: the destination records its source URL
//! and the SHA-256 every download is checked against (`dg release download`, forge-web). The
//! source does not always say what that hash is: GitHub reports a `digest` only for assets
//! uploaded since mid-2025, and GitLab release links carry none. Recording `""` made every
//! such asset undownloadable, so the importer computes the hash itself: it streams the asset
//! from its public URL once and hashes the bytes (nothing is kept).
//!
//! * An asset already recorded on chain under the same tag, name, URL and size keeps the
//!   hash recorded there, so a re-run downloads nothing.
//! * Only a public `https://` URL is fetched, every redirect hop too (a public URL must not
//!   lead the importer to a private address), and never more bytes than the recorded size.
//! * A run downloads at most [`RUN_BYTES`] for hashing; an asset with no recorded size (a
//!   GitLab link) at most [`UNSIZED_BYTES`]. What does not fit is hashed by a later run.
//! * An asset that cannot be hashed (unreachable, larger than recorded) keeps `""` and the
//!   run warns: a missing hash is refused by readers, a guessed one would not be.
//!
//! A private destination seals its release assets instead ([`crate::sealed_release`]): the
//! same rules decide what may be downloaded ([`admit`]), and the bytes are kept to be sealed
//! ([`download`]), checked against the size and digest the source records.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use sha2::{Digest as _, Sha256};

use forge_core::collab::ReleaseAsset;
use forge_core::rules::is_sha256_hex;
use forge_core::storage::publish::is_public_https_url;

/// Assets larger than this are not downloaded for hashing (the run warns instead).
pub const MAX_HASHED_BYTES: u64 = 2 << 30;

/// What one run downloads for hashing, in all (later runs hash the rest).
pub const RUN_BYTES: u64 = 4 << 30;

/// The most an asset with no recorded size is read for hashing: also the most a reader takes
/// of a body whose size is unknown, so every asset hashed here can be downloaded.
pub const UNSIZED_BYTES: u64 = forge_core::storage::read::MAX_UNSIZED_BYTES;

/// Redirect hops followed (each one checked like the first URL).
const MAX_REDIRECTS: usize = 5;

/// What identifies the same file across runs: (tag, name, first URI, size).
type AssetKey = (String, String, String, u64);

/// The key an asset's recorded hash is reused under.
fn key(tag: &str, a: &ReleaseAsset) -> AssetKey {
    (
        tag.to_string(),
        a.name.clone(),
        a.uris.first().cloned().unwrap_or_default(),
        a.size_bytes,
    )
}

/// Hashes already recorded on chain, by (tag, name, first URI, size).
#[derive(Default)]
pub struct Known(BTreeMap<AssetKey, String>);

impl Known {
    /// Remember every hashed asset of release `tag`.
    pub fn add(&mut self, tag: &str, assets: &[ReleaseAsset]) {
        for a in assets.iter().filter(|a| is_sha256_hex(&a.sha256)) {
            self.0.insert(key(tag, a), a.sha256.to_ascii_lowercase());
        }
    }

    fn get(&self, tag: &str, a: &ReleaseAsset) -> Option<&String> {
        self.0.get(&key(tag, a))
    }
}

/// Where an asset's bytes come from when it is hashed: the network, or a test double.
pub(crate) trait Fetch {
    /// Stream `url` into `sink`, at most `limit` bytes (more is an error, after the sink saw
    /// the chunk that crossed it).
    ///
    /// Only names are checked ([`is_public_https_url`] on every hop), not the addresses they
    /// resolve to: a public name that resolves to a private address (DNS rebinding) is not
    /// caught here.
    async fn fetch(&self, url: &str, limit: u64, sink: &mut dyn FnMut(&[u8])) -> Result<u64>;
}

/// Plain HTTPS. Redirects are followed by hand (GitHub serves assets from a CDN), each hop
/// checked to be a public `https://` URL before it is requested.
pub struct Https(reqwest::Client);

impl Default for Https {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        Self(client)
    }
}

impl Fetch for Https {
    async fn fetch(&self, url: &str, limit: u64, sink: &mut dyn FnMut(&[u8])) -> Result<u64> {
        let mut url = url.to_string();
        let mut resp = None;
        for _ in 0..=MAX_REDIRECTS {
            if !is_public_https_url(&url) {
                bail!("a redirect leads to {url:?}, not a public https URL");
            }
            let r = self.0.get(&url).send().await.map_err(|e| anyhow!("{e}"))?;
            if !r.status().is_redirection() {
                resp = Some(r);
                break;
            }
            let next = r
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| anyhow!("a redirect with no location"))?;
            url = r.url().join(next).map_err(|e| anyhow!("{e}"))?.to_string();
        }
        let mut resp = resp
            .ok_or_else(|| anyhow!("more than {MAX_REDIRECTS} redirects"))?
            .error_for_status()
            .map_err(|e| anyhow!("{e}"))?;
        let mut total = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(|e| anyhow!("{e}"))? {
            total += chunk.len() as u64;
            // The sink sees every byte read, a refused chunk too: the run's budget counts
            // what was downloaded, not only what hashed.
            sink(&chunk);
            if total > limit {
                bail!("served more than the {limit} bytes it may be");
            }
        }
        Ok(total)
    }
}

/// Fill in the missing SHA-256 of `assets` of release `tag`: from `known` when the same file
/// is recorded already, else by hashing its bytes (`fetch`). Returns a warning per asset that
/// still has none. With `download` false (a dry run) nothing is fetched.
/// `budget` is what the run may still download for hashing ([`RUN_BYTES`] to start); each
/// asset hashed takes its bytes out of it.
pub(crate) async fn fill_hashes(
    tag: &str,
    assets: &mut [ReleaseAsset],
    known: &Known,
    fetch: &impl Fetch,
    download: bool,
    budget: &mut u64,
) -> Vec<String> {
    let mut warnings = Vec::new();
    for a in assets.iter_mut().filter(|a| !is_sha256_hex(&a.sha256)) {
        if let Some(h) = known.get(tag, a) {
            a.sha256.clone_from(h);
            continue;
        }
        if !download {
            continue;
        }
        match hash_one(a, fetch, budget).await {
            Ok(h) => a.sha256 = h,
            Err(e) => warnings.push(format!(
                "release {tag} asset {:?}: no SHA-256 recorded ({e:#}); readers will refuse to \
                 download it until a run can hash it",
                a.name
            )),
        }
    }
    warnings
}

/// Whether `a` may be downloaded with `budget` bytes left this run: its public `https` URL
/// and the most it may be read ([`UNSIZED_BYTES`] when it has no recorded size), or why not.
pub(crate) fn admit(a: &ReleaseAsset, budget: u64) -> Result<(&str, u64)> {
    let url = a
        .uris
        .iter()
        .find(|u| is_public_https_url(u))
        .ok_or_else(|| anyhow!("no public https URL to download it from"))?;
    let limit = if a.size_bytes > 0 {
        a.size_bytes
    } else {
        UNSIZED_BYTES
    };
    if limit > MAX_HASHED_BYTES {
        bail!("it is larger than the {MAX_HASHED_BYTES}-byte download limit");
    }
    if limit > budget {
        bail!("this run's {RUN_BYTES}-byte download budget is spent; a later run takes it");
    }
    Ok((url, limit))
}

/// Download `a` from `url` (admitted with [`admit`], at most `limit` bytes) to seal it into a
/// private destination: its bytes, checked against the size and the SHA-256 the source
/// records, when it records them.
pub(crate) async fn download(
    a: &ReleaseAsset,
    url: &str,
    limit: u64,
    fetch: &impl Fetch,
) -> Result<Vec<u8>> {
    // sized once when the source records the size (a whole file is held to be sealed)
    let mut bytes = Vec::with_capacity(usize::try_from(a.size_bytes.min(limit)).unwrap_or(0));
    fetch
        .fetch(url, limit, &mut |b| bytes.extend_from_slice(b))
        .await?;
    if a.size_bytes > 0 && bytes.len() as u64 != a.size_bytes {
        bail!(
            "served {} bytes, not the recorded {}",
            bytes.len(),
            a.size_bytes
        );
    }
    if is_sha256_hex(&a.sha256)
        && !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(&a.sha256)
    {
        bail!("its bytes do not match the SHA-256 the source records");
    }
    Ok(bytes)
}

async fn hash_one(a: &ReleaseAsset, fetch: &impl Fetch, budget: &mut u64) -> Result<String> {
    let (url, limit) = admit(a, *budget)?;
    let mut h = Sha256::new();
    // Charged as bytes arrive, so a failed download costs what it read.
    let got = fetch
        .fetch(url, limit, &mut |b| {
            *budget = budget.saturating_sub(b.len() as u64);
            h.update(b);
        })
        .await?;
    if a.size_bytes > 0 && got != a.size_bytes {
        bail!("served {got} bytes, not the recorded {}", a.size_bytes);
    }
    Ok(hex::encode(h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Served {
        body: Vec<u8>,
        seen: RefCell<Vec<String>>,
    }

    impl Fetch for Served {
        #[allow(clippy::unused_async_trait_impl)] // a test double: nothing to await
        async fn fetch(&self, url: &str, limit: u64, sink: &mut dyn FnMut(&[u8])) -> Result<u64> {
            self.seen.borrow_mut().push(url.to_string());
            let mut total = 0;
            for c in self.body.chunks(3) {
                total += c.len() as u64;
                sink(c);
                if total > limit {
                    bail!("served more than the {limit} bytes it may be");
                }
            }
            Ok(total)
        }
    }

    fn asset(sha: &str, size: u64, url: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: "fd".into(),
            sha256: sha.into(),
            size_bytes: size,
            uris: vec![url.into()],
            uri: None,
        }
    }

    fn served(body: &[u8]) -> Served {
        Served {
            body: body.to_vec(),
            seen: RefCell::default(),
        }
    }

    const URL: &str = "https://github.com/o/r/releases/download/v1/fd";

    /// D-517: an asset GitHub reports no digest for was recorded with sha256 "".
    #[tokio::test]
    async fn a_missing_hash_is_computed_from_the_bytes() {
        let body = b"release bytes";
        let mut a = [asset("", body.len() as u64, URL)];
        let w = fill_hashes(
            "v1",
            &mut a,
            &Known::default(),
            &served(body),
            true,
            &mut RUN_BYTES.clone(),
        )
        .await;
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(a[0].sha256, hex::encode(Sha256::digest(body)));
    }

    #[tokio::test]
    async fn a_recorded_hash_is_reused_and_nothing_is_fetched() {
        let f = served(b"x");
        let mut known = Known::default();
        known.add("v1", &[asset(&"AB".repeat(32), 1, URL)]);
        let mut a = [asset("", 1, URL)];
        assert!(
            fill_hashes("v1", &mut a, &known, &f, true, &mut RUN_BYTES.clone())
                .await
                .is_empty()
        );
        assert_eq!(a[0].sha256, "ab".repeat(32));
        // A source-reported digest is kept as is.
        let mut b = [asset(&"cd".repeat(32), 1, URL)];
        fill_hashes(
            "v1",
            &mut b,
            &Known::default(),
            &f,
            true,
            &mut RUN_BYTES.clone(),
        )
        .await;
        assert_eq!(b[0].sha256, "cd".repeat(32));
        assert!(f.seen.borrow().is_empty());
    }

    /// A run downloads at most its budget for hashing; the rest waits for a later run.
    #[tokio::test]
    async fn the_run_budget_bounds_what_is_downloaded() {
        let body = b"0123456789";
        let fetch = served(body);
        let mut budget = 15;
        let mut assets = [asset("", 10, URL), asset("", 10, URL)];
        assets[1].name = "second".into();
        let w = fill_hashes(
            "v1",
            &mut assets,
            &Known::default(),
            &fetch,
            true,
            &mut budget,
        )
        .await;
        assert!(is_sha256_hex(&assets[0].sha256));
        assert_eq!((assets[1].sha256.as_str(), budget), ("", 5));
        assert!(w[0].contains("budget"), "{w:?}");
        assert_eq!(fetch.seen.borrow().len(), 1, "the second was never fetched");

        // A download that fails still costs what it read (here more than the asset may be).
        let big = served(b"0123456789abcdef");
        let mut budget = 100;
        let mut wrong = [asset("", 4, URL)];
        let w = fill_hashes("v1", &mut wrong, &Known::default(), &big, true, &mut budget).await;
        assert!(w[0].contains("served more than"), "{w:?}");
        assert_eq!(budget, 100 - 6, "the two 3-byte chunks read were charged");
    }

    /// A file downloaded to be sealed (a private destination) is kept only when it is what
    /// the source records: its size, and its digest when the source gives one.
    #[tokio::test]
    async fn a_download_to_seal_is_checked_against_the_source() {
        let body = b"release bytes";
        let sha = hex::encode(Sha256::digest(body));
        let got = |a: ReleaseAsset| async move {
            let (url, limit) = admit(&a, RUN_BYTES).map(|(u, l)| (u.to_string(), l))?;
            download(&a, &url, limit, &served(body)).await
        };
        let n = body.len() as u64;
        assert_eq!(got(asset(&sha, n, URL)).await.unwrap(), body);
        assert_eq!(
            got(asset("", 0, URL)).await.unwrap(),
            body,
            "unsized, no digest"
        );
        let wrong = got(asset(&"00".repeat(32), n, URL)).await.unwrap_err();
        assert!(wrong.to_string().contains("do not match"), "{wrong}");
        let short = got(asset("", n + 1, URL)).await.unwrap_err();
        assert!(short.to_string().contains("not the recorded"), "{short}");
        let big = admit(&asset("", MAX_HASHED_BYTES + 1, URL), RUN_BYTES).unwrap_err();
        assert!(big.to_string().contains("download limit"), "{big}");
    }

    #[tokio::test]
    async fn an_unhashable_asset_keeps_no_hash_and_warns() {
        // Bigger than recorded.
        let mut big = [asset("", 2, URL)];
        let w = fill_hashes(
            "v1",
            &mut big,
            &Known::default(),
            &served(b"abc"),
            true,
            &mut RUN_BYTES.clone(),
        )
        .await;
        assert_eq!((big[0].sha256.as_str(), w.len()), ("", 1));
        assert!(w[0].contains("no SHA-256 recorded"), "{w:?}");
        // Not a public https URL: never fetched.
        let fetch = served(b"x");
        let mut local = [asset("", 1, "http://127.0.0.1:9000/fd")];
        let w = fill_hashes(
            "v1",
            &mut local,
            &Known::default(),
            &fetch,
            true,
            &mut RUN_BYTES.clone(),
        )
        .await;
        assert!(w[0].contains("public https"), "{w:?}");
        assert!(fetch.seen.borrow().is_empty());
        // A dry run fetches nothing and warns about nothing.
        let mut dry = [asset("", 1, URL)];
        let w = fill_hashes(
            "v1",
            &mut dry,
            &Known::default(),
            &fetch,
            false,
            &mut RUN_BYTES.clone(),
        )
        .await;
        assert!(w.is_empty());
        assert!(fetch.seen.borrow().is_empty());
    }
}
