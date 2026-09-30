//! Releases into a private destination, sealed (docs/security/private-repos.md §16).
//!
//! The writer is forge-core's ([`Collab::create_release_stored`]): it seals the revision
//! under the current key epoch, seals and stores new files and the kind-4 asset list on the
//! repository's own storage, and carries forward what a revision does not change. This
//! module decides what each revision states:
//!
//! * **Provenance** (the source's publisher, release page and publish time) is sealed in TLV
//!   13, 14 and 20, and the page is also the asset list's `source`. None of it is plaintext.
//! * **Assets**: every asset of the source release, not only the 4096 bytes a public release
//!   lists. Each one the run can download within its budget ([`crate::assets::RUN_BYTES`],
//!   newest releases first, [`crate::assets::admit`]) is downloaded, checked against the
//!   source's size and digest, and handed to the writer to seal and store. The others are
//!   external links (§16.5): the source URL, inside the sealed list, with no sealed hash. A
//!   later run seals them.
//! * **Idempotency**: a release is written again only when its current revision, opened and
//!   folded, differs from the source: its name, notes or provenance, or a source asset it does
//!   not hold (sealed with the same name, size and digest, or as the same link). An asset
//!   already held sealed is never downloaded again. An asset removed at the source stays
//!   listed: a revision carries its list forward.
//! * **Cost**: one `release` document and, when the asset list changes, one kind-4
//!   `packManifest` ([`sealed_release_credits`]). The files and the list go to your own
//!   storage, which Platform does not charge for.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::{Context, Result};

use forge_core::collab::v2::{check_tag_name, external_link, sealed_provenance, Collab};
use forge_core::collab::{
    Imported, Release, ReleaseAsset, ReleaseFile, ReleaseInput, ReleaseStore, ReleaseWritten,
};
use forge_core::private::release::{fit_notes, ManifestAsset, ReleaseFields, ReleaseManifest};
use forge_core::scope::RepoRef;
use forge_core::storage::{ExternalTarget, ResolvedPolicy, StorageTarget};

use crate::assets::{admit, download, Fetch, RUN_BYTES};
use crate::budget::sealed_release_credits;
use crate::model::SrcRelease;
use crate::sink::Ledger;

/// Where a private destination's sealed release files and asset lists are stored: the
/// storage policy's own (non-Platform) profiles, as for `dg release create` (release assets
/// are external only).
#[derive(Debug, Clone)]
pub struct ReleaseStorage {
    resolved: ResolvedPolicy,
}

impl ReleaseStorage {
    /// The storage policy in `git_dir`'s git config (any scope, as the push reads it);
    /// `None` when it names no storage of your own.
    pub fn from_git_dir(git_dir: &Path) -> Result<Option<Self>> {
        let resolved = crate::gitsync::resolved_storage(git_dir)?;
        Ok((!resolved.external.is_empty()).then_some(Self { resolved }))
    }

    /// Its targets, and how many must confirm each object.
    pub(crate) fn targets(&self) -> Result<ReleaseTargets> {
        let targets = crate::gitsync::external_targets(&self.resolved)?;
        let required = self.resolved.replicas.min(targets.len()).max(1);
        Ok(ReleaseTargets { targets, required })
    }
}

/// [`ReleaseStorage`]'s targets, opened.
pub(crate) struct ReleaseTargets {
    targets: Vec<ExternalTarget>,
    required: usize,
}

impl ReleaseTargets {
    /// As the sealed writer takes them.
    pub(crate) fn store(&self) -> ReleaseStore<'_> {
        ReleaseStore {
            targets: self
                .targets
                .iter()
                .map(|t| t as &dyn StorageTarget)
                .collect(),
            required: self.required,
        }
    }
}

/// What the sealed sync reads from and writes to the destination (a trait so the unit tests
/// run without a network).
pub(crate) trait SealedDest {
    /// The live releases, opened and folded (§16.3).
    async fn current(&self) -> forge_core::Result<Vec<Release>>;
    /// The asset list a revision names (§16.5).
    async fn manifest(&self, fields: &ReleaseFields) -> forge_core::Result<ReleaseManifest>;
    /// Write one revision: seal it, and seal and store its new files and list.
    async fn write(&self, input: &ReleaseInput) -> forge_core::Result<ReleaseWritten>;
    /// How many storage targets the files and lists go to (`None`: no storage of your own).
    fn targets(&self) -> Option<u64>;
}

/// The destination through forge-core.
pub(crate) struct CollabDest<'c, 'a> {
    /// The signer's view of the destination.
    pub collab: &'c Collab<'a>,
    /// The destination.
    pub repo: &'c RepoRef,
    /// Where new files and lists go.
    pub store: Option<ReleaseStore<'c>>,
}

impl SealedDest for CollabDest<'_, '_> {
    async fn current(&self) -> forge_core::Result<Vec<Release>> {
        Ok(self.collab.releases(self.repo).await?.current)
    }

    async fn manifest(&self, fields: &ReleaseFields) -> forge_core::Result<ReleaseManifest> {
        self.collab.release_manifest(self.repo, fields).await
    }

    async fn write(&self, input: &ReleaseInput) -> forge_core::Result<ReleaseWritten> {
        self.collab
            .create_release_stored(self.repo, input, self.store.as_ref())
            .await
    }

    fn targets(&self) -> Option<u64> {
        self.store.as_ref().map(|s| s.targets.len() as u64)
    }
}

/// The most a release's files take in memory while they are sealed: its downloads this run
/// stop there (the rest stay links, and a later run, finding these held, seals more). The
/// writer takes whole files, and seals a copy of each.
pub const RELEASE_BYTES: u64 = 1 << 30;

/// A tag's current revision on the destination, opened.
struct Held {
    fields: ReleaseFields,
    /// Its full notes (the asset list's when they continue there).
    notes: String,
    /// Its asset list.
    assets: Vec<ManifestAsset>,
    /// Its asset list's `source`.
    source: Option<String>,
}

impl Held {
    /// Whether it holds `a` sealed: an entry of its name with a sealed object, the same
    /// size and the same SHA-256, as far as the source records them.
    fn has_sealed(&self, a: &ReleaseAsset) -> bool {
        let sha = external_link(a).sha256;
        self.assets.iter().any(|e| {
            e.name == a.name
                && e.sealed_sha256.is_some()
                && (sha.is_empty() || e.sha256 == sha)
                && (a.size_bytes == 0 || e.size_bytes == a.size_bytes)
        })
    }
}

/// What a revision does with one source asset.
enum Take {
    /// The destination holds it sealed already: carried forward.
    Held,
    /// Download it (at most `limit` bytes from `url`) to seal it.
    Fetch { url: String, limit: u64 },
    /// An external link, and why it is not sealed.
    Link(String),
}

/// One source asset and what the revision does with it.
struct Plan<'r> {
    asset: &'r ReleaseAsset,
    take: Take,
    /// The destination lists it already as this very link: it is carried forward, never
    /// passed again, and a download that fails changes nothing.
    held_link: bool,
}

/// One source release and what its revision would do with each asset.
struct Planned<'r> {
    r: &'r SrcRelease,
    held: Option<Held>,
    assets: Vec<Plan<'r>>,
}

/// Mirror `releases` (newest first, as sources list them) into a private destination as
/// sealed releases. Downloads are planned newest first, so the run's budget goes to the
/// releases people download; revisions are written oldest first, so their `$createdAt`
/// follows the releases' own order.
pub(crate) async fn sync(
    ledger: &mut Ledger<'_>,
    dest: &impl SealedDest,
    releases: &[SrcRelease],
    fetch: &impl Fetch,
) -> Result<()> {
    let current = dest
        .current()
        .await
        .context("reading the destination's releases")?;
    let mut budget = RUN_BYTES;
    let mut planned = Vec::with_capacity(releases.len());
    for r in releases {
        // A tag the destination would refuse skips that release, not the run.
        if let Err(e) = check_tag_name(&r.tag_name) {
            ledger.skip(format!("release not mirrored: {e}"));
            continue;
        }
        let fields = current
            .iter()
            .find(|c| c.tag_name == r.tag_name)
            .and_then(|c| c.sealed.as_ref())
            .map(|s| &s.fields);
        let held = match fields {
            None => None,
            Some(f) => match held(dest, f).await {
                Ok(h) => Some(h),
                Err(e) => {
                    ledger.skip(format!(
                        "release {} not mirrored this run: its asset list on the destination \
                         could not be read ({e:#})",
                        r.tag_name
                    ));
                    continue;
                }
            },
        };
        let assets = plan_assets(r, held.as_ref(), &mut budget);
        planned.push(Planned { r, held, assets });
    }
    for p in planned.into_iter().rev() {
        write_one(ledger, dest, p, fetch).await?;
    }
    Ok(())
}

/// The current revision of a tag with its asset list and full notes.
async fn held(dest: &impl SealedDest, fields: &ReleaseFields) -> forge_core::Result<Held> {
    let list = match fields.asset_manifest {
        Some(_) => Some(dest.manifest(fields).await?),
        None => None,
    };
    let notes = match &list {
        Some(m) if fields.notes_continue => m.notes.clone(),
        _ => fields.notes.clone(),
    };
    let (assets, source) = list.map_or((Vec::new(), None), |m| (m.assets, m.source));
    Ok(Held {
        fields: fields.clone(),
        notes: notes.unwrap_or_default(),
        assets,
        source,
    })
}

/// What `r`'s revision does with each of its assets (every one: a sealed list has no 4096-byte
/// cap), reserving each download's most out of the run's `budget` and the release's
/// [`RELEASE_BYTES`]. An asset the destination holds sealed is never downloaded again.
fn plan_assets<'r>(r: &'r SrcRelease, held: Option<&Held>, budget: &mut u64) -> Vec<Plan<'r>> {
    let mut names = BTreeSet::new();
    let mut in_memory = RELEASE_BYTES;
    r.assets
        .iter()
        .chain(&r.omitted)
        // a list names each asset once, by a name and at least one URL
        .filter(|a| !a.name.is_empty() && a.uris.iter().any(|u| !u.is_empty()))
        .filter(|a| names.insert(a.name.as_str()))
        .map(|asset| {
            let held_link = held.is_some_and(|h| h.assets.contains(&external_link(asset)));
            let take = if held.is_some_and(|h| h.has_sealed(asset)) {
                Take::Held
            } else {
                match admit(asset, *budget) {
                    Ok((_, limit)) if limit > in_memory => Take::Link(format!(
                        "this release already downloads {RELEASE_BYTES} bytes to seal this \
                         run; a later run takes it"
                    )),
                    Ok((url, limit)) => {
                        *budget -= limit;
                        in_memory -= limit;
                        Take::Fetch {
                            url: url.to_string(),
                            limit,
                        }
                    }
                    Err(e) => Take::Link(format!("{e:#}")),
                }
            };
            Plan {
                asset,
                take,
                held_link,
            }
        })
        .collect()
}

/// The provenance `r`'s revision seals: its page, publisher and publish time. None without a
/// page of at most 300 bytes (the sealed record's cap; provenance needs its URL, §16.2).
fn provenance(r: &SrcRelease) -> Option<Imported> {
    if r.source_url.is_empty() || r.source_url.len() > 300 {
        return None;
    }
    let published = r.published.as_ref();
    Some(Imported {
        // the release writer's cap (§16.2): ≤ 64 chars, ≤ 256 B
        author: crate::model::clip(published.map_or("", |p| p.author.as_str()), 64, 256),
        created_at: published.map_or(0, |p| p.at),
        url: r.source_url.clone(),
    })
}

/// `r`'s notes as a sealed revision states them: without the "Published on …" line that
/// opens a public release's, when the provenance it repeats is `sealed` ([`provenance`]).
fn sealed_notes(r: &SrcRelease, sealed: bool) -> &str {
    let head = crate::model::published_line(r.published.as_ref());
    if !sealed || head.is_empty() {
        return &r.notes;
    }
    r.notes
        .strip_prefix(head.as_str())
        // a release with no notes of its own has only the line, trimmed
        .or_else(|| (r.notes == head.trim_end()).then_some(""))
        .unwrap_or(&r.notes)
}

/// Whether `held` states what `r` would: its name, `notes` and its provenance. An empty
/// field is not stated (the writer carries the held one forward).
fn same_statement(held: &Held, r: &SrcRelease, notes: &str, imported: Option<&Imported>) -> bool {
    let f = &held.fields;
    (r.name.is_empty() || f.name.as_deref() == Some(r.name.as_str()))
        && (notes.is_empty() || held.notes == notes)
        && imported.is_none_or(|i| {
            sealed_provenance(i)
                == (
                    f.imported_author.clone(),
                    f.imported_url.clone(),
                    f.imported_created_at,
                )
        })
}

/// Whether the revision stores a new asset list (priced, and needing storage), as the writer
/// decides it: `changes` (new files or links), or notes that do not fit `enc` beside the
/// revision's other fields (carried from `held`), or a held list whose notes or `source` the
/// revision changes.
fn new_list(p: &Planned<'_>, notes: &str, imported: Option<&Imported>, changes: bool) -> bool {
    let held = p.held.as_ref();
    let mut fields = held.map(|h| h.fields.clone()).unwrap_or_default();
    fields.tag.clone_from(&p.r.tag_name);
    if !p.r.name.is_empty() {
        fields.name = Some(p.r.name.clone());
    }
    if let Some(i) = imported {
        (
            fields.imported_author,
            fields.imported_url,
            fields.imported_created_at,
        ) = sealed_provenance(i);
    }
    let listed = !p.assets.is_empty() || held.is_some_and(|h| !h.assets.is_empty());
    fields.asset_manifest = listed.then(|| "00".repeat(32));
    let notes = if notes.is_empty() {
        held.map_or("", |h| h.notes.as_str())
    } else {
        notes
    };
    let (_, notes_continue) = fit_notes(fields, notes);
    let source_moves = imported.is_some_and(|i| {
        held.is_some_and(|h| {
            h.fields.asset_manifest.is_some() && h.source.as_deref() != Some(i.url.as_str())
        })
    });
    changes || notes_continue || held.is_some_and(|h| h.fields.notes_continue) || source_moves
}

/// Whether a sealed write's failure concerns that release only (its content, its storage, its
/// asset list, a rotation during its upload): it is skipped, and the run carries on with the
/// rest (issues and PRs come after the releases). The spend cap, the network and a missing
/// permission stop the run.
fn release_error(e: &anyhow::Error) -> bool {
    use forge_core::Error;
    e.chain().any(|c| {
        matches!(
            c.downcast_ref::<Error>(),
            Some(
                Error::Config(_)
                    | Error::User(_)
                    | Error::Integrity
                    | Error::DuplicateUniqueIndex(_)
                    | Error::RuleRefused { .. }
            )
        )
    })
}

/// What a revision's assets came to once downloaded ([`gather`]).
struct Gathered<'r> {
    /// The files downloaded, to be sealed.
    files: Vec<ReleaseFile>,
    /// The links the destination does not list yet, and why each is not sealed.
    new_links: Vec<(&'r ReleaseAsset, String)>,
    /// Every asset of the revision that is a link, held or new.
    linked: u64,
}

/// Download what `assets` seal (a dry run downloads nothing); a failed download is a link.
async fn gather<'r>(assets: &[Plan<'r>], dry: bool, fetch: &impl Fetch) -> Gathered<'r> {
    let mut out = Gathered {
        files: Vec::new(),
        new_links: Vec::new(),
        linked: 0,
    };
    for a in assets {
        let why = match &a.take {
            Take::Held => continue,
            Take::Fetch { .. } if dry => continue,
            Take::Fetch { url, limit } => match download(a.asset, url, *limit, fetch).await {
                Ok(bytes) => {
                    out.files.push(ReleaseFile {
                        name: a.asset.name.clone(),
                        bytes,
                    });
                    continue;
                }
                Err(e) => format!("{e:#}"),
            },
            Take::Link(why) => why.clone(),
        };
        out.linked += 1;
        // a link the destination lists already is carried forward, not passed again
        if !a.held_link {
            out.new_links.push((a.asset, why));
        }
    }
    out
}

/// Write `p`'s revision unless the destination states it already: download what it seals
/// (a failed download becomes a link), then write through the ledger.
async fn write_one(
    ledger: &mut Ledger<'_>,
    dest: &impl SealedDest,
    p: Planned<'_>,
    fetch: &impl Fetch,
) -> Result<()> {
    let r = p.r;
    let tag = &r.tag_name;
    let imported = provenance(r);
    let notes = sealed_notes(r, imported.is_some());
    let dry = ledger.dry_run();
    let stated = p
        .held
        .as_ref()
        .is_some_and(|h| same_statement(h, r, notes, imported.as_ref()));
    // What may change: a download (a dry run does not count the retry of an asset listed as
    // this link: it most likely fails again), or a new link.
    let changes = p.assets.iter().any(|a| match a.take {
        Take::Held => false,
        Take::Fetch { .. } => !(dry && a.held_link),
        Take::Link(_) => !a.held_link,
    });
    if stated && !changes {
        return Ok(());
    }
    let what = format!("release {tag}");
    let targets = dest.targets();
    let price = |changes| {
        sealed_release_credits(
            new_list(&p, notes, imported.as_ref(), changes),
            targets.unwrap_or(0),
        )
    };
    if targets.is_none() && new_list(&p, notes, imported.as_ref(), changes) {
        ledger.skip(format!(
            "release {tag} not mirrored: a private release's files and asset list (and notes \
             past its 1507 bytes) are stored on your own storage, and the storage policy names \
             none (`dg storage add`, then `dg storage use <name> --global`)"
        ));
        return Ok(());
    }
    // The spend cap is checked before anything is downloaded (the charge below refuses).
    let upper = price(changes);
    if !ledger.budget.fits(upper) {
        ledger.budget.charge(upper, what.clone())?;
    }
    let Gathered {
        files,
        new_links,
        linked,
    } = gather(&p.assets, dry, fetch).await;
    // only downloads (a real run) can take changes back: each one that fails for an asset
    // listed as this link changes nothing
    let changes = changes && (dry || !files.is_empty() || !new_links.is_empty());
    if stated && !changes {
        return Ok(());
    }
    for (a, why) in &new_links {
        ledger.warn(format!(
            "release {tag} asset {:?}: not sealed ({why}); listed as a link to the source, \
             unverified, until a later run seals it",
            a.name
        ));
    }
    ledger.counts.assets_linked += linked;
    let credits = price(changes);
    let input = ReleaseInput {
        tag_name: tag.clone(),
        name: r.name.clone(),
        notes: notes.to_string(),
        assets: new_links.into_iter().map(|(a, _)| a.clone()).collect(),
        files,
        imported,
        ..ReleaseInput::default()
    };
    let input = &input;
    let written = ledger
        .write(what, credits, |c| c.releases += 1, || dest.write(input))
        .await;
    match written {
        Ok(Some(w)) => {
            // each names the release already
            for msg in w.warnings {
                ledger.warn(msg);
            }
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(e) => {
            let one = release_error(&e);
            ledger.refused_release(tag, e, one)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use sha2::{Digest as _, Sha256};

    use forge_core::collab::SealedRelease;

    /// forge-core's sealed writer, in memory ([`Collab::create_release_stored`]): a revision
    /// carries the tag's last one forward (name, notes, provenance, the list's other entries
    /// and `source`), its files are "sealed", its links listed as given, and notes that do not
    /// fit `enc` continue in the list ([`fit_notes`]).
    #[derive(Default)]
    struct Fake {
        /// Tag → the current revision's fields and asset list.
        held: RefCell<BTreeMap<String, (ReleaseFields, ReleaseManifest)>>,
        writes: RefCell<Vec<ReleaseInput>>,
        no_storage: bool,
        /// Each write fails with this.
        fail: Option<fn() -> forge_core::Error>,
    }

    fn hex_sha(b: &[u8]) -> String {
        hex::encode(Sha256::digest(b))
    }

    fn empty_list(tag: &str) -> ReleaseManifest {
        ReleaseManifest {
            v: 1,
            tag: tag.into(),
            total: 0,
            source: None,
            notes: None,
            assets: Vec::new(),
        }
    }

    #[allow(clippy::unused_async_trait_impl)] // a test double: nothing to await
    impl SealedDest for Fake {
        async fn current(&self) -> forge_core::Result<Vec<Release>> {
            Ok(self
                .held
                .borrow()
                .values()
                .map(|(f, _)| Release {
                    document_id: "doc".into(),
                    tag_name: f.tag.clone(),
                    name: f.name.clone().unwrap_or_default(),
                    notes: f.notes.clone().unwrap_or_default(),
                    yanked: false,
                    assets: Vec::new(),
                    publisher: "me".into(),
                    created_at: 1,
                    delta: 0,
                    sealed: Some(SealedRelease {
                        epoch: 0,
                        fields: f.clone(),
                    }),
                })
                .collect())
        }

        async fn manifest(&self, fields: &ReleaseFields) -> forge_core::Result<ReleaseManifest> {
            Ok(self.held.borrow()[&fields.tag].1.clone())
        }

        async fn write(&self, input: &ReleaseInput) -> forge_core::Result<ReleaseWritten> {
            if let Some(fail) = self.fail {
                return Err(fail());
            }
            self.writes.borrow_mut().push(input.clone());
            let tag = &input.tag_name;
            let mut held = self.held.borrow_mut();
            let (prev, list) = held
                .remove(tag)
                .unwrap_or_else(|| (ReleaseFields::default(), empty_list(tag)));
            let notes = match input.notes.as_str() {
                "" if prev.notes_continue => list.notes.clone().unwrap_or_default(),
                "" => prev.notes.clone().unwrap_or_default(),
                n => n.to_string(),
            };
            let mut assets = list.assets.clone();
            assets.retain(|a| {
                !input.files.iter().any(|f| f.name == a.name)
                    && !input.assets.iter().any(|l| l.name == a.name)
            });
            assets.extend(input.files.iter().map(|f| ManifestAsset {
                name: f.name.clone(),
                sha256: hex_sha(&f.bytes),
                size_bytes: f.bytes.len() as u64,
                uris: vec!["s3://mine/sealed".into()],
                sealed_sha256: Some("5e".repeat(32)),
                sealed_size_bytes: Some(f.bytes.len() as u64 + 52),
            }));
            assets.extend(input.assets.iter().map(external_link));
            let (imported_author, imported_url, imported_created_at) =
                input.imported.as_ref().map_or_else(
                    || {
                        (
                            prev.imported_author.clone(),
                            prev.imported_url.clone(),
                            prev.imported_created_at,
                        )
                    },
                    sealed_provenance,
                );
            let (mut fields, notes_continue) = fit_notes(
                ReleaseFields {
                    tag: tag.clone(),
                    name: Some(input.name.clone())
                        .filter(|n| !n.is_empty())
                        .or(prev.name),
                    imported_author,
                    imported_url,
                    imported_created_at,
                    asset_manifest: (!assets.is_empty()).then(|| "4a".repeat(32)),
                    ..ReleaseFields::default()
                },
                &notes,
            );
            if !assets.is_empty() || notes_continue {
                fields.asset_manifest = Some("4a".repeat(32));
            }
            let source = input
                .imported
                .as_ref()
                .map(|i| i.url.clone())
                .or(list.source);
            let list = ReleaseManifest {
                total: assets.len() as u64,
                source,
                notes: notes_continue.then_some(notes),
                assets,
                ..empty_list(tag)
            };
            held.insert(tag.clone(), (fields, list));
            Ok(ReleaseWritten::default())
        }

        fn targets(&self) -> Option<u64> {
            (!self.no_storage).then_some(1)
        }
    }

    /// The source's files by URL (`None`: the host refuses it), and every URL requested.
    #[derive(Default)]
    struct Source {
        files: BTreeMap<String, Option<Vec<u8>>>,
        seen: RefCell<Vec<String>>,
    }

    impl Fetch for Source {
        #[allow(clippy::unused_async_trait_impl)] // a test double: nothing to await
        async fn fetch(&self, url: &str, limit: u64, sink: &mut dyn FnMut(&[u8])) -> Result<u64> {
            self.seen.borrow_mut().push(url.to_string());
            let Some(Some(body)) = self.files.get(url) else {
                anyhow::bail!("404 Not Found");
            };
            anyhow::ensure!(body.len() as u64 <= limit, "too big");
            sink(body);
            Ok(body.len() as u64)
        }
    }

    const PAGE: &str = "https://github.com/o/r/releases/tag/v1.0.0";
    const FD: &str = "https://github.com/o/r/releases/download/v1.0.0/fd.tar.gz";
    const GONE: &str = "https://github.com/o/r/releases/download/v1.0.0/gone.bin";
    const ISO: &str = "https://github.com/o/r/releases/download/v1.0.0/big.iso";
    const BODY: &[u8] = b"the release's bytes";

    fn asset(name: &str, url: &str, size: u64, sha: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.into(),
            sha256: sha.into(),
            size_bytes: size,
            uris: vec![url.into()],
            uri: None,
        }
    }

    fn published(author: &str) -> crate::model::Published {
        crate::model::Published {
            host: "github.com".into(),
            author: author.into(),
            at: 1_700_000_000,
        }
    }

    /// A GitHub release as the source reads it (its notes open with the "Published on" line):
    /// one file it can fetch (with GitHub's digest), one whose host refuses it, and one past
    /// the download limit (left out of a public release's 4096 bytes).
    fn release(notes: &str) -> SrcRelease {
        let p = published("octocat");
        SrcRelease {
            tag_name: "v1.0.0".into(),
            name: "One".into(),
            notes: format!("{}{notes}", crate::model::published_line(Some(&p))),
            assets: vec![
                asset("fd.tar.gz", FD, BODY.len() as u64, &hex_sha(BODY)),
                asset("gone.bin", GONE, 5, ""),
            ],
            omitted: vec![asset("big.iso", ISO, 3 << 30, "")],
            source_url: PAGE.into(),
            published: Some(p),
        }
    }

    fn source() -> Source {
        Source {
            files: [
                (FD.to_string(), Some(BODY.to_vec())),
                (GONE.to_string(), None),
            ]
            .into(),
            ..Source::default()
        }
    }

    async fn run(dest: &Fake, releases: &[SrcRelease], src: &Source) -> Ledger<'static> {
        let mut ledger = Ledger::offline(false);
        sync(&mut ledger, dest, releases, src).await.unwrap();
        ledger
    }

    #[tokio::test]
    async fn a_private_release_is_sealed_with_its_provenance_files_and_links() {
        let (dest, src) = (Fake::default(), source());
        let ledger = run(&dest, &[release("notes")], &src).await;

        let writes = dest.writes.borrow();
        assert_eq!(writes.len(), 1);
        let w = &writes[0];
        // provenance goes to the sealed writer, never to a plaintext field, and the notes do
        // not repeat it
        let imp = w.imported.as_ref().expect("provenance");
        assert_eq!(
            (imp.author.as_str(), imp.url.as_str(), imp.created_at),
            ("octocat", PAGE, 1_700_000_000)
        );
        assert_eq!(w.notes, "notes");
        // the fetchable file is handed over to be sealed, checked against GitHub's digest
        assert_eq!(w.files.len(), 1);
        assert_eq!(
            (w.files[0].name.as_str(), &w.files[0].bytes[..]),
            ("fd.tar.gz", BODY)
        );
        // the refused one and the one past the limit are external links
        let links: Vec<_> = w.assets.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(links, ["gone.bin", "big.iso"]);

        let held = dest.held.borrow();
        let (fields, list) = &held["v1.0.0"];
        assert_eq!(fields.imported_url.as_deref(), Some(PAGE));
        assert_eq!(fields.imported_created_at, Some(1_700_000_000_000), "ms");
        assert_eq!(list.source.as_deref(), Some(PAGE));
        let fd = list.assets.iter().find(|a| a.name == "fd.tar.gz").unwrap();
        assert!(fd.sealed_sha256.is_some() && fd.sha256 == hex_sha(BODY));
        let gone = list.assets.iter().find(|a| a.name == "gone.bin").unwrap();
        assert_eq!(
            (gone.sha256.as_str(), gone.sealed_sha256.as_ref()),
            ("", None)
        );
        assert_eq!(gone.uris, [GONE]);

        assert_eq!(
            (ledger.counts.releases, ledger.counts.assets_linked),
            (1, 2)
        );
        let warned = ledger.warnings.join("\n");
        assert!(warned.contains("\"gone.bin\": not sealed (404"), "{warned}");
        assert!(
            warned.contains("\"big.iso\": not sealed (it is larger"),
            "{warned}"
        );
        assert_eq!(
            ledger.budget.spent(),
            sealed_release_credits(true, 1),
            "the release and a new asset list"
        );
    }

    #[tokio::test]
    async fn a_rerun_writes_nothing_and_downloads_no_sealed_file_again() {
        let (dest, src) = (Fake::default(), source());
        run(&dest, &[release("notes")], &src).await;
        src.seen.borrow_mut().clear();

        let again = run(&dest, &[release("notes")], &src).await;
        assert_eq!(
            dest.writes.borrow().len(),
            1,
            "unchanged: not written again"
        );
        assert_eq!(again.counts, crate::summary::Counts::default());
        assert!(again.warnings.is_empty(), "{:?}", again.warnings);
        assert_eq!(again.budget.spent(), 0);
        // the sealed file is held: only the refused link is tried again
        assert_eq!(*src.seen.borrow(), [GONE]);
        // a dry run does not count that retry as a write
        let mut dry = Ledger::offline(true);
        sync(&mut dry, &dest, &[release("notes")], &src)
            .await
            .unwrap();
        assert_eq!((dry.counts.releases, dry.budget.spent()), (0, 0));

        // new notes at the source: a new revision, which carries the sealed file and the
        // links forward rather than passing them again
        run(&dest, &[release("new notes")], &src).await;
        let writes = dest.writes.borrow();
        assert_eq!(writes.len(), 2);
        assert!(writes[1].files.is_empty() && writes[1].assets.is_empty());
        assert_eq!(writes[1].notes, "new notes");
        let held = dest.held.borrow();
        let names: Vec<_> = held["v1.0.0"]
            .1
            .assets
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert_eq!(names, ["fd.tar.gz", "gone.bin", "big.iso"]);
    }

    /// Notes past the 1507 bytes of `enc` continue in the sealed list, and an empty author
    /// seals none: a re-run compares both as the reader opens them, and writes nothing.
    #[tokio::test]
    async fn long_notes_and_an_anonymous_publisher_are_stable_across_runs() {
        let (dest, src) = (Fake::default(), source());
        let mut r = release(&"é".repeat(2000));
        r.published = Some(published(""));
        r.notes = format!(
            "{}{}",
            crate::model::published_line(r.published.as_ref()),
            "é".repeat(2000)
        );
        run(&dest, std::slice::from_ref(&r), &src).await;
        let (fields, list) = dest.held.borrow()["v1.0.0"].clone();
        assert!(fields.notes_continue && list.notes.is_some());
        assert_eq!(fields.imported_author, None);
        let again = run(&dest, &[r], &src).await;
        assert_eq!(dest.writes.borrow().len(), 1);
        assert_eq!(again.counts.releases, 0);
    }

    #[tokio::test]
    async fn a_link_the_host_now_serves_is_sealed_by_a_later_run() {
        let (dest, mut src) = (Fake::default(), source());
        run(&dest, &[release("n")], &src).await;
        src.files.insert(GONE.into(), Some(b"12345".to_vec()));
        let later = run(&dest, &[release("n")], &src).await;
        let writes = dest.writes.borrow();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[1].files[0].name, "gone.bin");
        assert_eq!(
            later.counts.assets_linked, 1,
            "only big.iso is still a link"
        );
    }

    /// Sources list releases newest first; they are written oldest first.
    #[tokio::test]
    async fn releases_are_written_oldest_first() {
        let (dest, src) = (Fake::default(), source());
        let newer = SrcRelease {
            tag_name: "v2.0.0".into(),
            ..release("n")
        };
        run(&dest, &[newer, release("n")], &src).await;
        let tags: Vec<_> = dest
            .writes
            .borrow()
            .iter()
            .map(|w| w.tag_name.clone())
            .collect();
        assert_eq!(tags, ["v1.0.0", "v2.0.0"]);
    }

    /// A write failure that concerns one release (its storage, its asset list, a rotation
    /// during the upload) skips it, and the run carries on to the issues and PRs; the network
    /// stops the run.
    #[tokio::test]
    async fn a_release_failure_skips_it_and_a_network_failure_stops_the_run() {
        let src = source();
        let storage = Fake {
            fail: Some(|| forge_core::Error::Config("the storage policy was not met".into())),
            ..Fake::default()
        };
        let ledger = run(&storage, &[release("n")], &src).await;
        assert_eq!((ledger.counts.releases, ledger.counts.skipped), (0, 1));
        assert!(ledger
            .warnings
            .iter()
            .any(|w| w.contains("not mirrored this run")));

        let network = Fake {
            fail: Some(|| forge_core::Error::Platform("connection reset".into())),
            ..Fake::default()
        };
        let mut ledger = Ledger::offline(false);
        assert!(sync(&mut ledger, &network, &[release("n")], &src)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_dry_run_prices_without_downloading_and_no_storage_skips() {
        let (dest, src) = (Fake::default(), source());
        let mut dry = Ledger::offline(true);
        sync(&mut dry, &dest, &[release("n")], &src).await.unwrap();
        assert!(dest.writes.borrow().is_empty() && src.seen.borrow().is_empty());
        assert_eq!(dry.counts.releases, 1);
        assert_eq!(dry.budget.spent(), sealed_release_credits(true, 1));

        // without storage of your own, a release with files is skipped (the run is partial)
        let bare = Fake {
            no_storage: true,
            ..Fake::default()
        };
        let ledger = run(&bare, &[release("n")], &src).await;
        assert!(bare.writes.borrow().is_empty());
        assert_eq!(ledger.counts.skipped, 1);
        assert!(ledger.warnings[0].contains("storage policy names none"));
        // one with no asset and short notes needs none
        let plain = SrcRelease {
            assets: Vec::new(),
            omitted: Vec::new(),
            ..release("n")
        };
        run(&bare, &[plain], &src).await;
        assert_eq!(bare.writes.borrow().len(), 1);
    }

    /// A release's downloads stop at [`RELEASE_BYTES`] held in memory; the rest are links.
    #[test]
    fn a_releases_downloads_are_capped_in_memory() {
        let half = RELEASE_BYTES / 2 + 1;
        let r = SrcRelease {
            assets: vec![asset("a", FD, half, ""), asset("b", GONE, half, "")],
            omitted: Vec::new(),
            ..release("n")
        };
        let mut budget = RUN_BYTES;
        let plan = plan_assets(&r, None, &mut budget);
        assert!(matches!(plan[0].take, Take::Fetch { .. }));
        assert!(matches!(&plan[1].take, Take::Link(why) if why.contains("a later run")));
        assert_eq!(budget, RUN_BYTES - half);
    }

    #[test]
    fn provenance_needs_a_page_and_keeps_the_writers_caps() {
        let mut r = release("n");
        r.published.as_mut().unwrap().author = "é".repeat(100);
        let p = provenance(&r).unwrap();
        assert_eq!(p.author.chars().count(), 64);
        r.source_url = format!("https://github.com/{}", "x".repeat(300));
        assert!(provenance(&r).is_none(), "past TLV 14's 300 bytes");
        assert!(
            sealed_notes(&r, false).starts_with("> Published"),
            "kept without provenance"
        );
        r.source_url = String::new();
        assert!(provenance(&r).is_none());
        // no notes of its own: only the trimmed line, which provenance replaces
        let mut bare = release("");
        bare.notes = bare.notes.trim_end().to_string();
        assert_eq!(sealed_notes(&bare, true), "");
    }
}
