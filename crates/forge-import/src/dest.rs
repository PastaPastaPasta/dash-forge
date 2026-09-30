//! The destination: a forge-v2 repository the signer mirrors into. Resolve (or create) the
//! repository, check the signer can write what the run needs, and read the signing key's
//! limits for the summary.

use std::path::Path;

use anyhow::{bail, Context, Result};

use forge_core::create::{create_repo, default_journal_dir, CreateRepoOpts};
use forge_core::keystore::BridgeIdentity;
use forge_core::members::MemberReader;
use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::resolve::{find_named, repo_slug, resolve_id};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::scope::RepoRef;

use forge_core::collab::v2::Collab;
use forge_core::repo::credits_to_dash;

use crate::budget::{Budget, CapExceeded};
use crate::gitsync::ProofRepo;
use crate::model::SrcCollab;
use crate::sink::{Ledger, Sink};
use crate::summary::{KeyInfo, RepoInfo, Status, Summary};

/// Estimated cost of creating a repository (`repo` + owner `maintainer` + `config`),
/// credits. Measured on moutai at about 0.0013 DASH; rounded up.
pub const REPO_CREATE_CREDITS: u64 = 200_000_000;

/// The signer.
pub struct Signer {
    /// Key material.
    pub bridge: BridgeIdentity,
    /// The identity on chain.
    pub identity: LoadedIdentity,
}

impl Signer {
    /// Load `source` (an identity file or an inline `dfk1:` key) and fetch the identity.
    pub async fn load(client: &PlatformClient, source: &Path) -> Result<Self> {
        let bridge = BridgeIdentity::load_from_file(source).with_context(|| {
            format!(
                "loading the signing identity from {}",
                forge_core::keystore::describe_key_source(source)
            )
        })?;
        let identity = client
            .fetch_identity(&bridge.identity_id)
            .await
            .with_context(|| format!("fetching identity {}", bridge.identity_id))?;
        Ok(Self { bridge, identity })
    }

    /// [`Self::load`] when a key source was given; `None` only for a dry run without one.
    pub async fn load_opt(
        client: &PlatformClient,
        source: Option<&Path>,
        dry_run: bool,
    ) -> Result<Option<Self>> {
        match source {
            Some(k) => Ok(Some(Self::load(client, k).await?)),
            None if dry_run => Ok(None),
            None => bail!("no signing identity: pass --identity <file> or set DASH_FORGE_KEY"),
        }
    }

    /// The identity id.
    pub fn id(&self) -> String {
        self.identity.id()
    }

    /// The signing key's limits (budget, what is left of it, expiry).
    pub async fn key_info(&self, client: &PlatformClient) -> KeyInfo {
        let Ok(key) = self.bridge.doc_op_key() else {
            return KeyInfo::default();
        };
        let limits = self.identity.key_limits(key.id);
        let budget = limits.and_then(|l| l.total_budget);
        let remaining = match budget {
            Some(_) => client
                .key_remaining_budget(&self.id(), key.id)
                .await
                .ok()
                .flatten(),
            None => None,
        };
        KeyInfo {
            id: Some(key.id),
            budget_credits: budget,
            remaining_credits: remaining,
            expires_at: limits.and_then(|l| l.expires_at),
        }
    }
}

/// Where a run writes: an existing repository, or one it will create.
#[derive(Debug, Clone)]
pub struct DestRepo {
    /// Owner identity.
    pub owner: String,
    /// Slug.
    pub name: String,
    /// The repository, when it exists.
    pub existing: Option<RepoRef>,
}

impl DestRepo {
    /// `dash://owner/name`.
    pub fn url(&self) -> String {
        format!("dash://{}/{}", self.owner, self.name)
    }

    /// The summary's view.
    pub fn info(&self, created: bool) -> RepoInfo {
        RepoInfo {
            owner: self.owner.clone(),
            name: self.name.clone(),
            id: self
                .existing
                .as_ref()
                .map(|r| r.id().to_string())
                .unwrap_or_default(),
            url: self.url(),
            created,
        }
    }
}

/// Resolve `spec` (`owner/name`, `dash://owner/name`, a repo id, or a bare name meaning the
/// signer's) on the destination network.
pub async fn resolve(
    client: &PlatformClient,
    signer: Option<&str>,
    spec: &str,
) -> Result<DestRepo> {
    let spec = spec
        .trim()
        .trim_start_matches("dash://")
        .trim_end_matches('/');
    let forge = client
        .target()
        .v2
        .clone()
        .ok_or_else(|| forge_core::Error::V2NotDeployed {
            network: client.target().network.key(),
        })?;
    let looks_like_id = !spec.contains('/')
        && (40..=44).contains(&spec.len())
        && spec.chars().any(|c| c.is_ascii_uppercase());
    if looks_like_id {
        let repo = resolve_id(client, spec)
            .await
            .with_context(|| format!("resolving repo {spec}"))?;
        return Ok(DestRepo {
            owner: repo.owner_id().to_string(),
            name: repo.name().to_string(),
            existing: Some(repo),
        });
    }
    let (owner, name) = match spec.split_once('/') {
        Some((o, n)) => (o.to_string(), n.to_string()),
        None => (
            signer
                .ok_or_else(|| {
                    anyhow::anyhow!("a bare repository name needs a signing identity (its owner)")
                })?
                .to_string(),
            spec.to_string(),
        ),
    };
    let name = repo_slug(&name)?;
    let owner_bytes = forge_core::platform::decode_identifier(&owner)
        .with_context(|| format!("owner {owner:?} is not an identity id"))?;
    let existing = find_named(client, &forge, owner_bytes, &name).await?;
    Ok(DestRepo {
        owner,
        name,
        existing,
    })
}

/// Create `dest` (the signer must be its owner). Resumable: an interrupted create finishes
/// without paying twice. Returns whether this call created anything.
pub async fn create(
    client: &PlatformClient,
    signer: &Signer,
    dest: &mut DestRepo,
    description: &str,
    default_branch: &str,
) -> Result<bool> {
    if dest.owner != signer.id() {
        bail!(
            "{} does not exist, and only its owner ({}) can create it; create it as the owner \
             first, or mirror into a repository of your own",
            dest.url(),
            dest.owner
        );
    }
    let opts = CreateRepoOpts {
        name: dest.name.clone(),
        display_name: String::new(),
        description: crate::model::clip(description, 500, 2000),
        default_branch: if default_branch.is_empty() {
            "main".into()
        } else {
            default_branch.to_string()
        },
        // Platform by default; a storage policy on the pushing side decides where packs go.
        backend_mode: 0,
        backend_uris: Vec::new(),
        visibility: Visibility::Public,
        fork_of: None,
    };
    let res = create_repo(
        client,
        &signer.identity,
        &signer.bridge,
        &opts,
        &default_journal_dir()?,
    )
    .await
    .with_context(|| format!("creating {}", dest.url()))?;
    let created = !res.already_existed();
    dest.existing = Some(res.repo);
    Ok(created)
}

/// The signer's role in `repo`, refusing a signer that is not a member (nothing could be
/// written; say who can fix it). Every imported issue, PR, comment and review carries the
/// importer's membership proof (`asMember`, RC1 `import_provenance`), so a mirror must be a
/// proved member, and membership needs the mirror identity's own consent first.
pub async fn require_member(client: &PlatformClient, repo: &RepoRef, signer: &str) -> Result<Role> {
    let reader = MemberReader::new(client);
    let role = reader
        .roles_of(repo, signer)
        .await?
        .iter()
        .map(|m| m.role)
        .min();
    if let Some(role) = role {
        return Ok(role);
    }
    let consented = reader.consented(repo, signer).await.unwrap_or(false);
    let repo = repo.display();
    Err(anyhow::anyhow!(
        "{signer} is not a member of {repo}: the mirror identity writes pushes, issue state and \
         imported items (which carry its membership proof), so it must be a maintainer (or a \
         writer, without releases). {}",
        member_hint(&repo, signer, consented)
    ))
}

/// How to make `signer` a member of `repo`: the mirror identity accepts first (its consent,
/// `dg collab accept`), then the owner adds it.
fn member_hint(repo: &str, signer: &str, consented: bool) -> String {
    let add = format!("the owner runs `dg collab add {repo} {signer} --role maintainer`");
    if consented {
        format!("It has accepted; {add}")
    } else {
        format!("Run `dg collab accept {repo}` as {signer}, then {add}")
    }
}

/// What a write-phase run leaves behind for its summary, whatever path it exits by: the
/// ledger (spend, counts, warnings) and the signer (balance, key limits).
#[derive(Default)]
pub struct Outcome<'a> {
    /// The write phase's ledger, once it started.
    pub ledger: Option<Ledger<'a>>,
    /// The signer and its client, once loaded.
    pub signer: Option<(&'a PlatformClient, &'a Signer)>,
}

/// Close a run: record what was written and spent on EVERY exit (a capped or failed run
/// still spent), then turn an `Err` into the summary's status (`cap_exceeded` for the
/// spend cap, else `error`) and its redacted message; a run that skipped items is
/// `partial`.
pub async fn finish(mut summary: Summary, outcome: Outcome<'_>, result: Result<()>) -> Summary {
    if let Some(mut ledger) = outcome.ledger {
        ledger.reconcile().await;
        // Only a write phase has a ledger; a dry run's counts are already in `summary`.
        summary.counts = ledger.counts;
        summary.spent_credits = ledger.budget.spent();
        summary.warnings.extend(ledger.warnings);
    }
    if let Some((client, signer)) = outcome.signer {
        summary.balance_credits = client.get_balance(&signer.id()).await.ok();
        summary.key = signer.key_info(client).await;
    }
    summary.warnings = summary
        .warnings
        .iter()
        .map(|w| forge_core::user_error::redact(w))
        .collect();
    match result {
        Err(e) => {
            summary.status = if e.downcast_ref::<CapExceeded>().is_some() {
                Status::CapExceeded
            } else {
                Status::Error
            };
            summary.error = Some(forge_core::user_error::redact(&format!("{e:#}")));
        }
        Ok(())
            if summary.status == Status::Ok
                && (summary.counts.skipped > 0
                    || summary.counts.git_skipped > 0
                    || summary.incomplete) =>
        {
            summary.status = Status::Partial;
        }
        Ok(()) => {}
    }
    summary
}

/// The cost confirmation: `yes` skips it; without a terminal it refuses; a "no" is an
/// error ("cancelled").
pub fn confirm(yes: bool, credits: u64) -> Result<()> {
    use std::io::IsTerminal as _;
    if yes || credits == 0 {
        return Ok(());
    }
    if !std::io::stdin().is_terminal() {
        bail!("refusing to spend without confirmation on a non-interactive stdin; pass --yes");
    }
    eprint!("Proceed (~{:.6} DASH)? [y/N] ", credits_to_dash(credits));
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    if matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        bail!("cancelled")
    }
}

/// Diff `src` against `existing` without writing: the ledger holds what would be written,
/// its estimate and warnings.
pub async fn dry_collab<'a>(
    client: &'a PlatformClient,
    existing: Option<RepoRef>,
    signer: Option<&'a Signer>,
    src: &SrcCollab,
    mirror: Option<ProofRepo>,
) -> Result<Ledger<'a>> {
    // A private destination is read with the signer's keys (its documents are sealed).
    let collab = match signer {
        Some(s) => Collab::new(client, &s.identity, &s.bridge),
        None => Collab::reader(client),
    };
    let mut dry = Sink::new(
        collab,
        existing,
        Ledger::new(client, signer.map(Signer::id), true, Budget::new(None)),
    )
    .with_mirror(mirror);
    dry.sync(src).await?;
    Ok(dry.ledger)
}

/// What of `src` is written to a destination the mirror identity holds `role` in, and the
/// warnings that says so. A writer cannot publish releases, and a private destination cannot
/// hold them (their notes and assets are not encrypted), so they are left out rather than
/// failing the run. A private destination also leaves out the label definitions (their names,
/// colours and descriptions are plaintext) unless `include_label_definitions`; the labels put
/// on issues and PRs are event values, sealed like the rest.
#[must_use]
pub fn collab_plan(
    src: &SrcCollab,
    role: Role,
    private: bool,
    include_label_definitions: bool,
) -> (SrcCollab, Vec<String>) {
    let mut plan = src.clone();
    let mut warnings = Vec::new();
    if src.releases.as_ref().is_some_and(|r| !r.is_empty()) {
        if private {
            plan.releases = None;
            warnings.push(
                "releases were not mirrored: the destination is private, and forge-import does \
                 not seal releases yet (a maintainer publishes them with `dg release create`)"
                    .into(),
            );
        } else if role == Role::Writer {
            plan.releases = None;
            warnings.push(
                "releases were not mirrored: the mirror identity is a writer, and only \
                 maintainers publish releases (`dg collab add … --role maintainer`)"
                    .into(),
            );
        }
    }
    if private {
        let definitions = if src.labels.as_ref().is_some_and(|l| !l.is_empty()) {
            if include_label_definitions {
                "label definitions were mirrored as asked (--include-label-definitions)"
            } else {
                plan.labels = None;
                "label definitions were not mirrored: pass --include-label-definitions to \
                 publish them"
            }
        } else {
            "no label definitions to mirror"
        };
        warnings.push(format!(
            "the destination is private: issue, PR, comment and review text, their source URLs \
             and authors, and the labels and milestones set on them are encrypted; assignees, \
             label definitions (names, colours, descriptions) and numbers stay readable \
             (docs/security/private-repos.md §7). {definitions}"
        ));
    }
    (plan, warnings)
}

/// What the collaboration write reads: the source data, and the git data merged PRs are
/// proved against ([`Sink::with_mirror`]).
pub struct CollabSource<'s> {
    /// The collaboration data read from the source.
    pub src: &'s SrcCollab,
    /// The run's git mirror, or the base branches fetched for the proof (`None`: no merged
    /// PR to prove, or nothing could be fetched).
    pub mirror: Option<ProofRepo>,
}

/// Write the collaboration documents missing from `repo` with the run's ledger (taken from
/// `outcome` and put back, so the summary sees it however this ends); what is written is
/// [`collab_plan`]'s.
pub async fn write_collab<'a>(
    client: &'a PlatformClient,
    signer: &'a Signer,
    role: Role,
    repo: RepoRef,
    source: CollabSource<'_>,
    include_label_definitions: bool,
    outcome: &mut Outcome<'a>,
) -> Result<()> {
    let CollabSource { src, mirror } = source;
    let mut ledger = outcome.ledger.take().expect("the write phase has a ledger");
    let private = repo.visibility == Visibility::Private;
    let (plan, warnings) = collab_plan(src, role, private, include_label_definitions);
    for w in warnings {
        ledger.warn(w);
    }
    let mut sink = Sink::new(
        Collab::new(client, &signer.identity, &signer.bridge),
        Some(repo),
        ledger,
    )
    .with_mirror(mirror);
    let result = sink.sync(&plan).await;
    outcome.ledger = Some(sink.ledger);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src_with(labels: bool, releases: bool) -> SrcCollab {
        SrcCollab {
            labels: labels.then(|| {
                vec![crate::model::SrcLabel {
                    name: "security".into(),
                    color: "#ff0000".into(),
                    description: "d".into(),
                }]
            }),
            releases: releases.then(|| {
                vec![crate::model::SrcRelease {
                    tag_name: "v1".into(),
                    name: "v1".into(),
                    notes: String::new(),
                    assets: Vec::new(),
                    dropped: 0,
                    source_url: String::new(),
                }]
            }),
            ..SrcCollab::default()
        }
    }

    #[test]
    fn a_private_destination_skips_label_definitions_unless_asked() {
        let (plan, warnings) = collab_plan(&src_with(true, false), Role::Maintainer, true, false);
        assert!(
            plan.labels.is_none(),
            "definitions are plaintext: not mirrored by default"
        );
        let all = warnings.join("\n");
        assert!(all.contains("--include-label-definitions"), "{all}");
        assert!(
            all.contains(
                "label definitions (names, colours, descriptions) and numbers stay readable"
            ),
            "{all}"
        );
        let (plan, _) = collab_plan(&src_with(true, false), Role::Maintainer, true, true);
        assert!(plan.labels.is_some(), "mirrored when asked");
        let (plan, warnings) = collab_plan(&src_with(true, false), Role::Maintainer, false, false);
        assert!(
            plan.labels.is_some() && warnings.is_empty(),
            "a public destination is unchanged"
        );
    }

    #[test]
    fn releases_are_left_out_for_a_private_destination_or_a_writer() {
        let (plan, w) = collab_plan(&src_with(false, true), Role::Maintainer, true, false);
        assert!(
            plan.releases.is_none() && w.iter().any(|w| w.contains("releases were not mirrored"))
        );
        let (plan, _) = collab_plan(&src_with(false, true), Role::Writer, false, false);
        assert!(plan.releases.is_none());
        let (plan, _) = collab_plan(&src_with(false, true), Role::Maintainer, false, false);
        assert!(plan.releases.is_some());
    }

    #[test]
    fn dest_urls_and_info() {
        let d = DestRepo {
            owner: "O".into(),
            name: "n".into(),
            existing: None,
        };
        assert_eq!(d.url(), "dash://O/n");
        let i = d.info(false);
        assert!(i.id.is_empty() && !i.created);
    }
}
