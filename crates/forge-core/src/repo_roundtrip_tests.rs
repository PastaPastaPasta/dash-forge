//! Offline RC1 push → clone round trip.
//!
//! No Platform: the documents a push writes are built by the production builders (chunk
//! documents, [`PackManifestInput::props`], `public_ref_props`, the create config) and
//! recorded in memory, as Platform would store them. The clone then reads them back the way
//! the helper does: manifests through `manifest_info`, a pack's chunks by its `platform://`
//! locator and the `chunk_filters` query (matched with strict type equality, so an identifier
//! `packHash` must be queried as one), refs through the public fold ([`GitState`] +
//! [`rules::resolve_ref`]), and the default branch from the config in force. The packs are
//! indexed into an empty bare repository and a `git clone` of it must equal the source.
//!
//! A second test stores the packs on the local S3 fixture (RustFS, `make infra-up`) instead of
//! Platform and clones from the manifest's URIs; it skips when that store is down.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

use super::{manifest_info, public_ref_props, PackManifestInput};
use crate::backends::platform::{chunk_documents, decode_chunk_doc, PlatformLocator};
use crate::backends::{PackBackend, PackMeta, Uri};
use crate::platform::{FetchedDocument, FieldValue, QueryFilter};
use crate::refs::GitState;
use crate::rules;
use crate::scope::DocScope;

const OWNER: [u8; 32] = [7; 32];

/// The documents a push wrote, as Platform holds them.
#[derive(Default)]
struct Recorded {
    docs: Vec<(&'static str, FetchedDocument)>,
}

impl Recorded {
    /// Record one create by [`OWNER`], `$createdAt` in write order.
    fn create(&mut self, doc_type: &'static str, fields: BTreeMap<String, FieldValue>) {
        // TODO(rc1-validate): validate `fields` against the RC1 contract with 5b's
        // `test_support::rc1::validate_props(doc_type, &fields, OWNER)` once it lands.
        let n = self.docs.len() as u64;
        self.docs.push((
            doc_type,
            FetchedDocument {
                id: format!("doc{n:04}"),
                owner_id: crate::platform::encode_identifier(OWNER),
                created_at: Some(1_000 + n),
                created_at_block_height: Some(100 + n),
                updated_at_block_height: None,
                fields,
                revision: None,
            },
        ));
    }

    /// Every recorded document of `doc_type`, in write order.
    fn of(&self, doc_type: &str) -> Vec<FetchedDocument> {
        self.docs
            .iter()
            .filter(|(t, _)| *t == doc_type)
            .map(|(_, d)| d.clone())
            .collect()
    }

    /// A query's `==` filters, with Platform's strictness on types: an identifier field
    /// matches only an identifier operand.
    fn query(&self, doc_type: &str, filters: &[QueryFilter]) -> Vec<FetchedDocument> {
        self.of(doc_type)
            .into_iter()
            .filter(|d| {
                filters.iter().all(|f| match f.field.as_str() {
                    "$ownerId" => {
                        f.value
                            == FieldValue::identifier(
                                crate::platform::decode_identifier(&d.owner_id).unwrap(),
                            )
                    }
                    field => d.fields.get(field) == Some(&f.value),
                })
            })
            .collect()
    }
}

/// Run `git` in `dir` with a fixed identity and no user config; its trimmed stdout.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// Write `file` and commit it; the new commit's oid.
fn commit(dir: &Path, file: &str, body: &str, msg: &str) -> String {
    std::fs::write(dir.join(file), body).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
    git(dir, &["rev-parse", "HEAD"])
}

/// Where a push stores its packs.
enum Store<'a> {
    /// `chunk` documents, recorded with the rest.
    Platform,
    /// An external backend: the manifest records its URIs (`storage` 1).
    External(&'a dyn PackBackend),
}

/// One push: the pack of `wants` over `haves`, stored in `store`, its manifest, and one ref
/// update per `(name, new, prev)`.
async fn push(
    rec: &mut Recorded,
    scope: &DocScope,
    src: &Path,
    store: &Store<'_>,
    wants: &[&str],
    haves: &[&str],
    refs: &[(&str, &str, Option<&str>)],
) {
    let pack = crate::pack::build_pack(src, wants, haves).unwrap();
    let meta = PackMeta::for_bytes(&pack.bytes);
    let hash = meta.pack_hash_bytes().unwrap();
    let owner = crate::platform::encode_identifier(OWNER);
    let (storage, chunk_count, uris) = match store {
        Store::Platform => {
            let docs = chunk_documents(&pack.bytes, hash);
            let n = docs.len() as u64;
            for (_, props) in docs {
                rec.create("chunk", scope.scoped(props));
            }
            (0, n, vec![scope.locator(&owner, &meta.pack_hash)])
        }
        Store::External(backend) => {
            let uris = backend.put(&pack.bytes, &meta).await.unwrap();
            (1, 0, uris.into_iter().map(|u| u.0).collect())
        }
    };
    let manifest = PackManifestInput {
        pack_hash: hash,
        kind: u64::from(crate::pack::KIND_GIT_PACK),
        size_bytes: pack.bytes.len() as u64,
        object_count: pack.parsed.object_count() as u64,
        chunk_count,
        storage,
        uris,
        supersedes: Vec::new(),
        tips: Vec::new(),
    };
    rec.create("packManifest", manifest.props(scope).unwrap());
    for (name, new, prev) in refs {
        let new = hex::decode(new).unwrap();
        let prev = prev.map(|p| hex::decode(p).unwrap());
        super::check_ref_write(name, &new, prev.as_deref()).unwrap();
        let props = public_ref_props(scope, name, &new, prev.as_deref(), false).unwrap();
        rec.create("refUpdate", props);
    }
}

/// Read a pack back as the helper does: from its `platform://` locator's chunks, or from the
/// first external URI whose bytes hash to it.
async fn read_pack(rec: &Recorded, m: &super::PackManifestInfo, store: &Store<'_>) -> Vec<u8> {
    let hash_hex = hex::encode(m.pack_hash);
    if m.storage == 1 {
        let Store::External(backend) = store else {
            panic!("an external copy needs its backend");
        };
        return crate::backends::verify_and_get(*backend, &Uri(m.uris[0].clone()), &hash_hex)
            .await
            .unwrap();
    }
    let loc = PlatformLocator::parse(&Uri(m.uris[0].clone())).unwrap();
    let filters = loc
        .scope()
        .unwrap()
        .chunk_filters(&loc.owner, loc.pack_hash)
        .unwrap();
    let mut chunks: Vec<_> = rec
        .query("chunk", &filters)
        .iter()
        .map(|d| decode_chunk_doc(&d.fields).unwrap())
        .collect();
    chunks.sort_by_key(|c| c.seq);
    assert_eq!(
        chunks.len() as u64,
        m.chunk_count,
        "every chunk is found by its identifier packHash"
    );
    let bytes = crate::pack::join(&chunks);
    assert_eq!(hex::encode(crate::backends::sha256(&bytes)), hash_hex);
    bytes
}

/// Clone what `rec` holds into a new bare repository: every git pack indexed, every ref the
/// public fold resolves, `HEAD` at the config's default branch.
async fn clone(rec: &Recorded, dst: &Path, store: &Store<'_>) {
    git(dst, &["init", "-q", "--bare"]);
    let mut manifests: Vec<_> = rec
        .of("packManifest")
        .iter()
        .map(|d| manifest_info(d).unwrap())
        .collect();
    manifests.sort_by_key(|m| m.created_at);
    for m in manifests.iter().filter(|m| m.kind == 0) {
        let bytes = read_pack(rec, m, store).await;
        let mut child = Command::new("git")
            .arg("-C")
            .arg(dst)
            .args(["index-pack", "--stdin", "--strict"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        assert!(child.wait().unwrap().success(), "index-pack");
    }
    let state = GitState::from_rows([
        rec.of("refUpdate"),
        rec.of("protectedRefUpdate"),
        rec.of("config"),
    ]);
    let configs = state.config_history();
    for (hash, updates) in state.ref_histories() {
        let hash_hex = hex::encode(hash);
        let name = rules::display_ref_name(&updates, &hash_hex)
            .unwrap()
            .to_string();
        let tip = rules::tip_of(&rules::resolve_ref(
            &updates,
            &configs,
            &hash_hex,
            |a, b| a == b,
        ))
        .unwrap();
        git(dst, &["update-ref", &name, &tip]);
    }
    let branch = state
        .newest_config()
        .unwrap()
        .field_str("defaultBranch")
        .unwrap();
    git(
        dst,
        &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")],
    );
}

/// The source repository and the pushes of the round trip: `main` and an annotated tag, then
/// `main` moved on (an incremental pack over the first) with a branch whose name exercises
/// the grammar (`@` without `{`, a `.` inside a component, a slash).
async fn round_trip(store: &Store<'_>) {
    let src = tempfile::TempDir::new().unwrap();
    let dst = tempfile::TempDir::new().unwrap();
    let work = tempfile::TempDir::new().unwrap();
    let s = src.path();
    git(s, &["init", "-q", "-b", "main"]);
    let c1 = commit(s, "a.txt", "one\n", "c1");
    let c2 = commit(s, "b.txt", &"two\n".repeat(500), "c2");
    git(s, &["tag", "-a", "v1.0", "-m", "v1.0"]);
    let tag = git(s, &["rev-parse", "refs/tags/v1.0"]);

    let scope = DocScope {
        contract_id: "CORE".into(),
        repo_id: [1; 32],
    };
    let mut rec = Recorded::default();
    let config = crate::create::config_props(&crate::create::CreateRepoOpts::public("rt"));
    rec.create("config", scope.scoped(config));
    push(
        &mut rec,
        &scope,
        s,
        store,
        &[&c2, &tag],
        &[],
        &[
            ("refs/heads/main", &c2, None),
            ("refs/tags/v1.0", &tag, None),
        ],
    )
    .await;

    let c3 = commit(s, "b.txt", &"two\n".repeat(499), "c3");
    git(s, &["branch", "feature/v1.x@b"]);
    push(
        &mut rec,
        &scope,
        s,
        store,
        &[&c3],
        &[&c2],
        &[
            ("refs/heads/main", &c3, Some(&c2)),
            ("refs/heads/feature/v1.x@b", &c3, None),
        ],
    )
    .await;

    // What was written is the RC1 form.
    for (t, d) in &rec.docs {
        match *t {
            "chunk" | "packManifest" => {
                assert!(matches!(
                    d.fields.get("packHash"),
                    Some(FieldValue::Identifier(_))
                ));
                assert!(!d.fields.contains_key("offsetIndexParts"));
            }
            _ => assert_eq!(
                d.fields.get("vis"),
                Some(&FieldValue::text("public")),
                "{t}"
            ),
        }
    }

    clone(&rec, dst.path(), store).await;
    git(dst.path(), &["fsck", "--strict", "--no-dangling"]);
    for r in [
        "refs/heads/main",
        "refs/tags/v1.0",
        "refs/heads/feature/v1.x@b",
    ] {
        assert_eq!(
            git(dst.path(), &["rev-parse", r]),
            git(s, &["rev-parse", r]),
            "{r}"
        );
    }
    let w = work.path().join("clone");
    git(
        work.path(),
        &[
            "clone",
            "-q",
            &dst.path().to_string_lossy(),
            &w.to_string_lossy(),
        ],
    );
    assert_eq!(git(&w, &["rev-parse", "HEAD"]), c3);
    assert_eq!(
        git(&w, &["log", "--format=%H"]),
        [c3.as_str(), &c2, &c1].join("\n")
    );
    assert_eq!(
        std::fs::read_to_string(w.join("b.txt")).unwrap(),
        "two\n".repeat(499)
    );
}

/// Packs stored as `chunk` documents clone back to the source.
#[tokio::test]
async fn a_push_round_trips_through_platform_chunks_offline() {
    round_trip(&Store::Platform).await;
}

/// The local S3 fixture's anonymous bucket (`infra/docker-compose.yml`, `make infra-up`).
const LOCAL_S3: &str = "http://127.0.0.1:9000";

/// Packs stored on the local S3 fixture clone back to the source; skipped when it is down.
#[tokio::test]
async fn a_push_round_trips_through_the_local_s3_store() {
    if std::net::TcpStream::connect("127.0.0.1:9000").is_err() {
        eprintln!("SKIP: the local S3 fixture ({LOCAL_S3}) is down; `make infra-up` starts it");
        return;
    }
    let backend = crate::backends::s3::S3Backend::new(crate::backends::s3::S3Config::public(
        LOCAL_S3,
        "forge-packs",
    ));
    round_trip(&Store::External(&backend)).await;
}
