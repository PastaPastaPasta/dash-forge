//! `dg org` — organizations: repository owners that are N-of-M multisig identities made in
//! multisig.dashhq.org (docs/design/organizations.md). A member connects one, reviews and signs
//! the requests its members make, and the last signature puts a request on Platform.
//!
//! The recovery phrase comes from `--phrase-file`, `DG_ORG_PHRASE` or a hidden prompt, and is
//! never stored. Connected organizations are kept in `orgs.json` beside `config.toml`, public
//! values only.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use forge_core::org::request::{self, Request, RequestStatus};
use forge_core::org::{self as core_org, MemberKeys, Org, OrgRecord, Seed};
use forge_core::platform::PlatformClient;
use forge_core::rules::v2::Role;
use forge_core::user_error::{codes, UserError};

use crate::context::Ctx;

/// Where the organization recovery phrase comes from.
#[derive(Debug, Clone, Default, clap::Args)]
pub struct PhraseArgs {
    /// Read your organization recovery phrase from this file (else DG_ORG_PHRASE, else a hidden
    /// prompt). It is never stored.
    #[arg(long, value_name = "FILE")]
    pub phrase_file: Option<PathBuf>,
    /// Read the phrase's passphrase from this file (else DG_ORG_PASSPHRASE; none by default).
    #[arg(long, value_name = "FILE")]
    pub passphrase_file: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum OrgCommand {
    /// Connect an organization you are a member of, from its group invite.
    ///
    /// The group id (or invite link) comes from multisig.dashhq.org. dg reads the group's
    /// messages, checks its key ceremony and finds the organization's identity.
    Connect {
        /// The group id, or the invite link that holds it.
        group: String,
        /// The group's relay (default: the hosted one at multisig.dashhq.org).
        #[arg(long, value_name = "URL")]
        relay: Option<String>,
        #[command(flatten)]
        phrase: PhraseArgs,
    },
    /// List the organizations connected on this computer.
    List,
    /// Open requests in your organizations, and which wait for your signature.
    Requests {
        /// Only this organization (its identity id or name).
        #[arg(long, value_name = "ORG")]
        org: Option<String>,
    },
    /// Show what a request does, who signed it and what is left.
    Show {
        /// The request id (`dg org requests` lists them).
        request: String,
    },
    /// Sign a request after checking what it writes. The last signature puts it on Platform.
    Sign {
        /// The request id.
        request: String,
        #[command(flatten)]
        phrase: PhraseArgs,
    },
    /// Decline a request. It stays open for the others; it never completes without enough
    /// signatures.
    Decline {
        /// The request id.
        request: String,
        /// Why, for the other members.
        #[arg(long)]
        reason: Option<String>,
        #[command(flatten)]
        phrase: PhraseArgs,
    },
    /// Put a fully signed request on Platform, or finish one that stopped part way.
    Finish {
        /// The request id.
        request: String,
        #[command(flatten)]
        phrase: PhraseArgs,
    },
}

pub async fn run(ctx: &Ctx, cmd: &OrgCommand) -> Result<()> {
    require_enabled(ctx)?;
    match cmd {
        OrgCommand::Connect {
            group,
            relay,
            phrase,
        } => connect(ctx, group, relay.as_deref(), phrase).await,
        OrgCommand::List => {
            list(ctx);
            Ok(())
        }
        OrgCommand::Requests { org } => requests(ctx, org.as_deref()).await,
        OrgCommand::Show { request } => show(ctx, request).await,
        OrgCommand::Sign { request, phrase } => sign(ctx, request, phrase).await,
        OrgCommand::Decline {
            request,
            reason,
            phrase,
        } => decline(ctx, request, reason.as_deref().unwrap_or(""), phrase).await,
        OrgCommand::Finish { request, phrase } => finish(ctx, request, phrase).await,
    }
}

/// Organizations are not on mainnet yet: one sentence, before anything else.
pub fn require_enabled(ctx: &Ctx) -> Result<()> {
    if core_org::enabled(ctx.network()) {
        Ok(())
    } else {
        Err(UserError::new(codes::UNSUPPORTED, core_org::NOT_ON_MAINNET).into())
    }
}

// --- the local record ------------------------------------------------------------------------

fn store_path() -> Result<PathBuf> {
    Ok(crate::config::config_dir()?.join("orgs.json"))
}

fn load_all_from(path: &Path) -> Result<Vec<OrgRecord>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).with_context(|| format!("reading {}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

fn save_all_to(path: &Path, list: &[OrgRecord]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)
        .with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

/// The organizations connected on this computer for `ctx`'s network.
pub fn connected(ctx: &Ctx) -> Vec<OrgRecord> {
    let network = ctx.network_label();
    store_path()
        .and_then(|p| load_all_from(&p))
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.network == network)
        .collect()
}

fn remember(record: &OrgRecord) -> Result<()> {
    let path = store_path()?;
    let mut all = load_all_from(&path)?;
    all.retain(|r| !(r.network == record.network && r.org_id == record.org_id));
    all.push(record.clone());
    save_all_to(&path, &all)
}

fn pick<'a>(orgs: &'a [OrgRecord], which: &str) -> Option<&'a OrgRecord> {
    orgs.iter()
        .find(|r| r.org_id == which)
        .or_else(|| orgs.iter().find(|r| r.label.eq_ignore_ascii_case(which)))
}

// --- the phrase ------------------------------------------------------------------------------

fn read_secret_file(path: &Path, what: &str) -> Result<Zeroizing<String>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading the {what} from {}", path.display()))?;
    Ok(Zeroizing::new(
        text.trim_end_matches(['\r', '\n']).to_string(),
    ))
}

/// Derive the member's keys from their recovery phrase, read from the file, the environment or
/// a hidden prompt.
fn unlock(ctx: &Ctx, args: &PhraseArgs) -> Result<(Seed, MemberKeys)> {
    let env = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|v| !v.is_empty())
            .map(Zeroizing::new)
    };
    let (phrase, prompted) = if let Some(p) = &args.phrase_file {
        (read_secret_file(p, "recovery phrase")?, false)
    } else if let Some(p) = env("DG_ORG_PHRASE") {
        (p, false)
    } else if ctx.stdin_tty {
        let p = crate::prompt::read_hidden(
            "Organization recovery phrase (multisig.dashhq.org): ".into(),
            "reading the recovery phrase",
        )?;
        (Zeroizing::new(p), true)
    } else {
        return Err(
            UserError::new(codes::USAGE, "no organization recovery phrase given")
                .fix("pass --phrase-file <file>, or set DG_ORG_PHRASE")
                .into(),
        );
    };
    let passphrase = if let Some(p) = &args.passphrase_file {
        read_secret_file(p, "passphrase")?
    } else if let Some(p) = env("DG_ORG_PASSPHRASE") {
        p
    } else if prompted {
        Zeroizing::new(crate::prompt::read_hidden(
            "Passphrase (Enter if none): ".into(),
            "reading the passphrase",
        )?)
    } else {
        Zeroizing::new(String::new())
    };
    let seed = Seed::from_phrase(&phrase, &passphrase)?;
    let keys = MemberKeys::derive(&seed);
    Ok((seed, keys))
}

/// The member keys `record` was connected with, or why this phrase is someone else's.
fn unlock_for(ctx: &Ctx, args: &PhraseArgs, record: &OrgRecord) -> Result<(Seed, MemberKeys)> {
    let (seed, keys) = unlock(ctx, args)?;
    if keys.auth_pub != record.auth_pub {
        return Err(UserError::new(
            codes::KEY_MISMATCH,
            format!(
                "this recovery phrase is not the one you connected {} with",
                record.label
            ),
        )
        .fix("check the phrase and its passphrase, or connect again with `dg org connect`")
        .into());
    }
    Ok((seed, keys))
}

// --- commands --------------------------------------------------------------------------------

async fn connect(ctx: &Ctx, group: &str, relay: Option<&str>, phrase: &PhraseArgs) -> Result<()> {
    let room = core_org::parse_group_id(group).ok_or_else(|| {
        crate::errors::usage(format!(
            "{group} is not a group id or invite link from multisig.dashhq.org"
        ))
    })?;
    let relay = relay.unwrap_or(core_org::DEFAULT_RELAY);
    let (_, keys) = unlock(ctx, phrase)?;
    let client = ctx.connect().await?;
    let (record, _) = core_org::connect(&client, relay, &room, &keys).await?;
    remember(&record)?;
    let members: Vec<Value> = record
        .members
        .iter()
        .map(|m| json!({ "index": m.index, "name": m.name, "authPub": m.auth_pub, "you": m.auth_pub == record.auth_pub }))
        .collect();
    ctx.emit(
        json!({
            "status": "connected",
            "orgId": record.org_id,
            "label": record.label,
            "threshold": record.threshold,
            "members": members,
            "network": record.network,
            "room": record.room,
            "relay": record.relay,
        }),
        || {
            println!(
                "Connected {} ({} of {}): {}",
                record.label,
                record.threshold,
                record.members.len(),
                record.org_id
            );
            let names: Vec<String> = record
                .members
                .iter()
                .map(|m| {
                    if m.auth_pub == record.auth_pub {
                        format!("{} (you)", m.name)
                    } else {
                        m.name.clone()
                    }
                })
                .collect();
            println!("Members: {}", names.join(", "));
            println!("`dg org requests` shows what waits for your signature.");
        },
    );
    Ok(())
}

fn list(ctx: &Ctx) {
    let orgs = connected(ctx);
    ctx.emit(
        json!({ "network": ctx.network_label(), "orgs": orgs }),
        || {
            if orgs.is_empty() {
                println!("No organizations connected. `dg org connect <group id>` connects one.");
            }
            for r in &orgs {
                println!(
                    "{}  {} of {}  {}",
                    r.label,
                    r.threshold,
                    r.members.len(),
                    r.org_id
                );
            }
        },
    );
}

/// One request's row: who signed, its status (with Platform's view when `client` is given).
struct Row {
    org: OrgRecord,
    request: Request,
    status: RequestStatus,
    collected: usize,
    threshold: usize,
    signed: bool,
    declined: bool,
}

impl Row {
    async fn of(org: &Org, client: Option<&PlatformClient>, req: Request) -> Self {
        let mut status = request::status(&org.state, &req, None);
        if let (Some(client), RequestStatus::Collecting | RequestStatus::Ready) = (client, status) {
            if let Ok(view) = org.chain_view(client, &req).await {
                status = request::status(&org.state, &req, Some(&view));
            }
        }
        let (collected, _) = request::collected(&org.state, &req);
        let me = &org.record.auth_pub;
        Self {
            signed: request::approved_by(&org.state, &req, me),
            declined: request::declined_by(&org.state, &req, me),
            org: org.record.clone(),
            status,
            collected,
            threshold: org.threshold(),
            request: req,
        }
    }

    fn title(&self) -> &str {
        if self.request.forge {
            &self.request.title
        } else {
            "Made outside Forge"
        }
    }

    fn json(&self) -> Value {
        json!({
            "org": self.org.label,
            "orgId": self.org.org_id,
            "id": self.request.id,
            "title": self.title(),
            "forge": self.request.forge,
            "status": self.status,
            "collected": self.collected,
            "threshold": self.threshold,
            "signedByYou": self.signed,
            "declinedByYou": self.declined,
        })
    }

    fn open(&self) -> bool {
        matches!(
            self.status,
            RequestStatus::Collecting | RequestStatus::Ready
        )
    }

    fn waits_for_you(&self) -> bool {
        self.status == RequestStatus::Collecting && !self.signed && !self.declined
    }

    fn state_text(&self) -> String {
        match self.status {
            RequestStatus::Collecting if self.waits_for_you() => format!(
                "{} of {} signed · waiting for you",
                self.collected, self.threshold
            ),
            RequestStatus::Collecting => format!("{} of {} signed", self.collected, self.threshold),
            RequestStatus::Ready => "signed, not on Platform yet".into(),
            other => other.label().into(),
        }
    }
}

async fn requests(ctx: &Ctx, which: Option<&str>) -> Result<()> {
    let all = connected(ctx);
    let orgs: Vec<OrgRecord> = match which {
        Some(w) => vec![pick(&all, w).cloned().ok_or_else(|| not_connected(w))?],
        None => all,
    };
    if orgs.is_empty() {
        list(ctx);
        return Ok(());
    }
    let client = ctx.connect().await.ok();
    let mut rows = Vec::new();
    for record in orgs {
        let org = Org::load(record).await?;
        for req in org.requests() {
            rows.push(Row::of(&org, client.as_ref(), req).await);
        }
    }
    let open: Vec<&Row> = rows.iter().filter(|r| r.open()).collect();
    ctx.emit(
        json!({ "requests": rows.iter().map(Row::json).collect::<Vec<_>>() }),
        || {
            if open.is_empty() {
                println!("No open requests.");
                return;
            }
            let mut last_org = String::new();
            for r in &open {
                if r.org.org_id != last_org {
                    println!(
                        "{} ({} of {})",
                        r.org.label,
                        r.org.threshold,
                        r.org.members.len()
                    );
                    last_org.clone_from(&r.org.org_id);
                }
                println!("  {}  {}  {}", r.request.id, r.title(), r.state_text());
            }
            if let Some(r) = open.iter().find(|r| r.waits_for_you()) {
                println!(
                    "Review and sign: dg org show {0}, then dg org sign {0}",
                    r.request.id
                );
            } else if let Some(r) = open.iter().find(|r| r.status == RequestStatus::Ready) {
                println!("Put it on Platform: dg org finish {}", r.request.id);
            }
        },
    );
    Ok(())
}

fn not_connected(which: &str) -> anyhow::Error {
    UserError::new(
        codes::NOT_FOUND,
        format!("{which} is not an organization connected on this computer"),
    )
    .fix("`dg org list` lists them; `dg org connect <group id>` connects one")
    .into()
}

/// The connected organization holding request `id` on this network.
async fn find_request(ctx: &Ctx, id: &str) -> Result<(Org, Request)> {
    let orgs = connected(ctx);
    if orgs.is_empty() {
        return Err(
            UserError::new(codes::NOT_FOUND, "no organization is connected")
                .fix("`dg org connect <group id>` connects one")
                .into(),
        );
    }
    for record in orgs {
        let org = Org::load(record).await?;
        if let Ok(req) = org.find(id) {
            return Ok((org, req));
        }
    }
    Err(crate::errors::not_found(
        format!("no connected organization has a request {id}"),
        "`dg org requests` lists them",
    ))
}

async fn show(ctx: &Ctx, id: &str) -> Result<()> {
    let (org, req) = find_request(ctx, id).await?;
    let client = ctx.connect().await?;
    let forge = ctx.target.require_v2()?.clone();
    let row = Row::of(&org, Some(&client), req.clone()).await;
    let described = org.describe(&client, &req).await;
    let reviews = org.review(&client, &forge, &req).await?;
    let problems: Vec<String> = reviews.iter().flat_map(|r| r.problems.clone()).collect();
    let name = |auth: &String| org.record.member_name(auth);
    let mut signers: Vec<String> = Vec::new();
    let mut declined: Vec<(String, String)> = Vec::new();
    for pid in &req.proposals {
        let p = &org.state.proposals[pid];
        for a in p.approvers() {
            if !signers.contains(&name(a)) {
                signers.push(name(a));
            }
        }
        for (a, r) in &p.rejections {
            if !declined.iter().any(|(n, _)| *n == name(a)) {
                declined.push((name(a), r.reason.clone()));
            }
        }
    }
    let next = match row.status {
        RequestStatus::Collecting if row.waits_for_you() && problems.is_empty() => {
            Some(format!("dg org sign {}", req.id))
        }
        RequestStatus::Ready => Some(format!("dg org finish {}", req.id)),
        _ => None,
    };
    let mut value = row.json();
    value["writes"] = json!(described);
    value["signers"] = json!(signers);
    value["declined"] = json!(declined
        .iter()
        .map(|(by, reason)| json!({ "by": by, "reason": reason }))
        .collect::<Vec<_>>());
    value["problems"] = json!(problems);
    value["next"] = json!(next);
    ctx.emit(value, || {
        println!("{}", row.title());
        println!(
            "{} · request {} · {}",
            org.record.label,
            req.id,
            row.state_text()
        );
        for (i, d) in described.iter().enumerate() {
            println!("  {}. {d}", i + 1);
        }
        if !signers.is_empty() {
            println!("Signed by: {}", signers.join(", "));
        }
        for (by, reason) in &declined {
            if reason.is_empty() {
                println!("Declined by: {by}");
            } else {
                println!("Declined by: {by} ({reason})");
            }
        }
        if !problems.is_empty() && row.open() {
            println!("Forge won't sign it: {}", problems.join("; "));
        }
        if let Some(n) = &next {
            println!("Next: {n}");
        }
    });
    Ok(())
}

async fn sign(ctx: &Ctx, id: &str, phrase: &PhraseArgs) -> Result<()> {
    let (mut org, req) = find_request(ctx, id).await?;
    let (seed, keys) = unlock_for(ctx, phrase, &org.record)?;
    let client = ctx.connect().await?;
    let forge = ctx.target.require_v2()?.clone();
    let signed = org.sign(&client, &forge, &seed, &keys, &req).await?;
    let req = org.find(&req.id)?;
    let (collected, _) = request::collected(&org.state, &req);
    let threshold = org.threshold();
    let done = signed.finished.is_some_and(|f| f.done);
    let status = if done {
        "done"
    } else if signed.posted == 0 {
        "alreadySigned"
    } else {
        "signed"
    };
    ctx.emit(
        json!({
            "status": status,
            "org": org.record.label,
            "id": req.id,
            "collected": collected,
            "threshold": threshold,
            "broadcast": signed.finished.map_or(0, |f| f.broadcast),
        }),
        || {
            if done {
                println!(
                    "Signed. That was the last signature: {} is on Platform.",
                    title_of(&req)
                );
            } else if signed.posted == 0 {
                println!("You already signed this request: {collected} of {threshold} collected.");
            } else {
                println!("Signed: {collected} of {threshold} collected.");
            }
        },
    );
    Ok(())
}

async fn decline(ctx: &Ctx, id: &str, reason: &str, phrase: &PhraseArgs) -> Result<()> {
    let (mut org, req) = find_request(ctx, id).await?;
    let (_, keys) = unlock_for(ctx, phrase, &org.record)?;
    let posted = org.decline(&keys, &req, reason).await?;
    ctx.emit(
        json!({ "status": "declined", "org": org.record.label, "id": req.id, "posted": posted }),
        || println!("Declined: {}.", title_of(&req)),
    );
    Ok(())
}

async fn finish(ctx: &Ctx, id: &str, phrase: &PhraseArgs) -> Result<()> {
    let (mut org, req) = find_request(ctx, id).await?;
    let (_, keys) = unlock_for(ctx, phrase, &org.record)?;
    let client = ctx.connect().await?;
    let forge = ctx.target.require_v2()?.clone();
    let finished = org.finish(&client, &forge, &keys, &req).await?;
    let req = org.find(&req.id)?;
    let (collected, _) = request::collected(&org.state, &req);
    let threshold = org.threshold();
    ctx.emit(
        json!({
            "status": if finished.done { "done" } else { "collecting" },
            "org": org.record.label,
            "id": req.id,
            "broadcast": finished.broadcast,
            "collected": collected,
            "threshold": threshold,
        }),
        || {
            if finished.done {
                println!("Done: {} is on Platform.", title_of(&req));
            } else {
                println!("Not ready: {collected} of {threshold} signatures collected.");
            }
        },
    );
    Ok(())
}

fn title_of(req: &Request) -> String {
    if req.title.is_empty() {
        format!("request {}", req.id)
    } else {
        req.title.clone()
    }
}

// --- owner actions on an organization's repository -------------------------------------------

/// Post `planned` as a new request signed with this member's share, and say what to send the
/// co-signers. `extra` is merged into the JSON result.
async fn post_request(
    ctx: &Ctx,
    client: &PlatformClient,
    org: &mut Org,
    seed: &Seed,
    keys: &MemberKeys,
    planned: core_org::actions::Planned,
    extra: Value,
) -> Result<()> {
    let req = org
        .propose(client, seed, keys, &planned.title, planned.writes)
        .await?;
    let (collected, _) = request::collected(&org.state, &req);
    let threshold = org.threshold();
    let sign_line = format!("dg org sign {}", req.id);
    let mut value = json!({
        "status": "requested",
        "org": org.record.label,
        "orgId": org.record.org_id,
        "requestId": req.id,
        "title": req.title,
        "collected": collected,
        "threshold": threshold,
        "signCommand": sign_line,
    });
    if let (Some(v), Some(e)) = (value.as_object_mut(), extra.as_object()) {
        v.extend(e.clone());
    }
    ctx.emit(value, || {
        println!("Request {}: {}", req.id, req.title);
        println!("{collected} of {threshold} collected. Send this to your co-signers:");
        println!("  {sign_line}");
    });
    Ok(())
}

/// The connected organization `which` names (id or name), loaded with its identity, and this
/// member's keys.
async fn open_owner(
    ctx: &Ctx,
    client: &PlatformClient,
    record: OrgRecord,
    phrase: &PhraseArgs,
) -> Result<(Org, forge_core::platform::LoadedIdentity, Seed, MemberKeys)> {
    let (seed, keys) = unlock_for(ctx, phrase, &record)?;
    let mut org = Org::load(record).await?;
    let identity = org.bind(client).await?;
    Ok((org, identity, seed, keys))
}

/// Why `owner` cannot be used as an organization owner: it is not connected here.
async fn owner_refusal(client: &PlatformClient, owner: &str) -> anyhow::Error {
    let multisig = client
        .fetch_identity(owner)
        .await
        .is_ok_and(|i| is_multisig(&i));
    if multisig {
        UserError::new(
            codes::NOT_FOUND,
            format!("{owner} is an organization that is not connected on this computer"),
        )
        .fix("if you are one of its members, run `dg org connect <group id>` first")
        .into()
    } else {
        UserError::new(
            codes::USAGE,
            format!("{owner} is not an organization: --owner names an organization you connected"),
        )
        .fix("`dg org list` lists them; leave out --owner to create the repository as yourself")
        .into()
    }
}

/// An identity whose enabled authentication keys are all BLS12-381: a multisig (§3 "Detected").
pub fn is_multisig(identity: &forge_core::platform::LoadedIdentity) -> bool {
    let auth: Vec<_> = identity
        .public_keys()
        .into_iter()
        .filter(|k| k.purpose == "AUTHENTICATION" && !k.disabled)
        .collect();
    !auth.is_empty() && auth.iter().all(|k| k.key_type == "BLS12_381")
}

/// `dg repo create --owner <org>`: a request for the repository, its owner's maintainer document
/// and its first config.
pub async fn request_repo_create(
    ctx: &Ctx,
    owner: &str,
    args: &crate::RepoCreateArgs,
) -> Result<()> {
    require_enabled(ctx)?;
    let o = &args.opts;
    if args.push {
        return Err(crate::errors::usage(
            "--push can't be used with --owner: the repository exists once enough members sign the request",
        ));
    }
    if o.private {
        return Err(UserError::new(
            codes::PRIVATE_UNSUPPORTED,
            "an organization's repositories are public for now",
        )
        .into());
    }
    let client = ctx.connect().await?;
    let orgs = connected(ctx);
    let Some(record) = pick(&orgs, owner).cloned() else {
        return Err(owner_refusal(&client, owner).await);
    };
    let name = match &args.name {
        Some(n) => n.clone(),
        None => std::env::current_dir()
            .ok()
            .and_then(|d| d.file_name().map(|n| n.to_string_lossy().into_owned()))
            .ok_or_else(|| {
                crate::errors::usage("name the repository: `dg repo create <name> --owner <org>`")
            })?,
    };
    let opts = forge_core::create::CreateRepoOpts {
        display_name: o.display_name.clone(),
        description: o.description.clone(),
        default_branch: o.default_branch.clone().unwrap_or_else(|| "main".into()),
        protect: !o.no_protect,
        ..forge_core::create::CreateRepoOpts::public(name)
    };
    let (mut org, identity, seed, keys) = open_owner(ctx, &client, record, &args.phrase).await?;
    let writer = forge_core::platform::org::OrgWriter::new(&client, &identity, org.key_id)?;
    let mut nonces = core_org::actions::Nonces::new(&writer, org.open_nonces());
    let owner = core_org::actions::Owner {
        client: &client,
        org: &identity,
        writer: &writer,
        label: &org.record.label,
    };
    let planned = core_org::actions::repo_create(&owner, &mut nonces, &opts).await?;
    let repo_id = planned.writes[0].document_id.clone();
    let extra = json!({ "repoId": repo_id, "ownerId": identity.id(), "name": forge_core::resolve::repo_slug(&opts.name)? });
    post_request(ctx, &client, &mut org, &seed, &keys, planned, extra).await
}

/// `dg collab add|remove` on a repository a connected organization owns: a request instead of a
/// write. `None` when the repository is not an organization's this computer is connected to
/// (no network read when no organization is connected).
pub async fn route_member_change(
    ctx: &Ctx,
    repo: &str,
    member: &str,
    role: Role,
    add: bool,
    phrase: &PhraseArgs,
) -> Result<Option<()>> {
    let orgs = connected(ctx);
    if orgs.is_empty() || !core_org::enabled(ctx.network()) {
        return Ok(None);
    }
    let client = ctx.connect().await?;
    let repo_ref = crate::common::RepoRef::parse(repo)?;
    let Ok(handle) = crate::common::resolve_for(&client, None, &repo_ref).await else {
        return Ok(None);
    };
    let Some(record) = orgs.iter().find(|r| r.org_id == handle.owner_id()).cloned() else {
        return Ok(None);
    };
    let member = crate::common::resolve_identity(&client, member, "member").await?;
    let member_name = client
        .dpns_names_of(&member)
        .await
        .ok()
        .and_then(|n| n.into_iter().next())
        .unwrap_or_else(|| member.clone());
    let label = format!("{}/{}", record.label, handle.name());
    let (mut org, identity, seed, keys) = open_owner(ctx, &client, record, phrase).await?;
    let writer = forge_core::platform::org::OrgWriter::new(&client, &identity, org.key_id)?;
    let mut nonces = core_org::actions::Nonces::new(&writer, org.open_nonces());
    let owner = core_org::actions::Owner {
        client: &client,
        org: &identity,
        writer: &writer,
        label: &label,
    };
    let planned = if add {
        core_org::actions::grant(&owner, &mut nonces, &handle, &member, &member_name, role).await?
    } else {
        core_org::actions::revoke(&owner, &mut nonces, &handle, &member, &member_name, role).await?
    };
    let extra = json!({ "member": member, "role": role.as_str(), "repo": label });
    post_request(ctx, &client, &mut org, &seed, &keys, planned, extra).await?;
    Ok(Some(()))
}

/// The refusal a maintainer gets for an owner action on an organization's repository they
/// cannot sign for, or `None` when the owner is not an organization.
pub async fn org_owner_refusal(
    client: &PlatformClient,
    handle: &forge_core::scope::RepoRef,
    what: &str,
) -> Option<anyhow::Error> {
    if !core_org::enabled(client.network()) {
        return None;
    }
    let owner = client.fetch_identity(handle.owner_id()).await.ok()?;
    is_multisig(&owner).then(|| {
        UserError::new(
            codes::NOT_A_WRITER,
            format!("{} is owned by an organization: its members must {what}", handle.display()),
        )
        .fix("a member connects it with `dg org connect <group id>`, then runs this command; the others sign with `dg org sign`")
        .into()
    })
}

/// The `dg auth status` line: how many requests wait for this member's signature, or `None`
/// when no organization is connected (nothing is read then).
pub async fn waiting_count(ctx: &Ctx) -> Option<usize> {
    let orgs = connected(ctx);
    if orgs.is_empty() || !core_org::enabled(ctx.network()) {
        return None;
    }
    let mut n = 0;
    for record in orgs {
        if let Ok(org) = Org::load(record).await {
            n += org.waiting().len();
        }
    }
    Some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(network: &str, id: &str, label: &str) -> OrgRecord {
        OrgRecord {
            network: network.into(),
            org_id: id.into(),
            room: "t_000102030405060708090a0b0c0d0e0f".into(),
            relay: core_org::DEFAULT_RELAY.into(),
            auth_pub: "e40009bfc871bc5cb5f02fd1d71e13cbed2457d661bbad2920ff07add85402bb".into(),
            label: label.into(),
            threshold: 2,
            members: Vec::new(),
        }
    }

    #[test]
    fn the_record_keeps_public_values_and_replaces_by_network_and_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orgs.json");
        assert!(load_all_from(&path).unwrap().is_empty());
        let a = record("testnet", "A", "acme");
        save_all_to(&path, &[a.clone(), record("devnet-x", "A", "acme")]).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"orgId\": \"A\"") && text.contains("\"authPub\""));
        assert!(!text.to_lowercase().contains("phrase"));
        let back = load_all_from(&path).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(pick(&back, "ACME"), Some(&a));
        assert_eq!(pick(&back, "A"), Some(&a));
        assert_eq!(pick(&back, "nope"), None);
    }
}
