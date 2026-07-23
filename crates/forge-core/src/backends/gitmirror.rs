//! [`GitMirrorBackend`] — an existing git hoster (GitHub / GitLab / Codeberg) as a
//! pack-byte *source*.
//!
//! Scheme `gitmirror://<remote-url>`. Unlike every other backend, a git mirror is
//! **coverage-by-tips, not byte-hash**: the CLI `git fetch`es the remote into a scratch
//! repo and *rebuilds* a self-contained pack locally, so the returned bytes are a fresh
//! `pack-objects` output whose SHA-256 will **not** match any previously-stored
//! `packManifest.packHash`. Integrity therefore does not come from the whole-pack hash
//! here — it comes from the git OIDs, which chain back to the Platform-signed `refUpdate`
//! tips (a rebuilt object that hashes to a wanted OID is the wanted object, whatever pack
//! it arrived in). For this reason a `gitmirror://` URI must be resolved via
//! [`GitMirrorBackend::rebuild_pack`] / the tips-covered clone path, **not** through
//! [`super::verify_and_get`] (which would reject the non-matching whole-pack hash). The
//! manifest records the mirror under `tips` (the refs it covers), not as a hash-verified
//! mirror URI.
//!
//! - **get / rebuild** (`cli-read`): `git clone --mirror <remote>` into a scratch bare
//!   repo, then [`repack_all`] → one consolidated, self-contained pack of every reachable
//!   object. Ranged reads slice the rebuilt bytes.
//! - **push** (`cli-write`): [`GitMirrorBackend::push_mirror`] runs `git push --mirror`
//!   from a local repo, credentialed by git's own auth (the CLI never sees the secret).
//!   The trait [`PackBackend::put`] cannot express this (it has pack bytes, not a source
//!   repo with refs), so it errors and points at `push_mirror`.
//! - **browser**: unsupported — a browser cannot shell out to `git` (badge "CLI-only
//!   source").

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::{ByteRange, Caps, Health, PackBackend, PackMeta, Uri};
use crate::error::{Error, Result};
use crate::pack::{repack_all, Pack};

/// The git-mirror scheme label used in manifest tips/URIs.
pub const GITMIRROR_SCHEME: &str = "gitmirror";

/// A git-hoster-backed pack *source*: fetches + rebuilds packs locally (read) and mirrors
/// a local repo to the remote (write). Stateless — the remote URL travels in each URI.
#[derive(Debug, Clone, Default)]
pub struct GitMirrorBackend {
    _priv: (),
}

impl GitMirrorBackend {
    /// Build a git-mirror backend.
    pub fn new() -> Self {
        Self { _priv: () }
    }

    /// The remote URL out of a `gitmirror://<remote-url>` URI (or a bare URL), erroring on
    /// a foreign scheme. A local path (`gitmirror:///tmp/x.git`) round-trips verbatim.
    pub fn remote_of(uri: &Uri) -> Result<String> {
        match uri.scheme() {
            Some(GITMIRROR_SCHEME) => {
                let rest = uri.rest().unwrap_or_default();
                if rest.is_empty() {
                    return Err(Error::Config(format!(
                        "malformed gitmirror uri (expected gitmirror://<remote-url>): {uri}"
                    )));
                }
                Ok(rest.to_string())
            }
            None => Ok(uri.0.clone()),
            other => Err(Error::Config(format!(
                "gitmirror backend cannot serve uri scheme {other:?}: {uri}"
            ))),
        }
    }

    /// The `gitmirror://<remote>` URI for a remote URL.
    pub fn uri_for(remote: &str) -> Uri {
        Uri(format!("{GITMIRROR_SCHEME}://{remote}"))
    }

    /// Fetch `remote` into a scratch bare repo and rebuild **one** consolidated,
    /// self-contained pack of every reachable object (coverage-by-tips). The returned
    /// [`Pack`] carries the parsed object geometry so callers can confirm wanted OIDs are
    /// present — integrity here is per-OID, never whole-pack-hash (see module docs).
    pub fn rebuild_pack(remote: &str) -> Result<Pack> {
        let scratch = Scratch::new()?;
        let mirror = scratch.dir.join("mirror.git");
        // `clone --mirror` fetches every ref (heads, tags, notes) into a bare repo — the
        // full coverage set. Credentialed transparently by git's own auth for a real
        // hoster; a local path works for tests.
        run_git(
            None,
            &[
                "clone",
                "--mirror",
                "--quiet",
                remote,
                &mirror.to_string_lossy(),
            ],
        )?;
        // Consolidate: `pack-objects --all` over the mirrored refs → 0 REF_DELTA, all OFS
        // bases earlier in the pack (the browse-plane single-span invariant).
        repack_all(&mirror)
    }

    /// Mirror a local repository to `remote` via `git push --mirror`, returning the
    /// `gitmirror://<remote>` URI the manifest records. Credentialed by git's own auth —
    /// the CLI never handles the secret. This is the write path the trait `put` cannot
    /// express (it has pack bytes, not a source repo with refs).
    pub fn push_mirror(local_git_dir: &Path, remote: &str) -> Result<Vec<Uri>> {
        run_git(
            Some(local_git_dir),
            &["push", "--mirror", "--quiet", remote],
        )?;
        Ok(vec![Self::uri_for(remote)])
    }
}

#[async_trait::async_trait]
impl PackBackend for GitMirrorBackend {
    fn scheme(&self) -> &'static str {
        GITMIRROR_SCHEME
    }

    fn caps(&self) -> Caps {
        // CLI read (fetch + rebuild) and CLI write (push --mirror). A browser cannot shell
        // out to git, so both browser capabilities are false ("CLI-only source" badge).
        Caps {
            read_cli: true,
            read_browser: false,
            write_cli: true,
            write_browser: false,
        }
    }

    async fn put(&self, _bytes: &[u8], _meta: &PackMeta) -> Result<Vec<Uri>> {
        Err(Error::Config(
            "the gitmirror backend writes with `git push --mirror` from a source repo, not \
             raw pack bytes; call GitMirrorBackend::push_mirror(local_repo, remote)"
                .into(),
        ))
    }

    async fn get(&self, uri: &Uri, range: Option<ByteRange>) -> Result<Vec<u8>> {
        let remote = Self::remote_of(uri)?;
        // `git clone --mirror` + repack is a blocking subprocess pipeline; the CLI runs
        // one mirror rebuild at a time, so calling it inline (rather than via a spawned
        // blocking task) keeps forge-core free of a tokio runtime dependency.
        let bytes = Self::rebuild_pack(&remote)?.bytes;
        match range {
            None => Ok(bytes),
            Some(r) => {
                let start = usize::try_from(r.start)
                    .map_err(|_| Error::Config("range start overflows usize".into()))?;
                let end = usize::try_from(r.end)
                    .map_err(|_| Error::Config("range end overflows usize".into()))?
                    .min(bytes.len());
                if start >= bytes.len() {
                    return Ok(Vec::new());
                }
                Ok(bytes[start..end].to_vec())
            }
        }
    }

    async fn probe(&self, uri: &Uri) -> Result<Health> {
        // Cheap reachability: `git ls-remote` lists the remote's refs without fetching any
        // objects. `ok` = the remote answered with at least its ref advertisement.
        let remote = Self::remote_of(uri)?;
        let started = std::time::Instant::now();
        let out = run_git(None, &["ls-remote", "--quiet", &remote]);
        let latency = started.elapsed();
        match out {
            Ok(_) => Ok(Health {
                ok: true,
                size: None,
                latency,
            }),
            Err(_) => Ok(Health::down(latency)),
        }
    }
}

/// Run `git [-C cwd] <args>`, returning captured stdout on success (stderr on failure).
fn run_git(cwd: Option<&Path>, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    if let Some(dir) = cwd {
        cmd.arg("-C").arg(dir);
    }
    cmd.args(args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd
        .output()
        .map_err(|e| Error::Io(format!("spawn git: {e}")))?;
    if !out.status.success() {
        return Err(Error::Io(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(out.stdout)
}

/// A uniquely-named scratch directory removed on drop (no runtime `tempfile` dep).
struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new() -> Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("forge-gitmirror-{}-{}", std::process::id(), nanos));
        fs::create_dir_all(&dir).map_err(|e| Error::Io(e.to_string()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| Error::Io(e.to_string()))?;
        }
        Ok(Self { dir })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_of_parses_scheme_and_rejects_foreign() {
        assert_eq!(
            GitMirrorBackend::remote_of(&Uri("gitmirror://https://github.com/o/r.git".into()))
                .unwrap(),
            "https://github.com/o/r.git"
        );
        // A local path target (leading slash after the scheme) round-trips.
        assert_eq!(
            GitMirrorBackend::remote_of(&Uri("gitmirror:///tmp/mirror.git".into())).unwrap(),
            "/tmp/mirror.git"
        );
        assert!(GitMirrorBackend::remote_of(&Uri("ipfs://cid".into())).is_err());
        assert!(GitMirrorBackend::remote_of(&Uri("gitmirror://".into())).is_err());
    }

    #[test]
    fn caps_are_cli_only_source() {
        let caps = GitMirrorBackend::new().caps();
        assert!(caps.read_cli && caps.write_cli);
        assert!(!caps.read_browser && !caps.write_browser);
    }

    // Fetch-rebuild-by-tips against a LOCAL bare repo standing in for the git hoster (no
    // GitHub needed). Exercises: push_mirror → the mirror holds the refs; rebuild_pack →
    // fetch + repack → the rebuilt pack covers the pushed tip's whole object graph
    // (coverage-by-tips, verified per-OID, not by whole-pack hash).
    #[test]
    fn push_mirror_then_rebuild_covers_tips() {
        // A git identity/config so `git commit` works in CI sandboxes.
        let env_ok = std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !env_ok {
            eprintln!("SKIP push_mirror_then_rebuild_covers_tips: git not available");
            return;
        }

        let scratch = Scratch::new().unwrap();
        let src = scratch.dir.join("src");
        let mirror = scratch.dir.join("mirror.git");
        fs::create_dir_all(&src).unwrap();

        let g = |cwd: &Path, args: &[&str]| run_git(Some(cwd), args).unwrap();
        g(&src, &["init", "--quiet", "-b", "main"]);
        g(&src, &["config", "user.email", "t@example.com"]);
        g(&src, &["config", "user.name", "t"]);
        // A developer's global `commit.gpgsign=true` would otherwise block `git commit` on
        // a gpg passphrase prompt in a headless test; force it off for this repo.
        g(&src, &["config", "commit.gpgsign", "false"]);
        g(&src, &["config", "tag.gpgsign", "false"]);
        fs::write(src.join("hello.txt"), b"hi from the mirror\n").unwrap();
        g(&src, &["add", "hello.txt"]);
        g(&src, &["commit", "--quiet", "-m", "seed"]);
        let tip = String::from_utf8(g(&src, &["rev-parse", "HEAD"])).unwrap();
        let tip = tip.trim();

        // Create the bare "hoster" repo, then mirror-push into it.
        run_git(
            None,
            &["init", "--bare", "--quiet", &mirror.to_string_lossy()],
        )
        .unwrap();
        let uris = GitMirrorBackend::push_mirror(&src, &mirror.to_string_lossy()).unwrap();
        assert_eq!(uris.len(), 1);
        assert_eq!(uris[0].scheme(), Some(GITMIRROR_SCHEME));

        // Rebuild a pack straight off the mirror and confirm coverage by tips: the commit,
        // its tree, and the blob are all present in the rebuilt pack.
        let pack = GitMirrorBackend::rebuild_pack(&mirror.to_string_lossy()).unwrap();
        let tip_bytes = hex::decode(tip).unwrap();
        assert!(
            pack.parsed.object(&tip_bytes).is_some(),
            "rebuilt pack must cover the pushed tip commit {tip}"
        );
        // A commit + its root tree + one blob ⇒ at least 3 objects.
        assert!(
            pack.parsed.object_count() >= 3,
            "expected commit+tree+blob, got {}",
            pack.parsed.object_count()
        );
        // Every OID in the rebuilt pack re-hashes to itself (per-OID integrity).
        assert_eq!(
            pack.parsed.verify_all_oids().unwrap(),
            pack.parsed.object_count()
        );
    }
}
