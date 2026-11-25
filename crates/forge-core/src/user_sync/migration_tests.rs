//! Migration and interop (`identity-synced-state.md` §8): a master-format `storage.toml` with
//! `keychain:` and `env:` references syncs without being touched, a second device sees the same
//! profiles, older and newer clients keep each other's entries, and maintainers get (and lose)
//! a repository's storage. Runs against [`MemoryStore`], which enforces Platform's owner rule.

use std::collections::BTreeSet;

use serde_json::{json, Value};

use super::*;
use crate::app_connect::SecretBytes;
use crate::storage::StoragePolicy;

const MASTER_STORAGE_TOML: &str = r#"# Dash Forge storage profiles (docs/guides/bring-your-own-storage.md).
# Secrets are references (env:VAR / keychain:service/account), never values.

[read]
ipfs_gateways = ["https://gw.example"]

[profiles.r2-main]
kind = "s3"
endpoint = "https://acct.r2.cloudflarestorage.com"
region = "auto"
bucket = "forge"
public_url = "https://pub-1.r2.dev"
access_key_id = "env:USER_SYNC_MIG_KEY_ID"
secret_access_key = "keychain:dash-forge/r2-main"

[profiles.kubo]
kind = "ipfs-kubo"
api = "https://kubo.example:5001"
gateway = "https://kubo.example"
api_auth = "keychain:dash-forge/kubo-auth"

[profiles.pins]
kind = "ipfs-pinning-service"
api = "https://kubo.example:5001"
pinning_endpoint = "https://pins.example/psa"
pinning_token = "env:USER_SYNC_MIG_PIN"
pin_timeout_secs = 90

[profiles.chain]
kind = "platform"
"#;

fn h(label: &str) -> [u8; 32] {
    use sha2::Digest as _;
    sha2::Sha256::digest(label.as_bytes()).into()
}

fn id(label: &str) -> String {
    crate::app_connect::encode_base58(&h(label))
}

fn key(identity: &str, key_id: u32, label: &str) -> SyncKey {
    SyncKey::new("testnet", identity, key_id, SecretBytes::new(h(label))).unwrap()
}

fn set_secrets() {
    std::env::set_var("USER_SYNC_MIG_KEY_ID", "AKIDMIGRATION");
    std::env::set_var("USER_SYNC_MIG_PIN", "pin-token-not-real");
    crate::keychain::set_test_entry("dash-forge", "r2-main", "r2-secret-not-real");
    crate::keychain::set_test_entry("dash-forge", "kubo-auth", "Basic a3Vibw==");
}

/// The share [`ShareRule`] makes when `profiles` and the default `policy` are synced.
fn share_of(profiles: &StorageProfiles, policy: &StoragePolicy) -> ShareContent {
    let mut doc = SlotDoc::new(SLOT_STORAGE);
    for (n, p) in &profiles.profiles {
        doc.set(&storage::profile_key(n), 1, resolved(p));
    }
    doc.set(storage::DEFAULT_KEY, 1, storage::policy_to_synced(policy));
    match ShareRule::of(Some(&doc), &id("any repo")) {
        ShareRule::Content(c) => c,
        other => panic!("expected a share, got {other:?}"),
    }
}

fn default_policy() -> StoragePolicy {
    StoragePolicy::from_git_values(Some("r2-main,chain"), Some("1"), None).unwrap()
}

fn resolved(p: &Profile) -> Value {
    storage::profile_to_synced(p).unwrap()
}

#[tokio::test]
async fn a_master_storage_toml_syncs_untouched_and_a_second_device_sees_it() {
    set_secrets();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("storage.toml");
    std::fs::write(&path, MASTER_STORAGE_TOML).unwrap();
    let before = std::fs::read(&path).unwrap();
    let local = StorageProfiles::load_from(&path).unwrap();

    let alice = id("alice");
    let store = MemoryStore::new();
    store.as_signer(&alice);
    let e = key(&alice, 7, "alice E");

    let done = first_sync(&store, &e, &local, Some(&default_policy()), "aaaaaa")
        .await
        .unwrap();
    assert!(done.recorded, "{:?}", done.skipped);
    assert!(done.skipped.is_empty());
    let names: BTreeSet<_> = done.uploaded.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(names, ["chain", "kubo", "pins", "r2-main"].into());

    // This device: the merged view holds every profile, and storage.toml is byte-identical.
    let doc = UserSync::new(&e, &store)
        .read_slot(SLOT_STORAGE)
        .await
        .unwrap()
        .unwrap()
        .doc;
    let here = effective(&local, Some(&doc));
    for name in local.profiles.keys() {
        assert_eq!(here.origin[name], Origin::Both, "{name}");
        assert_eq!(here.profiles.profiles[name], local.profiles[name], "{name}");
    }
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(synced_policy(&doc, None), Some(default_policy()));

    // A second device (fresh config, same identity and E): the same effective profiles, with
    // the secrets that were references on the first device.
    let fresh = StorageProfiles::default();
    let there_doc = UserSync::new(&e, &store)
        .read_slot(SLOT_STORAGE)
        .await
        .unwrap()
        .unwrap()
        .doc;
    let there = effective(&fresh, Some(&there_doc));
    assert_eq!(
        there.profiles.profiles.keys().collect::<Vec<_>>(),
        local.profiles.keys().collect::<Vec<_>>()
    );
    for (name, p) in &local.profiles {
        assert_eq!(there.origin[name], Origin::Synced, "{name}");
        assert_eq!(
            resolved(&there.profiles.profiles[name]),
            resolved(p),
            "{name}"
        );
    }
    let Profile::S3(r2) = &there.profiles.profiles["r2-main"] else {
        panic!("r2-main is s3")
    };
    assert_eq!(
        r2.to_config()
            .unwrap()
            .credentials
            .unwrap()
            .secret_access_key
            .expose(),
        "r2-secret-not-real"
    );
    let resolved_policy = synced_policy(&there_doc, None)
        .unwrap()
        .resolve(&there.profiles)
        .unwrap();
    assert_eq!(resolved_policy.target_names(), ["r2-main", "platform"]);
    // The in-memory set can never be saved over a storage.toml.
    assert!(there.profiles.to_toml().is_err());

    // A second first sync uploads nothing more.
    let writes = store.writes();
    let again = first_sync(&store, &e, &local, Some(&default_policy()), "aaaaaa")
        .await
        .unwrap();
    assert!(again.uploaded.is_empty());
    assert_eq!(store.writes(), writes);
}

#[tokio::test]
async fn a_clashing_name_keeps_both_and_a_secret_that_does_not_resolve_stays_local() {
    set_secrets();
    let bob = id("bob");
    let store = MemoryStore::new();
    store.as_signer(&bob);
    let e = key(&bob, 3, "bob E");
    let first = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    first_sync(&store, &e, &first, None, "aaaaaa")
        .await
        .unwrap();

    let other = StorageProfiles::parse(
        r#"
[profiles.r2-main]
kind = "s3"
endpoint = "https://other.r2.cloudflarestorage.com"
bucket = "elsewhere"

[profiles.unset]
kind = "ipfs-pinning-service"
api = "https://kubo.example:5001"
pinning_endpoint = "https://pins.example/psa"
pinning_token = "env:USER_SYNC_MIG_NEVER_SET"
"#,
    )
    .unwrap();
    let done = first_sync(&store, &e, &other, None, "bbbbbb")
        .await
        .unwrap();
    assert_eq!(
        done.uploaded,
        vec![("r2-main".to_string(), "r2-main-bbbbbb".to_string())]
    );
    assert_eq!(done.skipped.len(), 1);
    assert!(!done.recorded);
    assert!(!done.skipped[0].1.contains("not-real"));

    let doc = UserSync::new(&e, &store)
        .read_slot(SLOT_STORAGE)
        .await
        .unwrap()
        .unwrap()
        .doc;
    let synced = synced_profiles(&doc);
    assert!(synced.contains_key("r2-main") && synced.contains_key("r2-main-bbbbbb"));
    // On the second device its own r2-main wins on the name.
    let view = effective(&other, Some(&doc));
    assert_eq!(view.origin["r2-main"], Origin::LocalOverSynced);
    assert_eq!(view.profiles.profiles["r2-main"], other.profiles["r2-main"]);
}

#[tokio::test]
async fn older_and_newer_clients_keep_each_others_entries() {
    set_secrets();
    let carol = id("carol");
    let store = MemoryStore::new();
    store.as_signer(&carol);
    let e = key(&carol, 5, "carol E");
    let sync = UserSync::new(&e, &store);

    // A newer client wrote a kind and a key this build does not know.
    let mut newer = SlotDoc::new(SLOT_STORAGE);
    newer.set(
        "profile:arweave",
        10,
        json!({"settings": {"kind": "arweave", "provider": "ar"}, "secrets": {"jwk": "x"}}),
    );
    newer.set("future:thing", 10, json!({"q": 1}));
    newer.extra.insert("newTopLevel".into(), json!(true));
    sync.merge_into(SLOT_STORAGE, &newer).await.unwrap();

    // This client adds a profile and removes nothing of theirs.
    let local = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    first_sync(&store, &e, &local, None, "cccccc")
        .await
        .unwrap();
    let doc = sync.read_slot(SLOT_STORAGE).await.unwrap().unwrap().doc;
    assert_eq!(doc.get("future:thing"), Some(&json!({"q": 1})));
    assert_eq!(doc.extra.get("newTopLevel"), Some(&json!(true)));
    assert!(doc.get("profile:arweave").is_some());
    let view = effective(&StorageProfiles::default(), Some(&doc));
    assert!(view.unusable.contains_key("arweave"));
    assert!(!view.profiles.profiles.contains_key("arweave"));

    // A removal on another device is a tombstone: it hides the synced copy, never local data.
    let mut removal = SlotDoc::new(SLOT_STORAGE);
    removal.remove("profile:kubo", now_ms() + 1);
    sync.merge_into(SLOT_STORAGE, &removal).await.unwrap();
    let doc = sync.read_slot(SLOT_STORAGE).await.unwrap().unwrap().doc;
    assert!(!effective(&StorageProfiles::default(), Some(&doc))
        .profiles
        .profiles
        .contains_key("kubo"));
    assert_eq!(effective(&local, Some(&doc)).origin["kubo"], Origin::Local);
    // ...and a later first sync does not bring it back.
    let plan = upload_plan(&local, None, Some(&doc), "cccccc", now_ms());
    assert!(!plan.uploaded.iter().any(|(n, _)| n == "kubo"));
}

#[tokio::test]
async fn only_the_identity_writes_its_state_and_another_key_cannot_read_it() {
    set_secrets();
    let dave = id("dave");
    let store = MemoryStore::new();
    let e = key(&dave, 2, "dave E");
    store.as_signer(&id("mallory"));
    let local = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    assert!(first_sync(&store, &e, &local, None, "dddddd")
        .await
        .is_err());
    store.as_signer(&dave);
    first_sync(&store, &e, &local, None, "dddddd")
        .await
        .unwrap();
    let wrong = key(&dave, 2, "not dave's E");
    assert!(UserSync::new(&wrong, &store)
        .read_slot(SLOT_STORAGE)
        .await
        .is_err());
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one owner/maintainer story, start to removal
async fn a_maintainer_gets_the_owners_storage_for_that_repo_until_removed() {
    set_secrets();
    let owner = id("owner");
    let member = id("member");
    let repo = id("repo");
    let other_repo = id("other repo");
    let e_owner = key(&owner, 7, "owner E");
    let e_member = key(&member, 9, "member E");
    let store = MemoryStore::new();
    store.add_key(&owner, 7, e_owner.public_key().to_vec());

    let profiles = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    let policy = StoragePolicy::from_git_values(Some("r2-main,chain"), Some("1"), None).unwrap();
    let content = share_of(&profiles, &policy);
    assert_eq!(content.profiles.keys().collect::<Vec<_>>(), ["r2-main"]);
    let maintainers: BTreeSet<String> = [member.clone()].into();

    // The member has no forge-user key yet: listed as waiting, nothing granted.
    store.as_signer(&owner);
    let owner_sync = UserSync::new(&e_owner, &store);
    let r = owner_sync
        .reconcile_repo(&repo, Wanted::Content(&content), &maintainers)
        .await
        .unwrap();
    assert!(r.share_written && r.shared);
    assert_eq!(r.waiting, vec![member.clone()]);

    // After a wallet sign-in the member has one; the next reconcile grants it, once.
    store.add_key(&member, 9, e_member.public_key().to_vec());
    let r = owner_sync
        .reconcile_repo(&repo, Wanted::Content(&content), &maintainers)
        .await
        .unwrap();
    assert!(!r.share_written);
    assert_eq!(r.granted, vec![member.clone()]);
    let writes = store.writes();
    let r = owner_sync
        .reconcile_repo(&repo, Wanted::Content(&content), &maintainers)
        .await
        .unwrap();
    assert!(r.granted.is_empty() && !r.share_written);
    assert_eq!(store.writes(), writes, "nothing changed, nothing written");

    // The member, for that repo only, with the owner's profiles under their own names.
    store.as_signer(&member);
    let member_sync = UserSync::new(&e_member, &store);
    let mine = StorageProfiles::default();
    let view = repo::push_storage(&member_sync, &repo, &owner, true, &mine)
        .await
        .unwrap();
    assert_eq!(view.shared_by.as_deref(), Some(owner.as_str()));
    let shared_name = format!("share.{}.r2-main", &owner[..8]);
    assert_eq!(view.effective.origin[&shared_name], Origin::Shared);
    let p = view.policy.clone().unwrap();
    assert_eq!(p.targets, [shared_name.clone(), "platform".to_string()]);
    let resolved_push = p.resolve(&view.effective.profiles).unwrap();
    assert_eq!(resolved_push.external.len(), 1);
    assert_eq!(
        resolved(&resolved_push.external[0].1),
        resolved(&profiles.profiles["r2-main"])
    );
    // Not a maintainer (any more), or another repository: nothing shared.
    assert!(
        repo::push_storage(&member_sync, &repo, &owner, false, &mine)
            .await
            .unwrap()
            .shared_by
            .is_none()
    );
    assert!(member_sync
        .granted_share(&other_repo, &owner)
        .await
        .unwrap()
        .is_none());

    // A share and grant someone other than the owner writes for the repository are ignored.
    let mallory = id("mallory");
    let e_mallory = key(&mallory, 4, "mallory E");
    store.add_key(&mallory, 4, e_mallory.public_key().to_vec());
    store.as_signer(&mallory);
    let lure = ShareContent {
        profiles: [(
            "trap".to_string(),
            json!({"settings": {"kind": "platform", "provider": "platform"}, "secrets": {}}),
        )]
        .into(),
        policy: json!({"targets": ["trap"], "replicas": 1, "platformFallback": false}),
        extra: serde_json::Map::new(),
    };
    for r in [&repo, &other_repo] {
        UserSync::new(&e_mallory, &store)
            .reconcile_repo(r, Wanted::Content(&lure), &maintainers)
            .await
            .unwrap();
    }
    store.as_signer(&member);
    assert!(member_sync
        .granted_share(&other_repo, &owner)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        member_sync.granted_share(&repo, &owner).await.unwrap(),
        Some(content.clone())
    );

    // Removal: a new epoch, the share re-encrypted, the member's grant deleted.
    store.as_signer(&owner);
    let r = owner_sync
        .reconcile_repo(&repo, Wanted::Keep, &BTreeSet::new())
        .await
        .unwrap();
    assert_eq!(r.revoked, vec![member.clone()]);
    assert_eq!(r.epoch, 1);
    assert!(r.share_written);
    assert!(store
        .all_grants()
        .iter()
        .all(|g| !(g.owner_id == owner && g.member_id == member)));
    store.as_signer(&member);
    assert!(member_sync
        .granted_share(&repo, &owner)
        .await
        .unwrap()
        .is_none());
    // The owner still reads its share at the new epoch, with the same content.
    let share = store.share(&owner, &repo).await.unwrap().unwrap();
    assert_eq!(share.epoch, 1);
    let back = owner_sync
        .open_share(
            &share,
            &owner_sync.rsk(&crate::platform::decode_identifier(&repo).unwrap(), 1),
        )
        .unwrap();
    assert_eq!(back, content);
}

struct Shared {
    owner: String,
    member: String,
    repo: String,
    e_owner: SyncKey,
    e_member: SyncKey,
    store: MemoryStore,
    content: ShareContent,
}

fn repo_with_one_maintainer() -> Shared {
    set_secrets();
    let owner = id("owner2");
    let member = id("member2");
    let e_owner = key(&owner, 7, "owner2 E");
    let e_member = key(&member, 9, "member2 E");
    let store = MemoryStore::new();
    store.add_key(&owner, 7, e_owner.public_key().to_vec());
    store.add_key(&member, 9, e_member.public_key().to_vec());
    let profiles = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    let policy = StoragePolicy::from_git_values(Some("r2-main"), None, None).unwrap();
    let content = share_of(&profiles, &policy);
    Shared {
        owner,
        member,
        repo: id("repo2"),
        e_owner,
        e_member,
        store,
        content,
    }
}

#[tokio::test]
async fn a_disabled_member_key_loses_its_grant_and_the_epoch_moves() {
    let r = repo_with_one_maintainer();
    let maintainers: BTreeSet<String> = [r.member.clone()].into();
    r.store.as_signer(&r.owner);
    let owner = UserSync::new(&r.e_owner, &r.store);
    let first = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    assert_eq!((first.epoch, first.granted.len()), (0, 1));
    r.store.disable_key(&r.member, 9);
    let after = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    assert_eq!(after.revoked, vec![r.member.clone()]);
    assert_eq!(after.waiting, vec![r.member.clone()]);
    assert_eq!(after.epoch, 1);
    assert!(r.store.all_grants().is_empty());
    // A new key gets a grant at the new epoch; the old key's epoch is never reused.
    let e_new = key(&r.member, 10, "member2 new E");
    r.store.add_key(&r.member, 10, e_new.public_key().to_vec());
    let again = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    assert_eq!((again.epoch, again.granted.len()), (1, 1));
    r.store.as_signer(&r.member);
    assert!(UserSync::new(&e_new, &r.store)
        .granted_share(&r.repo, &r.owner)
        .await
        .unwrap()
        .is_some());
    assert!(UserSync::new(&r.e_member, &r.store)
        .granted_share(&r.repo, &r.owner)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn stopping_and_resuming_sharing_never_reuses_an_epoch() {
    let r = repo_with_one_maintainer();
    let maintainers: BTreeSet<String> = [r.member.clone()].into();
    r.store.as_signer(&r.owner);
    let owner = UserSync::new(&r.e_owner, &r.store);
    owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    let stopped = owner
        .reconcile_repo(&r.repo, Wanted::Nothing, &maintainers)
        .await
        .unwrap();
    assert_eq!(stopped.revoked, vec![r.member.clone()]);
    assert!(!stopped.shared && stopped.share_written);
    assert_eq!(stopped.epoch, 1);
    // A maintainer key that opened epoch 0 learns nothing from epoch 1's empty share.
    let share = r.store.share(&r.owner, &r.repo).await.unwrap().unwrap();
    let repo = crate::platform::decode_identifier(&r.repo).unwrap();
    let empty = owner.open_share(&share, &owner.rsk(&repo, 1)).unwrap();
    assert!(empty.profiles.is_empty());
    assert!(owner.open_share(&share, &owner.rsk(&repo, 0)).is_err());
    let resumed = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    assert_eq!((resumed.epoch, resumed.granted.len()), (1, 1));
    // Without a share there is nothing to stop.
    let fresh = id("repo never shared");
    let none = owner
        .reconcile_repo(&fresh, Wanted::Nothing, &maintainers)
        .await
        .unwrap();
    assert!(!none.share_written && none.granted.is_empty());
}

#[tokio::test]
async fn unknown_share_fields_survive_and_an_unchanged_share_is_not_rewritten() {
    let r = repo_with_one_maintainer();
    let maintainers: BTreeSet<String> = [r.member.clone()].into();
    r.store.as_signer(&r.owner);
    let owner = UserSync::new(&r.e_owner, &r.store);
    let mut newer = r.content.clone();
    newer.extra.insert("future".into(), json!({"a": 1}));
    owner
        .reconcile_repo(&r.repo, Wanted::Content(&newer), &maintainers)
        .await
        .unwrap();
    let writes = r.store.writes();
    let same = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    assert!(!same.share_written);
    assert_eq!(r.store.writes(), writes);
    // A removal re-encrypts it, keeping the field.
    let gone = owner
        .reconcile_repo(&r.repo, Wanted::Keep, &BTreeSet::new())
        .await
        .unwrap();
    assert!(gone.share_written);
    let share = r.store.share(&r.owner, &r.repo).await.unwrap().unwrap();
    let repo = crate::platform::decode_identifier(&r.repo).unwrap();
    let back = owner
        .open_share(&share, &owner.rsk(&repo, gone.epoch))
        .unwrap();
    assert_eq!(back.extra.get("future"), Some(&json!({"a": 1})));
}

#[test]
fn a_shared_profile_never_records_a_private_address_and_bad_names_are_dropped() {
    let content = ShareContent {
        profiles: [
            (
                "lan".to_string(),
                json!({"settings": {"kind": "ipfs-kubo", "provider": "kubo", "api": "http://192.168.1.5:5001", "gateway": "", "publicGateway": "", "pinningEndpoint": ""}, "secrets": {}, "dg": {"allowPrivateUri": true}}),
            ),
            (
                format!("{}é", "a".repeat(48)),
                json!({"settings": {"kind": "platform", "provider": "platform"}, "secrets": {}}),
            ),
        ]
        .into(),
        policy: json!({"targets": ["lan"], "replicas": 1, "platformFallback": false}),
        extra: serde_json::Map::new(),
    };
    let owner = id("owner3");
    let (profiles, policy) = content.as_profiles(&owner);
    assert_eq!(profiles.len(), 1);
    let (name, lan) = profiles.iter().next().unwrap();
    assert_eq!(name, &format!("share.{}.lan", &owner[..8]));
    assert!(!lan.allow_private_uri());
    assert_eq!(policy.unwrap().targets, vec![name.clone()]);
}

#[tokio::test]
async fn a_synced_policy_naming_a_profile_that_is_gone_is_skipped() {
    set_secrets();
    let erin = id("erin");
    let store = MemoryStore::new();
    store.as_signer(&erin);
    let e = key(&erin, 1, "erin E");
    let sync = UserSync::new(&e, &store);
    let mut doc = SlotDoc::new(SLOT_STORAGE);
    doc.set(
        storage::DEFAULT_KEY,
        1,
        json!({"targets": ["removed-elsewhere"], "replicas": 1, "platformFallback": false}),
    );
    sync.merge_into(SLOT_STORAGE, &doc).await.unwrap();
    let view = repo::push_storage(
        &sync,
        &id("repo4"),
        &erin,
        false,
        &StorageProfiles::default(),
    )
    .await
    .unwrap();
    assert!(
        view.policy.is_none(),
        "falls back to git config, as before sync"
    );
    // A Platform-kind name in an owner's policy becomes `platform` in the share.
    let local = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    let p = StoragePolicy::from_git_values(Some("r2-main,chain"), None, None).unwrap();
    let share = share_of(&local, &p);
    assert_eq!(share.policy["targets"], json!(["r2-main", "platform"]));
    let (profiles, policy) = share.as_profiles(&erin);
    let set = StorageProfiles {
        profiles,
        ..StorageProfiles::default()
    };
    assert!(policy.unwrap().resolve(&set).is_ok());
}

#[tokio::test]
async fn an_interrupted_removal_finishes_at_a_newer_epoch_and_never_reuses_one() {
    let r = repo_with_one_maintainer();
    let maintainers: BTreeSet<String> = [r.member.clone()].into();
    r.store.as_signer(&r.owner);
    let owner = UserSync::new(&r.e_owner, &r.store);
    owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    r.store.fail_next_share_write();
    assert!(owner
        .reconcile_repo(&r.repo, Wanted::Keep, &BTreeSet::new())
        .await
        .is_err());
    // Nothing was revoked yet, so the next run still sees it and moves the epoch.
    assert_eq!(r.store.all_grants().len(), 1);
    assert_eq!(
        r.store
            .share(&r.owner, &r.repo)
            .await
            .unwrap()
            .unwrap()
            .epoch,
        0
    );
    let done = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &BTreeSet::new())
        .await
        .unwrap();
    assert_eq!(
        (done.epoch, done.revoked.clone()),
        (1, vec![r.member.clone()])
    );
    assert!(r.store.all_grants().is_empty());
    r.store.as_signer(&r.member);
    assert!(UserSync::new(&r.e_member, &r.store)
        .granted_share(&r.repo, &r.owner)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_deleted_share_never_restarts_at_an_earlier_epoch() {
    let r = repo_with_one_maintainer();
    let maintainers: BTreeSet<String> = [r.member.clone()].into();
    r.store.as_signer(&r.owner);
    let owner = UserSync::new(&r.e_owner, &r.store);
    owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    // An older web build deleted the share; the member's grant at epoch 0 survives.
    r.store.delete_share(&r.owner, &r.repo);
    let again = owner
        .reconcile_repo(&r.repo, Wanted::Content(&r.content), &maintainers)
        .await
        .unwrap();
    assert_eq!(again.epoch, 1, "past every surviving grant's epoch");
    assert_eq!(
        r.store
            .share(&r.owner, &r.repo)
            .await
            .unwrap()
            .unwrap()
            .epoch,
        1
    );
    assert!(r.store.all_grants().iter().all(|g| g.epoch == 1));
    // Stopping writes an empty share one epoch on, once.
    let stopped = owner
        .reconcile_repo(&r.repo, Wanted::Nothing, &maintainers)
        .await
        .unwrap();
    assert_eq!(stopped.epoch, 2);
    let writes = r.store.writes();
    let still = owner
        .reconcile_repo(&r.repo, Wanted::Nothing, &maintainers)
        .await
        .unwrap();
    assert_eq!((still.epoch, r.store.writes()), (2, writes));
}

#[test]
fn the_share_rule_follows_the_synced_policy_only() {
    set_secrets();
    let local = StorageProfiles::parse(MASTER_STORAGE_TOML).unwrap();
    let repo = id("rule repo");
    let mut doc = SlotDoc::new(SLOT_STORAGE);
    // No synced policy: keep the share as it is.
    assert!(matches!(ShareRule::of(Some(&doc), &repo), ShareRule::Keep));
    assert!(matches!(ShareRule::of(None, &repo), ShareRule::Keep));
    // A web profile on a custom endpoint stays `r2`, and its synced value is shared as is.
    let web = json!({"settings": {"kind": "s3", "provider": "r2", "endpoint": "https://files.example.org", "region": "auto", "bucket": "b", "pathStyle": true, "publicUrl": "https://pub.example.org", "prefix": ""}, "secrets": {"accessKeyId": "AK", "secretAccessKey": "SK", "sessionToken": ""}});
    doc.set("profile:web-r2", 1, web.clone());
    doc.set(
        storage::DEFAULT_KEY,
        1,
        json!({"targets": ["web-r2"], "replicas": 1, "platformFallback": false}),
    );
    let ShareRule::Content(c) = ShareRule::of(Some(&doc), &repo) else {
        panic!("default policy shares")
    };
    assert_eq!(c.profiles["web-r2"]["settings"]["provider"], "r2");
    // The repository's own entry wins; naming a profile that is not synced keeps the share.
    doc.set(
        &storage::repo_key(&repo),
        2,
        json!({"targets": ["r2-main"], "replicas": 1, "platformFallback": false}),
    );
    assert!(matches!(ShareRule::of(Some(&doc), &repo), ShareRule::Keep));
    // Platform only (built in, or a platform-kind profile): sharing stops.
    doc.set("profile:chain", 1, resolved(&local.profiles["chain"]));
    doc.set(
        &storage::repo_key(&repo),
        3,
        json!({"targets": ["chain", "platform"], "replicas": 1, "platformFallback": false}),
    );
    assert!(matches!(
        ShareRule::of(Some(&doc), &repo),
        ShareRule::Nothing
    ));
    // Compared by meaning: the `dg` extras, empty secrets and key order do not count.
    let mut b = c.clone();
    let p = b.profiles.get_mut("web-r2").unwrap();
    p["dg"] = json!({"allowPrivateUri": false});
    p["secrets"].as_object_mut().unwrap().remove("sessionToken");
    b.policy = json!({"platformFallback": false, "replicas": 1, "targets": ["web-r2"]});
    assert!(c.same_as(&b));
    b.profiles.get_mut("web-r2").unwrap()["secrets"]["secretAccessKey"] = json!("rotated");
    assert!(!c.same_as(&b));
}

#[tokio::test]
async fn a_slot_written_by_a_newer_version_is_read_but_not_rewritten() {
    let frank = id("frank");
    let store = MemoryStore::new();
    store.as_signer(&frank);
    let e = key(&frank, 1, "frank E");
    let sync = UserSync::new(&e, &store);
    let mut newer = SlotDoc::new(SLOT_STORAGE);
    newer.version = 2;
    newer.set(
        "profile:x",
        1,
        json!({"settings": {"kind": "platform", "provider": "platform"}, "secrets": {}}),
    );
    sync.write_slot(SLOT_STORAGE, &newer, None).await.unwrap();
    let read = sync.read_slot(SLOT_STORAGE).await.unwrap().unwrap();
    assert_eq!(read.doc.version, 2);
    let mut change = SlotDoc::new(SLOT_STORAGE);
    change.set("profile:y", 2, json!(null));
    assert!(sync.merge_into(SLOT_STORAGE, &change).await.is_err());
    assert_eq!(store.writes(), 1);
}
