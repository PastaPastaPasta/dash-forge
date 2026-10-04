//! The contract-group check made before a limited key is bound to the forge group.
//!
//! A key bound to a contract group can sign documents for every member of the group, so
//! binding one means trusting whoever can add members. On Platform that is only the group's
//! owner or one of its admins: memberships are declared in the member contract's own create
//! transition, which drive-abci accepts only from the group's owner or an admin, and the
//! group's owner and admins cannot change after registration. So `dg` pins the **trust root**,
//! not the member list (`docs/contracts/forge-v2.md` § Contract group trust):
//!
//! 1. The group's owner, read proof-verified, must be the Forge deployer the embedded
//!    deployment file records, and the group must have no admins. Consensus then guarantees
//!    that every member contract was created by that owner.
//! 2. forge-core, forge-collab and forge-community must be whole-contract members (checked before anything
//!    else is read).
//! 3. Cross-check: each member contract this binary does not know is read proof-verified, and
//!    an `$ownerId` other than the pinned owner is refused. A contract that cannot be read or
//!    decoded (a format newer than this binary) is accepted and named in the notice: rule 1
//!    already bounds it, and refusing would make every future contract format an outage.
//! 4. Members this binary does not know are accepted and listed in a notice, shown before
//!    the key is confirmed. `--strict-group` / `DASH_FORGE_STRICT_GROUP=1` refuses them.

use std::collections::BTreeSet;

use anyhow::{Context as _, Result};
use serde_json::{json, Value};

use forge_core::network::ForgeIds;
use forge_core::platform::identity::{GroupMembers, GroupOwnership};
use forge_core::platform::PlatformClient;
use forge_core::user_error::{codes, UserError};

use crate::context::Ctx;

/// The environment variable that turns strict group checking on (`1`, `true` or `yes`).
pub const STRICT_ENV: &str = "DASH_FORGE_STRICT_GROUP";

/// The most unknown member contracts whose owner `dg` cross-checks; any beyond are accepted on
/// the pinned owner alone and named in the notice.
const MAX_UNKNOWN_CONTRACTS: usize = 64;

/// Whether strict group checking is on: `--strict-group`, or [`STRICT_ENV`] set.
pub fn strict_requested(flag: bool) -> bool {
    flag || std::env::var(STRICT_ENV).is_ok_and(|v| is_truthy(&v))
}

fn is_truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
}

/// A passed group check: what the group holds beyond Forge's known contracts. Only
/// [`check_group`] makes one, and registering a limited key requires one, so a key is never
/// bound to an unchecked group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCheck {
    /// The group checked.
    group: String,
    /// Members beyond the known contracts: `contract`, `contract (document type t)`,
    /// `contract (token n)`, sorted.
    unknown: Vec<String>,
    /// Unknown member contracts whose owner was not cross-checked (unreadable, or past the
    /// cap), accepted because the group owner is pinned.
    unchecked: Vec<String>,
    /// Whether a member is a document type or token of a contract this binary knows.
    extra_parts: bool,
}

impl GroupCheck {
    /// Whether this check was made for `group` (a key is only bound to the group checked).
    pub fn covers(&self, group: &str) -> bool {
        self.group == group
    }

    /// The one-line notice (without a `note:` prefix), or `None` when the group holds only the
    /// known contracts.
    pub fn notice(&self) -> Option<String> {
        if self.unknown.is_empty() {
            return None;
        }
        // Members are counted one by one; revisions by contract (one revision can add several
        // members: `CONTRACT (document type t)`, `CONTRACT (token n)`).
        let many = if self.extra_parts {
            self.unknown.len() != 1
        } else {
            self.unknown
                .iter()
                .map(|u| u.split(' ').next().unwrap_or(u))
                .collect::<std::collections::HashSet<_>>()
                .len()
                != 1
        };
        let what = match (self.extra_parts, many) {
            (true, true) => "additional group members",
            (true, false) => "an additional group member",
            (false, true) => "newer Forge contract revisions",
            (false, false) => "a newer Forge contract revision",
        };
        let unchecked = if self.unchecked.is_empty() {
            String::new()
        } else {
            format!(
                " (could not read contract {}; accepted because the group owner is pinned)",
                self.unchecked.join(", ")
            )
        };
        Some(format!(
            "{what} present in the forge group, added by the Forge deployer: {}; update dg for \
             full support{unchecked}",
            self.unknown.join(", ")
        ))
    }

    /// The JSON fields a command adds to its output.
    pub fn json(&self) -> Value {
        json!({
            "unknownGroupMembers": self.unknown,
            "uncheckedGroupMembers": self.unchecked,
        })
    }

    /// Print the notice on stderr (human mode), indented under a key explanation.
    pub fn print_notice(&self, ctx: &Ctx, indent: &str) {
        if let (false, Some(line)) = (ctx.json, self.notice()) {
            eprintln!("{indent}note: {line}");
        }
    }
}

/// Merge `check`'s JSON fields into a command's JSON output object.
pub fn with_group_fields(mut out: Value, check: Option<&GroupCheck>) -> Value {
    if let (Some(obj), Some(Value::Object(fields))) =
        (out.as_object_mut(), check.map(GroupCheck::json))
    {
        obj.extend(fields);
    }
    out
}

/// The chain reads the check makes (proof-verified), behind a trait so tests can count them.
trait GroupReader {
    async fn info(&self, group: &str) -> Result<Option<GroupOwnership>>;
    async fn members(&self, group: &str) -> Result<GroupMembers>;
    async fn contract_owner(&self, contract: &str) -> Result<String>;
}

impl GroupReader for PlatformClient {
    async fn info(&self, group: &str) -> Result<Option<GroupOwnership>> {
        self.contract_group_info(group)
            .await
            .context("reading the forge contract group's owner on chain")
    }

    async fn members(&self, group: &str) -> Result<GroupMembers> {
        self.contract_group_members(group)
            .await
            .context("checking the forge contract group on chain")
    }

    async fn contract_owner(&self, contract: &str) -> Result<String> {
        Ok(self.fetch_contract(contract).await?.owner_id())
    }
}

/// Refuse to bind a key to `group` unless its trust root is the pinned one (module docs).
/// Returns what the group holds beyond Forge's known contracts; with `strict`, anything beyond
/// them is refused. Call it before explaining the key, and pass the result on to
/// [`super::register_limited_key`].
pub async fn check_group(
    ctx: &Ctx,
    client: &PlatformClient,
    group: &str,
    strict: bool,
) -> Result<GroupCheck> {
    let forge = ctx.target.require_v2()?;
    run_check(client, forge, group, strict, &ctx.network_label()).await
}

async fn run_check(
    reader: &impl GroupReader,
    forge: &ForgeIds,
    group: &str,
    strict: bool,
    network: &str,
) -> Result<GroupCheck> {
    let info = reader.info(group).await?;
    let pinned = check_ownership(forge, group, info.as_ref(), network)?;
    let members = reader.members(group).await?;
    check_pair(forge, group, &members, network)?;
    let unknown = describe_unknown(forge, &members);
    let extra_parts = members
        .document_types
        .iter()
        .map(|(c, _)| c)
        .chain(members.tokens.iter().map(|(c, _)| c))
        .any(|c| is_known(forge, c));
    if unknown.is_empty() {
        return Ok(GroupCheck {
            group: group.to_string(),
            unknown,
            unchecked: vec![],
            extra_parts,
        });
    }
    if strict {
        return Err(UserError::new(
            codes::INVALID_CONFIG,
            "refusing to bind a key to the forge contract group",
        )
        .cause(format!(
            "group {group} on {network} holds members this dg does not know ({}), and strict \
             group checking (--strict-group / {STRICT_ENV}=1) accepts only the known set",
            unknown.join(", ")
        ))
        .fix("update dg, or drop --strict-group / unset DASH_FORGE_STRICT_GROUP to accept members the Forge deployer added")
        .into());
    }
    let mut unchecked = Vec::new();
    for (i, contract) in unknown_contracts(forge, &members).into_iter().enumerate() {
        if i >= MAX_UNKNOWN_CONTRACTS {
            unchecked.push(contract);
            continue;
        }
        match reader.contract_owner(&contract).await {
            Ok(owner) if owner == pinned => {}
            Ok(owner) => {
                return Err(refusal(format!(
                    "group {group} on {network} holds contract {contract}, owned by {owner} \
                     and not by the Forge deployer {pinned}; a key bound to the group could \
                     sign for it"
                ))
                .into())
            }
            Err(e) => {
                tracing::debug!("group member contract {contract} not read: {e:#}");
                unchecked.push(contract);
            }
        }
    }
    Ok(GroupCheck {
        group: group.to_string(),
        unknown,
        unchecked,
        extra_parts,
    })
}

/// The trust root: the group exists, its owner is the pinned Forge deployer, and it has no
/// admins. Returns the pinned owner.
// Cold path: the UserError goes straight back to the caller as an anyhow error.
#[allow(clippy::result_large_err)]
fn check_ownership<'a>(
    forge: &'a ForgeIds,
    group: &str,
    on_chain: Option<&GroupOwnership>,
    network: &str,
) -> Result<&'a str, UserError> {
    if group != forge.group {
        return Err(refusal(format!(
            "the key would be bound to group {group}, but this dg's deployment for {network} \
             records group {}",
            forge.group
        )));
    }
    let Some(pinned) = forge.group_owner.as_deref() else {
        return Err(refusal(format!(
            "this dg's deployment file for {network} records no owner for group {group}, so \
             there is no trust root to check it against"
        )));
    };
    let Some(info) = on_chain else {
        return Err(refusal(format!(
            "contract group {group} does not exist on {network}"
        )));
    };
    if info.owner != pinned {
        return Err(refusal(format!(
            "group {group} on {network} is owned by {}, but this dg pins the Forge deployer \
             {pinned}; whoever owns the group decides what every key bound to it can sign",
            info.owner
        )));
    }
    if !info.admins.is_empty() {
        return Err(refusal(format!(
            "group {group} on {network} lets {} add members besides its owner; the Forge group \
             has no admins, and any of them could widen what a key bound to it can sign",
            info.admins.join(", ")
        )));
    }
    Ok(pinned)
}

/// forge-core, forge-collab and forge-community are whole-contract members (forge-community
/// is forge-collab on a deployment that predates the split, so the check is then the pair).
#[allow(clippy::result_large_err)]
fn check_pair(
    forge: &ForgeIds,
    group: &str,
    members: &GroupMembers,
    network: &str,
) -> Result<(), UserError> {
    let whole: BTreeSet<&str> = members.contracts.iter().map(String::as_str).collect();
    if forge.all().iter().all(|(_, c)| whole.contains(c)) {
        return Ok(());
    }
    Err(refusal(format!(
        "group {group} on {network} does not hold forge-core {}, forge-collab {} and \
         forge-community {} as whole contracts",
        forge.core, forge.collab, forge.community
    )))
}

/// Every member contract (whole, or through a document type or token) that is not one of
/// Forge's own per the embedded deployment, sorted.
fn unknown_contracts(forge: &ForgeIds, members: &GroupMembers) -> BTreeSet<String> {
    members
        .contracts
        .iter()
        .chain(members.document_types.iter().map(|(c, _)| c))
        .chain(members.tokens.iter().map(|(c, _)| c))
        .filter(|c| !is_known(forge, c))
        .cloned()
        .collect()
}

fn is_known(forge: &ForgeIds, contract: &str) -> bool {
    forge.contains(contract) || forge.superseded_in_group.iter().any(|s| s == contract)
}

/// The members this binary does not know, as `contract`, `contract (document type t)` or
/// `contract (token n)`, in a stable order. A document type or token member is listed even
/// when its contract is known: the known set holds whole contracts only.
fn describe_unknown(forge: &ForgeIds, members: &GroupMembers) -> Vec<String> {
    let mut out: Vec<String> = members
        .contracts
        .iter()
        .filter(|c| !is_known(forge, c))
        .cloned()
        .collect();
    out.sort();
    let mut parts: Vec<String> = members
        .document_types
        .iter()
        .map(|(c, t)| format!("{c} (document type {t})"))
        .chain(
            members
                .tokens
                .iter()
                .map(|(c, p)| format!("{c} (token {p})")),
        )
        .collect();
    parts.sort();
    out.extend(parts);
    out
}

fn refusal(cause: String) -> UserError {
    UserError::new(
        codes::INVALID_CONFIG,
        "refusing to bind a key to the forge contract group",
    )
    .cause(cause)
    .fix("do not bind a key to this group; update dg (its deployment file may be stale), or report it")
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use super::*;

    const DEPLOYER: &str = "E24SPCssqYzFQmjcQ1hNmiLXrzz1o9AqTv54tuWNkgHz";
    const STRANGER: &str = "H1DBHnGmX3tMrsnMjtjXr9fZzPRAyfnLXzqy78THTPxS";
    const NET: &str = "devnet-moutai";

    fn forge() -> ForgeIds {
        ForgeIds {
            core: "CORE".into(),
            collab: "COLLAB".into(),
            community: "COMMUNITY".into(),
            group: "GROUP".into(),
            superseded_in_group: vec!["OLDCOLLAB".into()],
            group_owner: Some(DEPLOYER.into()),
        }
    }

    /// A chain with a fixed group; `owners` maps a contract to its owner, and a contract
    /// missing from it cannot be read (an unknown format). Records every contract read.
    struct Chain {
        owner: String,
        admins: Vec<String>,
        members: GroupMembers,
        owners: BTreeMap<String, String>,
        reads: RefCell<Vec<String>>,
    }

    impl Chain {
        fn new(contracts: &[&str]) -> Self {
            Chain {
                owner: DEPLOYER.into(),
                admins: vec![],
                members: GroupMembers {
                    contracts: contracts.iter().map(|c| (*c).to_string()).collect(),
                    ..GroupMembers::default()
                },
                owners: BTreeMap::new(),
                reads: RefCell::new(vec![]),
            }
        }

        fn owned(mut self, contract: &str, owner: &str) -> Self {
            self.owners.insert(contract.into(), owner.into());
            self
        }

        fn reads(&self) -> Vec<String> {
            self.reads.borrow().clone()
        }
    }

    // The trait's reads are async; the in-memory chain answers at once.
    #[allow(clippy::unused_async_trait_impl)]
    impl GroupReader for Chain {
        async fn info(&self, _: &str) -> Result<Option<GroupOwnership>> {
            Ok(Some(GroupOwnership {
                owner: self.owner.clone(),
                admins: self.admins.clone(),
            }))
        }
        async fn members(&self, _: &str) -> Result<GroupMembers> {
            Ok(self.members.clone())
        }
        async fn contract_owner(&self, contract: &str) -> Result<String> {
            self.reads.borrow_mut().push(contract.into());
            self.owners
                .get(contract)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("unknown contract format"))
        }
    }

    async fn check(chain: &Chain, strict: bool) -> Result<GroupCheck> {
        run_check(chain, &forge(), "GROUP", strict, NET).await
    }

    fn cause(e: &anyhow::Error) -> String {
        e.downcast_ref::<UserError>()
            .and_then(|u| u.cause.clone())
            .unwrap_or_else(|| format!("{e:#}"))
    }

    #[tokio::test]
    async fn the_known_set_passes_without_a_notice_or_a_read() {
        let chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY", "OLDCOLLAB"]);
        let r = check(&chain, false).await.unwrap();
        assert_eq!(r.notice(), None);
        assert!(r.covers("GROUP") && !r.covers("OTHER"));
        assert!(check(&chain, true).await.unwrap().notice().is_none());
        assert!(chain.reads().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_member_owned_by_the_deployer_is_accepted_with_a_notice() {
        let chain =
            Chain::new(&["CORE", "COLLAB", "COMMUNITY", "NEWCOLLAB"]).owned("NEWCOLLAB", DEPLOYER);
        let notice = check(&chain, false)
            .await
            .unwrap()
            .notice()
            .expect("a notice");
        assert!(
            notice.contains("a newer Forge contract revision present"),
            "{notice}"
        );
        assert!(notice.contains("NEWCOLLAB"), "{notice}");
        assert!(notice.contains("update dg for full support"), "{notice}");
        assert!(!notice.contains('\n'), "one line: {notice}");
        assert!(!notice.contains("could not read"), "{notice}");
        assert_eq!(chain.reads(), vec!["NEWCOLLAB".to_string()]);
    }

    #[tokio::test]
    async fn an_unknown_member_with_another_owner_is_refused() {
        let chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY", "EVIL"]).owned("EVIL", STRANGER);
        let e = check(&chain, false).await.unwrap_err();
        assert!(cause(&e).contains("EVIL"), "{}", cause(&e));
        assert!(cause(&e).contains(STRANGER), "{}", cause(&e));
    }

    #[tokio::test]
    async fn an_unreadable_member_is_accepted_because_the_owner_is_pinned() {
        let chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY", "FUTURE"]);
        let r = check(&chain, false).await.unwrap();
        let notice = r.notice().unwrap();
        assert!(
            notice.contains(
                "could not read contract FUTURE; accepted because the group owner is pinned"
            ),
            "{notice}"
        );
        assert_eq!(r.json()["uncheckedGroupMembers"], json!(["FUTURE"]));
    }

    #[tokio::test]
    async fn strict_mode_refuses_unknown_members_without_reading_them() {
        let chain =
            Chain::new(&["CORE", "COLLAB", "COMMUNITY", "NEWCOLLAB"]).owned("NEWCOLLAB", DEPLOYER);
        let e = check(&chain, true).await.unwrap_err();
        assert!(cause(&e).contains("NEWCOLLAB"), "{}", cause(&e));
        assert!(cause(&e).contains(STRICT_ENV), "{}", cause(&e));
        assert!(
            chain.reads().is_empty(),
            "strict mode reads no member contract"
        );
    }

    #[tokio::test]
    async fn the_pair_is_checked_before_any_member_is_read() {
        let chain = Chain::new(&["CORE", "OLDCOLLAB", "NEW"]).owned("NEW", DEPLOYER);
        let e = check(&chain, false).await.unwrap_err();
        assert!(
            cause(&e).contains("does not hold forge-core"),
            "{}",
            cause(&e)
        );
        assert!(chain.reads().is_empty());
    }

    #[tokio::test]
    async fn a_group_without_forge_community_is_refused() {
        let chain = Chain::new(&["CORE", "COLLAB"]);
        let e = check(&chain, false).await.unwrap_err();
        assert!(
            cause(&e).contains("forge-community COMMUNITY"),
            "{}",
            cause(&e)
        );
        assert!(chain.reads().is_empty());
    }

    #[tokio::test]
    async fn owners_past_the_cap_are_accepted_unchecked() {
        let ids: Vec<String> = (0..MAX_UNKNOWN_CONTRACTS + 2)
            .map(|i| format!("N{i:03}"))
            .collect();
        let mut contracts = vec!["CORE", "COLLAB", "COMMUNITY"];
        contracts.extend(ids.iter().map(String::as_str));
        let mut chain = Chain::new(&contracts);
        for id in &ids {
            chain = chain.owned(id, DEPLOYER);
        }
        let r = check(&chain, false).await.unwrap();
        assert_eq!(chain.reads().len(), MAX_UNKNOWN_CONTRACTS);
        assert_eq!(r.unchecked, ids[MAX_UNKNOWN_CONTRACTS..].to_vec());
        assert_eq!(r.unknown.len(), MAX_UNKNOWN_CONTRACTS + 2);
    }

    #[tokio::test]
    async fn document_type_and_token_members_follow_the_owner_rule() {
        let mut chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY"]).owned("TRENDING", DEPLOYER);
        chain
            .members
            .document_types
            .push(("TRENDING".into(), "trend".into()));
        let notice = check(&chain, false).await.unwrap().notice().unwrap();
        assert!(notice.contains("newer Forge contract revision"), "{notice}");
        assert!(
            notice.contains("TRENDING (document type trend)"),
            "{notice}"
        );
        chain.owners.insert("TRENDING".into(), STRANGER.into());
        assert!(cause(&check(&chain, false).await.unwrap_err()).contains("TRENDING"));
    }

    #[tokio::test]
    async fn a_part_of_a_known_contract_is_an_additional_member() {
        let mut chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY"]);
        chain.members.tokens.push(("CORE".into(), 0));
        let r = check(&chain, false).await.unwrap();
        let notice = r.notice().unwrap();
        assert!(
            notice.starts_with("an additional group member")
                || notice.starts_with("additional group members"),
            "{notice}"
        );
        assert!(notice.contains("CORE (token 0)"), "{notice}");
        assert!(
            chain.reads().is_empty(),
            "a known contract needs no owner read"
        );
    }

    #[tokio::test]
    async fn a_changed_group_owner_or_any_admin_is_refused() {
        let mut chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY"]);
        chain.owner = STRANGER.into();
        let e = check(&chain, false).await.unwrap_err();
        assert!(
            cause(&e).contains(STRANGER) && cause(&e).contains(DEPLOYER),
            "{}",
            cause(&e)
        );
        let mut chain = Chain::new(&["CORE", "COLLAB", "COMMUNITY"]);
        chain.admins = vec![STRANGER.into()];
        let e = check(&chain, false).await.unwrap_err();
        assert!(cause(&e).contains(STRANGER), "{}", cause(&e));
    }

    #[test]
    fn a_missing_group_another_group_or_no_pinned_owner_is_refused() {
        let info = GroupOwnership {
            owner: DEPLOYER.into(),
            admins: vec![],
        };
        let c = |e: UserError| e.cause.unwrap_or_default();
        assert!(
            c(check_ownership(&forge(), "GROUP", None, NET).unwrap_err())
                .contains("does not exist")
        );
        assert!(
            c(check_ownership(&forge(), "OTHER", Some(&info), NET).unwrap_err()).contains("OTHER")
        );
        let unpinned = ForgeIds {
            group_owner: None,
            ..forge()
        };
        assert!(
            c(check_ownership(&unpinned, "GROUP", Some(&info), NET).unwrap_err())
                .contains("records no owner")
        );
        assert_eq!(
            check_ownership(&forge(), "GROUP", Some(&info), NET).unwrap(),
            DEPLOYER
        );
    }

    #[tokio::test]
    async fn json_output_lists_the_unknown_members() {
        let chain =
            Chain::new(&["CORE", "COLLAB", "COMMUNITY", "NEWCOLLAB"]).owned("NEWCOLLAB", DEPLOYER);
        let r = check(&chain, false).await.unwrap();
        let out = with_group_fields(json!({ "status": "added" }), Some(&r));
        assert_eq!(out["status"], "added");
        assert_eq!(out["unknownGroupMembers"], json!(["NEWCOLLAB"]));
        assert_eq!(out["uncheckedGroupMembers"], json!([]));
        let known = check(&Chain::new(&["CORE", "COLLAB", "COMMUNITY"]), false)
            .await
            .unwrap();
        let out = with_group_fields(json!({}), Some(&known));
        assert_eq!(out["unknownGroupMembers"], json!([]));
        assert_eq!(
            with_group_fields(json!({ "a": 1 }), None),
            json!({ "a": 1 })
        );
    }

    #[test]
    fn strict_env_values() {
        assert!(is_truthy("1"));
        assert!(is_truthy("TRUE"));
        assert!(is_truthy(" yes "));
        assert!(!is_truthy("0"));
        assert!(!is_truthy(""));
        assert!(strict_requested(true));
    }

    #[test]
    fn moutai_pins_its_deployer_as_the_group_owner() {
        let ctx = Ctx::scripted(true, true, false, None);
        let forge = ctx.target.require_v2().unwrap();
        assert_eq!(forge.group_owner.as_deref(), Some(DEPLOYER));
    }
}
