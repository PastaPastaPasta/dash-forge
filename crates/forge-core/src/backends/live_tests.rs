//! Container-backed integration tests for the storage backends.
//!
//! These run against the local docker fixtures in `infra/docker-compose.yml`:
//!   docker compose -f infra/docker-compose.yml up -d
//!   cargo test -p forge-core -- --nocapture backends::live_tests
//!   docker compose -f infra/docker-compose.yml down -v
//!
//! Each test first probes its endpoint and **skips with an `eprintln!`** when the
//! container is absent, so `cargo test` stays green on a machine without docker. Every
//! ranged read here flows through `http_get`, which hard-errors on any status other than
//! `206 Partial Content` for a `Range` request — so a passing ranged assertion *is* the
//! 206 confirmation.

use super::https::HttpsBackend;
use super::ipfs::{IpfsBackend, IpfsConfig};
use super::s3::{S3Backend, S3Config};
use super::{sha256, verify_and_get, BackendRegistry, ByteRange, PackBackend, PackMeta, Uri};
use crate::error::Error;

const STATIC_HTTP: &str = "http://127.0.0.1:8082";
const MINIO_ENDPOINT: &str = "http://127.0.0.1:9000";
const MINIO_BUCKET: &str = "forge-packs";
const IPFS_API: &str = "http://127.0.0.1:5001";
const IPFS_GATEWAY: &str = "http://127.0.0.1:8081";

/// A distinctive multi-KiB payload so range slices are unambiguous.
fn payload() -> Vec<u8> {
    (0..8192u32)
        .map(|i| u8::try_from(i % 251).unwrap())
        .collect()
}

/// Whether `url` answers within a short timeout (used to skip when docker is down).
async fn reachable(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    client.get(url).send().await.is_ok()
}

/// Skip-guard: returns `true` (skip) and prints when `url` is unreachable.
macro_rules! skip_unless {
    ($url:expr, $name:expr) => {
        if !reachable($url).await {
            eprintln!(
                "SKIP {}: {} unreachable (bring up infra/docker-compose.yml)",
                $name, $url
            );
            return;
        }
    };
}

#[tokio::test]
async fn https_whole_range_and_probe() {
    skip_unless!(STATIC_HTTP, "https_whole_range_and_probe");
    let backend = HttpsBackend::new();
    let uri = Uri(format!("{STATIC_HTTP}/README.txt"));

    // Whole read.
    let whole = backend.get(&uri, None).await.expect("whole GET");
    assert!(!whole.is_empty(), "README.txt should have content");

    // Ranged read → 206 (asserted inside http_get) → must equal the same slice.
    let end = whole.len().min(16) as u64;
    let range = ByteRange::new(0, end).unwrap();
    let slice = backend
        .get(&uri, Some(range))
        .await
        .expect("ranged GET (206)");
    assert_eq!(slice, &whole[..end as usize], "range bytes mismatch");

    // A mid-file range too.
    if whole.len() >= 40 {
        let r = ByteRange::new(10, 30).unwrap();
        let mid = backend
            .get(&uri, Some(r))
            .await
            .expect("mid ranged GET (206)");
        assert_eq!(mid, &whole[10..30]);
    }

    // Probe reports reachable + a size.
    let health = backend.probe(&uri).await.expect("probe");
    assert!(health.ok);
    assert_eq!(health.size, Some(whole.len() as u64));
}

#[tokio::test]
async fn s3_put_get_range_verify_probe() {
    skip_unless!(
        &format!("{MINIO_ENDPOINT}/{MINIO_BUCKET}/"),
        "s3_put_get_range_verify_probe"
    );
    let backend = S3Backend::new(S3Config::public(MINIO_ENDPOINT, MINIO_BUCKET));
    let data = payload();
    let meta = PackMeta::for_bytes(&data);

    // put → both an s3:// uri and the public http url.
    let uris = backend.put(&data, &meta).await.expect("S3 PUT");
    assert_eq!(uris.len(), 2);
    assert_eq!(uris[0].scheme(), Some("s3"));
    let s3_uri = &uris[0];
    let http_uri = &uris[1];

    // Whole read via the s3:// uri, hash-verified through the OUTSIDE-the-adapter helper.
    let whole = verify_and_get(&backend, s3_uri, &meta.pack_hash)
        .await
        .expect("verify_and_get via s3://");
    assert_eq!(whole, data);

    // Whole read via the public http url too.
    let via_http = backend
        .get(http_uri, None)
        .await
        .expect("GET via public url");
    assert_eq!(via_http, data);

    // Ranged read (206) equals the slice.
    let r = ByteRange::new(1000, 2000).unwrap();
    let slice = backend
        .get(s3_uri, Some(r))
        .await
        .expect("ranged GET (206)");
    assert_eq!(slice, &data[1000..2000]);

    // Tamper detection: wrong expected hash → Integrity.
    let wrong = "0".repeat(64);
    assert!(matches!(
        verify_and_get(&backend, s3_uri, &wrong).await,
        Err(Error::Integrity)
    ));

    // Probe reports reachable + size.
    let health = backend.probe(s3_uri).await.expect("probe");
    assert!(health.ok);
    assert_eq!(health.size, Some(data.len() as u64));
}

#[tokio::test]
async fn ipfs_put_get_range_verify_probe() {
    skip_unless!(
        &format!("{IPFS_GATEWAY}/ipfs/bafkqaaa"),
        "ipfs_put_get_range_verify_probe"
    );
    let backend = IpfsBackend::new(IpfsConfig::local(IPFS_API, IPFS_GATEWAY));
    let data = payload();
    let meta = PackMeta::for_bytes(&data);

    // put via kubo /api/v0/add → ipfs://<CID>. The CID round-trips: the gateway read
    // below only returns bytes if the content is retrievable under that CID.
    let uris = backend.put(&data, &meta).await.expect("IPFS add");
    assert_eq!(uris.len(), 1);
    assert_eq!(uris[0].scheme(), Some("ipfs"));
    let cid_uri = &uris[0];

    // Whole read, hash-verified (manifest sha256, independent of the CID's own hash).
    let whole = verify_and_get(&backend, cid_uri, &meta.pack_hash)
        .await
        .expect("verify_and_get via ipfs://");
    assert_eq!(whole, data);

    // Ranged read (206) equals the slice.
    let r = ByteRange::new(4096, 5000).unwrap();
    let slice = backend
        .get(cid_uri, Some(r))
        .await
        .expect("ranged GET (206)");
    assert_eq!(slice, &data[4096..5000]);

    // Probe reports reachable + size.
    let health = backend.probe(cid_uri).await.expect("probe");
    assert!(health.ok);
    assert_eq!(health.size, Some(data.len() as u64));
}

/// End-to-end failover across *live* backends: a bad (missing) URI first, a good one
/// second → the registry falls through and returns hash-verified bytes from the good one.
#[tokio::test]
async fn registry_live_failover_bad_then_good() {
    skip_unless!(
        &format!("{IPFS_GATEWAY}/ipfs/bafkqaaa"),
        "registry_live_failover_bad_then_good"
    );
    skip_unless!(
        &format!("{MINIO_ENDPOINT}/{MINIO_BUCKET}/"),
        "registry_live_failover_bad_then_good"
    );

    let data = payload();
    let meta = PackMeta::for_bytes(&data);

    // Store the real bytes on IPFS.
    let ipfs = IpfsBackend::new(IpfsConfig::local(IPFS_API, IPFS_GATEWAY));
    let good_uri = ipfs.put(&data, &meta).await.expect("IPFS add").remove(0);

    // Registry: s3 backend (preferred, but we point at a MISSING key) + ipfs (good).
    let s3 = S3Backend::new(S3Config::public(MINIO_ENDPOINT, MINIO_BUCKET));
    let mut reg = BackendRegistry::new();
    reg.register(Box::new(s3)).register(Box::new(ipfs));

    // Default preference tries s3 first → 404 → fails over to the ipfs uri.
    let bad_uri = Uri(format!(
        "s3://{MINIO_BUCKET}/packs/does-not-exist-{}.pack",
        meta.pack_hash
    ));
    let uris = vec![bad_uri, good_uri];

    let got = reg
        .get_verified(&uris, &meta.pack_hash)
        .await
        .expect("failover to the good uri");
    assert_eq!(got, data);
    assert_eq!(hex::encode(sha256(&got)), meta.pack_hash);
}

/// LIVE platform-backend write (`chunk` docs via the WriteEngine). Ignored by default: it
/// needs a testnet connection, a `chunk`-capable contract and a funded, WRITE-token'd
/// identity. Run explicitly once the fixtures are in place:
///
/// ```text
/// FORGE_TESTNET_IDENTITY=<base58 id> \
/// FORGE_TESTNET_KEYSTORE=<path/to/bridge-identity.json> \
/// FORGE_TESTNET_CONTRACT=9hqcGGpuvN86bkbVUQNL99V1Qd5D9pgKjQd5xEXDv8EP \
///   cargo test -p forge-core -- --ignored platform_backend_live_put
/// ```
///
/// The chunk encode/decode + reassembly path this exercises is already covered offline by
/// the `platform` submodule's unit tests; this proves the on-chain pipelined write.
#[tokio::test]
#[ignore = "needs testnet + funded identity + chunk contract; see doc comment"]
async fn platform_backend_live_put() {
    use crate::backends::PlatformBackend;
    use crate::keystore::BridgeIdentity;
    use crate::platform::{Network, PlatformClient, WriteEngine};

    let identity_id = std::env::var("FORGE_TESTNET_IDENTITY").expect("FORGE_TESTNET_IDENTITY");
    let keystore_path = std::env::var("FORGE_TESTNET_KEYSTORE").expect("FORGE_TESTNET_KEYSTORE");
    let contract_id = std::env::var("FORGE_TESTNET_CONTRACT").expect("FORGE_TESTNET_CONTRACT");

    let client = PlatformClient::connect(Network::Testnet).await.unwrap();
    let contract = client.fetch_contract(&contract_id).await.unwrap();
    let identity = client.fetch_identity(&identity_id).await.unwrap();
    let bridge = BridgeIdentity::load_from_file(&keystore_path).unwrap();
    let key = bridge.doc_op_key().unwrap();
    let engine = WriteEngine::new(&client, &identity, key).unwrap();

    let backend = PlatformBackend::new(&engine, &contract);
    // A SMALL payload → a few chunk docs.
    let data: Vec<u8> = (0..20_000u32)
        .map(|i| u8::try_from(i % 251).unwrap())
        .collect();
    let meta = PackMeta::for_bytes(&data);
    let uris = backend.put(&data, &meta).await.expect("platform chunk put");
    assert_eq!(uris.len(), 1);
    assert_eq!(uris[0].scheme(), Some("platform"));
}
