//! Pack mirrors (forge-v2.md §2 `packMirror`, §9.1; TypeScript
//! `forge-web/lib/rules/pack-mirror.ts`): another copy of a pack that anyone may record, read
//! only when every copy the repository's own manifests record has failed.
//!
//! A mirror is an availability hint, never an authority: its bytes must hash to the pack's
//! SHA-256 before a reader uses them, so a bad mirror can only fail to serve. Two rules decide
//! what is recorded and what is read, and both clients apply them identically
//! (vectors `pack_mirror_uris__*` and `pack_mirror_order__*`):
//!
//! - [`check_mirror_uris`]: the addresses a writer may record. The contract's own pattern (an
//!   `https://` URL without credentials or whitespace, or `ipfs://<alphanumeric CID>`), 1 to 4
//!   addresses of at most 300 characters, plus two writer conventions: an `ipfs://` address is
//!   the bare CID (no path), and one record holds one kind (all https, kind 1, or all IPFS,
//!   kind 2), since a writer holds one record per pack.
//! - [`mirror_read_order`]: the addresses a reader tries, in order. None for a private
//!   repository, and none for a pack the repository's manifests do not list. Members' records
//!   first (maintainers, then other members), then everyone else's; each group by
//!   `($createdAt, $id)`. An unknown `kind` is skipped, and so is an address that does not fit
//!   its record's kind. At most [`MIRROR_URIS_TRIED`] distinct addresses.

use serde::{Deserialize, Serialize};

use super::v2::{Role, Visibility};

/// `kind` 1: an `https://` URL (a web host, or an S3 bucket's public URL).
pub const KIND_HTTPS: u64 = 1;
/// `kind` 2: `ipfs://<cid>`, read through the reader's IPFS gateways.
pub const KIND_IPFS: u64 = 2;
/// Addresses one record holds (the contract's `uris.maxItems`).
pub const MAX_URIS: usize = 4;
/// Characters one address holds (the contract's `maxLength`, in characters).
pub const MAX_URI_CHARS: usize = 300;
/// Distinct mirror addresses one read of a pack tries, over every record: a stranger cannot make
/// a reader spend more than this on a dead pack, however many records they pay for.
pub const MIRROR_URIS_TRIED: usize = 8;

/// Why a writer's addresses cannot be recorded ([`check_mirror_uris`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UriProblem {
    /// No address.
    None,
    /// More than [`MAX_URIS`].
    TooMany,
    /// Empty, or longer than [`MAX_URI_CHARS`] characters.
    Length,
    /// Not an `https://` URL (without a user name, password or whitespace) or `ipfs://<cid>`.
    Address,
    /// An `ipfs://` address with something after the CID.
    IpfsPath,
    /// The same address twice.
    Duplicate,
    /// https and IPFS addresses in one record.
    MixedKinds,
}

/// The verdict of [`check_mirror_uris`]: the kind the addresses make, or the first problem
/// (with the index of the address that has it, where one does).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum UriCheck {
    /// Recordable, as this `kind`.
    Ok {
        /// [`KIND_HTTPS`] or [`KIND_IPFS`].
        kind: u64,
    },
    /// Not recordable.
    Refused {
        /// What is wrong.
        problem: UriProblem,
        /// The address it is wrong with, when it is one address.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
}

fn is_posix_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r')
}

/// `rest` is empty, or starts with `/`, `?` or `#` and holds no whitespace: the pattern's
/// `([/?#][^[:space:]]*)?$` tail.
fn is_tail(rest: &str) -> bool {
    rest.is_empty() || (rest.starts_with(['/', '?', '#']) && !rest.contains(is_posix_space))
}

/// The kind `uri` is an address of, as the contract's pattern and length admit it and the
/// writer convention reads it: [`KIND_IPFS`] for a bare `ipfs://<cid>`, [`KIND_HTTPS`] for an
/// `https://` URL; `None` for anything else (an `ipfs://` address with a path included).
#[must_use]
pub fn uri_kind(uri: &str) -> Option<u64> {
    let chars = uri.chars().count();
    if chars == 0 || chars > MAX_URI_CHARS {
        return None;
    }
    if let Some(cid) = uri.strip_prefix("ipfs://") {
        return (!cid.is_empty() && cid.chars().all(|c| c.is_ascii_alphanumeric()))
            .then_some(KIND_IPFS);
    }
    let rest = uri.strip_prefix("https://")?;
    let (host, tail) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    (!host.is_empty() && !host.contains(|c| c == '@' || is_posix_space(c)) && is_tail(tail))
        .then_some(KIND_HTTPS)
}

/// Whether the contract's pattern (`^(https://[^[:space:]/?#@]+|ipfs://[A-Za-z0-9]+)
/// ([/?#][^[:space:]]*)?$`) admits `uri`.
fn admitted(uri: &str) -> bool {
    match uri.strip_prefix("ipfs://") {
        Some(rest) => {
            let end = rest
                .find(|c: char| !c.is_ascii_alphanumeric())
                .unwrap_or(rest.len());
            end > 0 && is_tail(&rest[end..])
        }
        None => uri_kind(uri) == Some(KIND_HTTPS),
    }
}

/// Whether a writer may record `uris` as one mirror, and as which kind (module docs).
#[must_use]
pub fn check_mirror_uris(uris: &[String]) -> UriCheck {
    let refused = |problem, index| UriCheck::Refused { problem, index };
    if uris.is_empty() {
        return refused(UriProblem::None, None);
    }
    if uris.len() > MAX_URIS {
        return refused(UriProblem::TooMany, None);
    }
    let mut kinds = Vec::with_capacity(uris.len());
    for (i, uri) in uris.iter().enumerate() {
        let chars = uri.chars().count();
        if chars == 0 || chars > MAX_URI_CHARS {
            return refused(UriProblem::Length, Some(i));
        }
        if !admitted(uri) {
            return refused(UriProblem::Address, Some(i));
        }
        let Some(kind) = uri_kind(uri) else {
            return refused(UriProblem::IpfsPath, Some(i));
        };
        if uris[..i].contains(uri) {
            return refused(UriProblem::Duplicate, Some(i));
        }
        kinds.push(kind);
    }
    if kinds.iter().any(|k| *k != kinds[0]) {
        return refused(UriProblem::MixedKinds, None);
    }
    UriCheck::Ok { kind: kinds[0] }
}

/// One `packMirror` document, flattened for [`mirror_read_order`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRecord {
    /// Document `$id`.
    pub id: String,
    /// The writer's current role in the repository ([`super::v2::RoleOracle::current_role`]);
    /// `None` for anyone who is not a member now.
    #[serde(default)]
    pub owner_role: Option<Role>,
    /// Consensus `$createdAt` (ms).
    pub created_at: u64,
    /// The pack it mirrors (hex).
    pub pack_hash: String,
    /// `kind`.
    pub kind: u64,
    /// `uris`.
    pub uris: Vec<String>,
}

/// What [`mirror_read_order`] reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorReadInput {
    /// The pack being read (hex).
    pub pack_hash: String,
    /// The pack hashes the repository's own manifests list (hex).
    pub listed: Vec<String>,
    /// The repository's visibility.
    pub visibility: Visibility,
    /// Its `packMirror` documents (any packs; the others are ignored).
    pub mirrors: Vec<MirrorRecord>,
}

/// Maintainers first, then other members, then everyone else (the pack-copy rank).
fn rank(role: Option<Role>) -> u8 {
    match role {
        Some(Role::Maintainer) => 0,
        Some(_) => 1,
        None => 2,
    }
}

/// The mirror addresses a reader tries for `input.pack_hash`, in order (module docs).
#[must_use]
pub fn mirror_read_order(input: &MirrorReadInput) -> Vec<String> {
    let want = input.pack_hash.to_ascii_lowercase();
    if input.visibility == Visibility::Private
        || !input.listed.iter().any(|h| h.eq_ignore_ascii_case(&want))
    {
        return Vec::new();
    }
    let mut records: Vec<&MirrorRecord> = input
        .mirrors
        .iter()
        .filter(|m| m.pack_hash.eq_ignore_ascii_case(&want))
        .filter(|m| m.kind == KIND_HTTPS || m.kind == KIND_IPFS)
        .collect();
    records.sort_by(|a, b| {
        rank(a.owner_role)
            .cmp(&rank(b.owner_role))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut out: Vec<String> = Vec::new();
    for m in records {
        for uri in &m.uris {
            if uri_kind(uri) == Some(m.kind) && !out.contains(uri) {
                out.push(uri.clone());
                if out.len() == MIRROR_URIS_TRIED {
                    return out;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_string()).collect()
    }

    #[test]
    fn addresses_follow_the_contract_pattern_and_the_writer_conventions() {
        let ok = |v: &[&str]| check_mirror_uris(&s(v));
        assert_eq!(
            ok(&["https://m.example.com/p.pack"]),
            UriCheck::Ok { kind: 1 }
        );
        assert_eq!(
            ok(&["https://m.example.com:8443"]),
            UriCheck::Ok { kind: 1 }
        );
        assert_eq!(
            ok(&["ipfs://bafyabc", "ipfs://Qm1"]),
            UriCheck::Ok { kind: 2 }
        );
        let no = |v: &[&str], problem, index| {
            assert_eq!(ok(v), UriCheck::Refused { problem, index }, "{v:?}");
        };
        no(&[], UriProblem::None, None);
        no(&["https://a.b"; 5], UriProblem::TooMany, None);
        no(&[""], UriProblem::Length, Some(0));
        let long = format!("https://m.example.com/{}", "p".repeat(279));
        assert_eq!(long.chars().count(), 301);
        no(&["https://a.b", &long], UriProblem::Length, Some(1));
        no(&["http://a.b/p"], UriProblem::Address, Some(0));
        no(&["https://user:pw@a.b/p"], UriProblem::Address, Some(0));
        no(&["https://a.b/p q"], UriProblem::Address, Some(0));
        no(&["https:///p"], UriProblem::Address, Some(0));
        no(&["ipfs://"], UriProblem::Address, Some(0));
        no(&["ipfs://bafy-x"], UriProblem::Address, Some(0));
        no(&["ipfs://bafy/x"], UriProblem::IpfsPath, Some(0));
        no(
            &["https://a.b", "https://a.b"],
            UriProblem::Duplicate,
            Some(1),
        );
        no(
            &["https://a.b", "ipfs://bafy"],
            UriProblem::MixedKinds,
            None,
        );
        // 300 characters is the limit, counted as characters, not bytes.
        let at = format!("https://m.example.com/{}", "é".repeat(278));
        assert_eq!(ok(&[&at]), UriCheck::Ok { kind: 1 });
    }

    fn rec(id: &str, role: Option<Role>, at: u64, kind: u64, uris: &[&str]) -> MirrorRecord {
        MirrorRecord {
            id: id.into(),
            owner_role: role,
            created_at: at,
            pack_hash: "AB".into(),
            kind,
            uris: s(uris),
        }
    }

    fn order(visibility: Visibility, listed: &[&str], mirrors: Vec<MirrorRecord>) -> Vec<String> {
        mirror_read_order(&MirrorReadInput {
            pack_hash: "ab".into(),
            listed: s(listed),
            visibility,
            mirrors,
        })
    }

    #[test]
    fn members_first_strangers_last_capped() {
        let got = order(
            Visibility::Public,
            &["ab"],
            vec![
                rec("s", None, 1, 1, &["https://stranger/p"]),
                rec(
                    "w",
                    Some(Role::Writer),
                    5,
                    2,
                    &["ipfs://cidw", "https://wrong-kind/p"],
                ),
                rec(
                    "m",
                    Some(Role::Maintainer),
                    9,
                    1,
                    &["https://maint/p", "ipfs://wrong"],
                ),
                rec("x", Some(Role::Writer), 5, 9, &["https://unknown-kind/p"]),
            ],
        );
        assert_eq!(
            got,
            s(&["https://maint/p", "ipfs://cidw", "https://stranger/p"])
        );
        let many: Vec<MirrorRecord> = (0..5)
            .map(|n| {
                let uris: Vec<String> = (0..2).map(|k| format!("https://h{n}{k}/p")).collect();
                let uris: Vec<&str> = uris.iter().map(String::as_str).collect();
                rec(&format!("r{n}"), None, n, 1, &uris)
            })
            .collect();
        assert_eq!(
            order(Visibility::Public, &["AB"], many).len(),
            MIRROR_URIS_TRIED
        );
    }

    #[test]
    fn private_repos_and_unlisted_packs_read_no_mirror() {
        let one = || vec![rec("m", Some(Role::Maintainer), 1, 1, &["https://maint/p"])];
        assert!(order(Visibility::Private, &["ab"], one()).is_empty());
        assert!(order(Visibility::Public, &["cd"], one()).is_empty());
        assert_eq!(order(Visibility::Public, &["ab"], one()).len(), 1);
    }
}
