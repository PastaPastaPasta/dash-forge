//! `dg org` — organizations: repository owners that are N-of-M multisig identities made in
//! multisig.dashhq.org (docs/design/organizations.md). A member connects one, reviews and signs
//! the requests its members make, and the last signature puts a request on Platform.
//!
//! Requests, signatures, declines and broadcast records are `forge-org` documents on Platform
//! (§10), written by the member's own signed-in identity. The relay is read only for the key
//! ceremony when connecting.
//!
//! The recovery phrase comes from `--phrase-file`, `DG_ORG_PHRASE` or a hidden prompt, and is
//! never stored. Connected organizations are kept in `orgs.json` beside `config.toml`, public
//! values only, and each one's key ceremony in `org-ceremonies/`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use forge_core::org::owner::OwnerKind;
use forge_core::org::request::{self, Request, RequestStatus, Summary};
use forge_core::org::{self as core_org, MemberKeys, Org, OrgRecord, Seed};
use forge_core::platform::{LoadedIdentity, PlatformClient, WriteEngine};
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
    /// Hide a request on this computer (free; nothing is written). For a request Forge won't
    /// sign; decline a valid request you disagree with instead.
    Dismiss {
        /// The request id.
        request: String,
    },
    /// Copy your own messages in the relay's open requests to Platform (once per member, after
    /// upgrading dg). Requests nobody copies can still be finished in multisig.dashhq.org.
    Migrate {
        /// The organization (its identity id or name).
        org: String,
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
        OrgCommand::Dismiss { request } => dismiss(ctx, request).await,
        OrgCommand::Migrate { org, phrase } => migrate(ctx, org, phrase).await,
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

/// Where an organization's key ceremony is kept: `org-ceremonies/<network>-<org id>.json`
/// beside `orgs.json` (public messages only).
fn ceremony_path_in(dir: &Path, record: &OrgRecord) -> PathBuf {
    dir.join("org-ceremonies")
        .join(format!("{}-{}.json", record.network, record.org_id))
}

fn save_ceremony_in(dir: &Path, record: &OrgRecord, messages: &[Value]) -> Result<()> {
    let path = ceremony_path_in(dir, record);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(messages)?)
        .with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("writing {}", path.display()))
}

fn load_ceremony_in(dir: &Path, record: &OrgRecord) -> Vec<Value> {
    std::fs::read(ceremony_path_in(dir, record))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn load_ceremony(record: &OrgRecord) -> Vec<Value> {
    crate::config::config_dir()
        .map(|d| load_ceremony_in(&d, record))
        .unwrap_or_default()
}

/// forge-org's id on this network, or why organizations can't be used here yet.
fn org_contract(ctx: &Ctx) -> Result<String> {
    ctx.target.require_v2()?.org.clone().ok_or_else(|| {
        UserError::new(
            codes::NOT_DEPLOYED,
            format!(
                "organizations need the forge-org contract, which is not registered on {} yet",
                ctx.network_label()
            ),
        )
        .into()
    })
}

/// Read `record`'s organization from Platform.
async fn load(ctx: &Ctx, client: &PlatformClient, record: OrgRecord) -> Result<Org> {
    let contract = org_contract(ctx)?;
    let ceremony = load_ceremony(&record);
    Ok(Org::load(client, &contract, record, ceremony).await?)
}

/// The signed-in identity, which writes this member's messages.
struct Member {
    bridge: forge_core::keystore::BridgeIdentity,
    identity: LoadedIdentity,
}

impl Member {
    async fn of(ctx: &Ctx, client: &PlatformClient) -> Result<Self> {
        let (bridge, identity) = ctx.signer_on(client).await?;
        Ok(Self { bridge, identity })
    }

    fn engine<'a>(&'a self, client: &'a PlatformClient) -> Result<WriteEngine<'a>> {
        Ok(WriteEngine::new(
            client,
            &self.identity,
            self.bridge.doc_op_key()?,
        )?)
    }
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
    let contract = org_contract(ctx)?;
    let (seed, keys) = unlock(ctx, phrase)?;
    let client = ctx.connect().await?;
    let member = Member::of(ctx, &client).await?;
    let engine = member.engine(&client)?;
    let (record, ceremony) =
        core_org::connect(&client, &contract, relay, &room, &seed, &keys, &engine).await?;
    let mut record = record;
    if let Some(old) = connected(ctx).into_iter().find(|r| r.org_id == record.org_id) {
        record.dismissed = old.dismissed;
    }
    save_ceremony_in(&crate::config::config_dir()?, &record, &ceremony)?;
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
                line(&record.label),
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
            println!("Members: {}", line(&names.join(", ")));
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
                    line(&r.label),
                    r.threshold,
                    r.members.len(),
                    r.org_id
                );
            }
        },
    );
}

/// One request's row: who signed, its status (with Platform's view and the review when
/// `client` is given).
struct Row {
    org: OrgRecord,
    request: Request,
    summary: Summary,
    collected: usize,
    threshold: usize,
    signed: bool,
    declined: bool,
    dismissed: bool,
}

impl Row {
    async fn of(
        org: &Org,
        client: Option<(&PlatformClient, &forge_core::network::ForgeIds)>,
        req: Request,
    ) -> Self {
        let mut summary = org.summary(&req, None, &[]);
        if let (Some((client, forge)), true) = (
            client,
            summary.status.is_open() || summary.status == RequestStatus::Done,
        ) {
            let problems = org
                .review(client, forge, &req)
                .await
                .map(|r| Org::review_problems(&r))
                .unwrap_or_default();
            if let Ok(view) = org.chain_view(client, &req).await {
                summary = org.summary(&req, Some(&view), &problems);
            } else {
                summary = org.summary(&req, None, &problems);
            }
        }
        let (collected, threshold) = org.progress(&req);
        let me = &org.record.auth_pub;
        Self {
            signed: request::approved_by(&org.state, &req, me),
            declined: request::declined_by(&org.state, &req, me),
            dismissed: org.record.dismissed.contains(&req.id),
            org: org.record.clone(),
            summary,
            collected,
            threshold,
            request: req,
        }
    }

    fn status(&self) -> RequestStatus {
        self.summary.status
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
            "status": self.status(),
            "text": self.summary.text(),
            "problems": self.summary.problems,
            "parts": self.summary.parts,
            "collected": self.collected,
            "threshold": self.threshold,
            "signedByYou": self.signed,
            "declinedByYou": self.declined,
            "dismissed": self.dismissed,
        })
    }

    fn open(&self) -> bool {
        !self.dismissed && (self.status().is_open() || self.status() == RequestStatus::Invalid)
    }

    fn waits_for_you(&self) -> bool {
        self.status() == RequestStatus::Collecting && !self.signed && !self.declined
    }

    fn state_text(&self) -> String {
        if let Some(text) = self.summary.text() {
            return text;
        }
        match self.status() {
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
    let client = ctx.connect().await?;
    let forge = ctx.target.require_v2()?.clone();
    let mut rows = Vec::new();
    for record in orgs {
        let org = load(ctx, &client, record).await?;
        for req in org.requests() {
            rows.push(Row::of(&org, Some((&client, &forge)), req).await);
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
                        line(&r.org.label),
                        r.org.threshold,
                        r.org.members.len()
                    );
                    last_org.clone_from(&r.org.org_id);
                }
                println!(
                    "  {}  {}  {}",
                    r.request.id,
                    line(r.title()),
                    line(&r.state_text())
                );
            }
            if let Some(r) = open.iter().find(|r| r.waits_for_you()) {
                println!(
                    "Review and sign: dg org show {0}, then dg org sign {0}",
                    r.request.id
                );
            } else if let Some(r) = open.iter().find(|r| r.status() == RequestStatus::Ready) {
                println!("Put it on Platform: dg org finish {}", r.request.id);
            } else if let Some(r) = open.iter().find(|r| r.status() == RequestStatus::Invalid) {
                println!("Hide it on this computer: dg org dismiss {}", r.request.id);
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
async fn find_request(ctx: &Ctx, client: &PlatformClient, id: &str) -> Result<(Org, Request)> {
    let orgs = connected(ctx);
    if orgs.is_empty() {
        return Err(
            UserError::new(codes::NOT_FOUND, "no organization is connected")
                .fix("`dg org connect <group id>` connects one")
                .into(),
        );
    }
    let mut unread = Vec::new();
    for record in orgs {
        let label = record.label.clone();
        match load(ctx, client, record).await {
            Ok(org) => {
                if let Ok(req) = org.find(id) {
                    return Ok((org, req));
                }
            }
            Err(e) => unread.push(format!("{}: {}", line(&label), line(&e.to_string()))),
        }
    }
    if !unread.is_empty() {
        anyhow::bail!(
            "request {id} was not found, and these organizations could not be read: {}",
            unread.join("; ")
        );
    }
    Err(crate::errors::not_found(
        format!("no connected organization has a request {id}"),
        "`dg org requests` lists them",
    ))
}

async fn show(ctx: &Ctx, id: &str) -> Result<()> {
    let client = ctx.connect().await?;
    let (mut org, req) = find_request(ctx, &client, id).await?;
    org.bind(&client).await?;
    let forge = ctx.target.require_v2()?.clone();
    let row = Row::of(&org, Some((&client, &forge)), req.clone()).await;
    let described = org.describe(&client, &req).await;
    let name = |auth: &String| org.record.member_name(auth);
    let mut signers: Vec<String> = Vec::new();
    let mut declined: Vec<(String, String)> = Vec::new();
    for pid in &req.proposals {
        let p = &org.state.proposals[pid];
        for idx in p.requirements.iter().flat_map(|r| r.shares.keys()) {
            let who = org
                .record
                .members
                .iter()
                .find(|m| m.index == *idx)
                .map_or_else(|| format!("member {idx}"), |m| m.name.clone());
            if !signers.contains(&who) {
                signers.push(who);
            }
        }
        for (a, r) in &p.rejections {
            if !declined.iter().any(|(n, _)| *n == name(a)) {
                declined.push((name(a), r.reason.clone()));
            }
        }
    }
    let next = match row.status() {
        RequestStatus::Collecting if row.waits_for_you() => Some(format!("dg org sign {}", req.id)),
        RequestStatus::Ready => Some(format!("dg org finish {}", req.id)),
        RequestStatus::Invalid if !row.dismissed => Some(format!("dg org dismiss {}", req.id)),
        _ => None,
    };
    let mut value = row.json();
    value["writes"] = json!(described);
    value["signers"] = json!(signers);
    value["declined"] = json!(declined
        .iter()
        .map(|(by, reason)| json!({ "by": by, "reason": reason }))
        .collect::<Vec<_>>());
    value["next"] = json!(next);
    ctx.emit(value, || {
        println!("{}", line(row.title()));
        println!(
            "{} · request {} · {}",
            line(&org.record.label),
            req.id,
            line(&row.state_text())
        );
        for (i, d) in described.iter().enumerate() {
            println!("  {}. {}", i + 1, line(d));
        }
        if !signers.is_empty() {
            println!("Signed by: {}", line(&signers.join(", ")));
        }
        for (by, reason) in &declined {
            if reason.is_empty() {
                println!("Declined by: {}", line(by));
            } else {
                println!("Declined by: {} ({})", line(by), line(reason));
            }
        }
        if let Some(n) = &next {
            println!("Next: {n}");
        }
    });
    Ok(())
}

async fn sign(ctx: &Ctx, id: &str, phrase: &PhraseArgs) -> Result<()> {
    let client = ctx.connect().await?;
    let (mut org, req) = find_request(ctx, &client, id).await?;
    let (seed, keys) = unlock_for(ctx, phrase, &org.record)?;
    let member = Member::of(ctx, &client).await?;
    let engine = member.engine(&client)?;
    let forge = ctx.target.require_v2()?.clone();
    if !ctx.json {
        println!("Signing for {}:", line(&org.record.label));
        for (i, d) in org.describe(&client, &req).await.iter().enumerate() {
            println!("  {}. {}", i + 1, line(d));
        }
    }
    let signed = org
        .sign(&client, &forge, &engine, &seed, &keys, &req)
        .await?;
    let req = org.find(&req.id)?;
    let (collected, threshold) = org.progress(&req);
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
    let client = ctx.connect().await?;
    let (mut org, req) = find_request(ctx, &client, id).await?;
    let (seed, keys) = unlock_for(ctx, phrase, &org.record)?;
    let member = Member::of(ctx, &client).await?;
    let engine = member.engine(&client)?;
    let posted = org
        .decline(&client, &engine, &seed, &keys, &req, reason)
        .await?;
    ctx.emit(
        json!({ "status": "declined", "org": org.record.label, "id": req.id, "posted": posted }),
        || println!("Declined: {}.", title_of(&req)),
    );
    Ok(())
}

async fn finish(ctx: &Ctx, id: &str, phrase: &PhraseArgs) -> Result<()> {
    let client = ctx.connect().await?;
    let (mut org, req) = find_request(ctx, &client, id).await?;
    let (_, keys) = unlock_for(ctx, phrase, &org.record)?;
    let member = Member::of(ctx, &client).await?;
    let engine = member.engine(&client)?;
    let forge = ctx.target.require_v2()?.clone();
    let finished = org.finish(&client, &forge, &engine, &keys, &req).await?;
    let req = org.find(&req.id)?;
    let (collected, threshold) = org.progress(&req);
    if !finished.done {
        let err = UserError::new(
            codes::USAGE,
            format!("not ready: {collected} of {threshold} signatures collected"),
        )
        .fix(
            if request::approved_by(&org.state, &req, &org.record.auth_pub) {
                format!(
                    "ask another member to run `dg org sign {}`, or to sign it on the web",
                    req.id
                )
            } else {
                format!("sign it first: `dg org sign {}`", req.id)
            },
        );
        return Err(err.into());
    }
    ctx.emit(
        json!({
            "status": "done",
            "org": org.record.label,
            "id": req.id,
            "broadcast": finished.broadcast,
            "collected": collected,
            "threshold": threshold,
        }),
        || println!("Done: {} is on Platform.", title_of(&req)),
    );
    Ok(())
}

async fn dismiss(ctx: &Ctx, id: &str) -> Result<()> {
    let client = ctx.connect().await?;
    let (org, req) = find_request(ctx, &client, id).await?;
    let mut record = org.record.clone();
    if !record.dismissed.contains(&req.id) {
        record.dismissed.push(req.id.clone());
        remember(&record)?;
    }
    ctx.emit(
        json!({ "status": "dismissed", "org": record.label, "id": req.id }),
        || println!("Dismissed on this computer: {}.", title_of(&req)),
    );
    Ok(())
}

async fn migrate(ctx: &Ctx, which: &str, phrase: &PhraseArgs) -> Result<()> {
    let orgs = connected(ctx);
    let record = pick(&orgs, which).cloned().ok_or_else(|| not_connected(which))?;
    let (seed, keys) = unlock_for(ctx, phrase, &record)?;
    let client = ctx.connect().await?;
    let mut org = load(ctx, &client, record).await?;
    let relay = core_org::Relay::new(&org.record.relay)?;
    let room = relay.messages(&org.record.room).await?;
    let mine = Org::migratable(&room, &org.record.room, &org.cid, &keys.auth_pub);
    if mine.is_empty() {
        ctx.emit(
            json!({ "status": "nothing", "org": org.record.label, "posted": 0 }),
            || println!("Nothing to copy: you have no messages in {}'s open requests on the relay.", line(&org.record.label)),
        );
        return Ok(());
    }
    ctx.confirm_or_cancel(&format!(
        "Copy your {} message(s) in {}'s open requests from the relay to Platform? Your identity pays a small fee for each.",
        mine.len(),
        line(&org.record.label)
    ))?;
    let member = Member::of(ctx, &client).await?;
    let engine = member.engine(&client)?;
    let posted = org.migrate(&client, &engine, &seed, &keys, mine).await?;
    ctx.emit(
        json!({ "status": "migrated", "org": org.record.label, "posted": posted }),
        || println!("Copied {posted} message(s) to Platform. `dg org requests` lists the requests."),
    );
    Ok(())
}

fn title_of(req: &Request) -> String {
    if req.title.is_empty() {
        format!("request {}", req.id)
    } else {
        line(&req.title)
    }
}

fn line(text: &str) -> String {
    core_org::one_line(text)
}

// --- owner actions on an organization's repository -------------------------------------------

/// Post `planned` as a new request signed with this member's share, and say what to send the
/// co-signers. `extra` is merged into the JSON result.
#[allow(clippy::too_many_arguments)]
async fn post_request(
    ctx: &Ctx,
    client: &PlatformClient,
    engine: &WriteEngine<'_>,
    org: &mut Org,
    seed: &Seed,
    keys: &MemberKeys,
    planned: core_org::actions::Planned,
    extra: Value,
) -> Result<()> {
    if !ctx.json {
        eprintln!("This asks {} to:", line(&org.record.label));
        for (i, d) in org
            .describe_writes(client, &planned.writes)
            .await
            .iter()
            .enumerate()
        {
            eprintln!("  {}. {}", i + 1, line(d));
        }
    }
    ctx.confirm_or_cancel(&format!(
        "Ask {} ({} of {}) to: {}? It posts a request with your signature from your identity; the organization pays once enough members sign.",
        line(&org.record.label),
        org.quorum().0,
        org.quorum().1,
        line(&planned.title)
    ))?;
    let req = org
        .propose(client, engine, seed, keys, &planned.title, planned.writes)
        .await?;
    let (collected, threshold) = org.progress(&req);
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
        println!("Request {}: {}", req.id, line(&req.title));
        println!("{collected} of {threshold} collected. Send this to your co-signers:");
        println!("  {sign_line}");
    });
    Ok(())
}

/// The organization acting as owner: loaded with its identity, this member's keys, and the
/// signed-in identity that writes the request.
struct OwnerSession {
    org: Org,
    identity: LoadedIdentity,
    seed: Seed,
    keys: MemberKeys,
    member: Member,
}

async fn open_owner(
    ctx: &Ctx,
    client: &PlatformClient,
    record: OrgRecord,
    phrase: &PhraseArgs,
) -> Result<OwnerSession> {
    let (seed, keys) = unlock_for(ctx, phrase, &record)?;
    let mut org = load(ctx, client, record).await?;
    let identity = org.bind(client).await?;
    let member = Member::of(ctx, client).await?;
    Ok(OwnerSession {
        org,
        identity,
        seed,
        keys,
        member,
    })
}

/// Why `owner` cannot be used as an organization owner: it is not connected here.
async fn owner_refusal(client: &PlatformClient, owner: &str) -> anyhow::Error {
    let multisig = client
        .fetch_identity(owner)
        .await
        .is_ok_and(|i| core_org::owner::all_bls_auth_keys(&i.public_keys()));
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
    if o.storage.is_some() || o.replicas.is_some() || o.remote.is_some() {
        return Err(crate::errors::usage(
            "--storage, --replicas and --remote can't be used with --owner yet",
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
    let mut s = open_owner(ctx, &client, record, &args.phrase).await?;
    let label = s.org.record.label.clone();
    let writer = forge_core::platform::org::OrgWriter::new(&client, &s.identity, s.org.key_id)?;
    let mut nonces = core_org::actions::Nonces::new(&writer, s.org.open_nonces());
    let owner = core_org::actions::Owner {
        client: &client,
        org: &s.identity,
        writer: &writer,
        label: &label,
    };
    let planned = core_org::actions::repo_create(&owner, &mut nonces, &opts).await?;
    let extra = json!({
        "repoId": planned.writes[0].document_id,
        "ownerId": s.identity.id(),
        "name": forge_core::resolve::repo_slug(&opts.name)?,
    });
    let engine = s.member.engine(&client)?;
    post_request(ctx, &client, &engine, &mut s.org, &s.seed, &s.keys, planned, extra).await
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
    let member_name = forge_core::org::session::first_name(&client, &member).await;
    let label = format!("{}/{}", record.label, handle.name());
    let mut s = open_owner(ctx, &client, record, phrase).await?;
    let writer = forge_core::platform::org::OrgWriter::new(&client, &s.identity, s.org.key_id)?;
    let mut nonces = core_org::actions::Nonces::new(&writer, s.org.open_nonces());
    let owner = core_org::actions::Owner {
        client: &client,
        org: &s.identity,
        writer: &writer,
        label: &label,
    };
    let planned = if add {
        core_org::actions::grant(&owner, &mut nonces, &handle, &member, &member_name, role).await?
    } else {
        core_org::actions::revoke(&owner, &mut nonces, &handle, &member, &member_name, role).await?
    };
    let extra = json!({ "member": member, "role": role.as_str(), "repo": label });
    let engine = s.member.engine(&client)?;
    post_request(ctx, &client, &engine, &mut s.org, &s.seed, &s.keys, planned, extra).await?;
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
    let forge = client.target().require_v2().ok()?;
    let kind = core_org::owner::owner_kind(client, forge, handle.owner_id())
        .await
        .ok()?;
    let owner = match kind {
        OwnerKind::Person => return None,
        OwnerKind::Org { threshold, size } => format!("an organization ({threshold} of {size})"),
        OwnerKind::Multisig => "a multisig identity".to_string(),
    };
    Some(
        UserError::new(
            codes::NOT_A_WRITER,
            format!("{} is owned by {owner}: its members must {what}", handle.display()),
        )
        .fix("a member connects it with `dg org connect <group id>`, then runs this command; the others sign with `dg org sign`")
        .into(),
    )
}

/// The `dg auth status` line: how many requests wait for this member's signature, or `None`
/// when no organization is connected (nothing is read then).
pub async fn waiting_count(ctx: &Ctx) -> Option<usize> {
    let orgs = connected(ctx);
    if orgs.is_empty() || !core_org::enabled(ctx.network()) {
        return None;
    }
    let client = tokio::time::timeout(std::time::Duration::from_secs(8), ctx.connect())
        .await
        .ok()
        .and_then(Result::ok)?;
    let mut n = 0;
    for record in orgs {
        let read = tokio::time::timeout(std::time::Duration::from_secs(8), load(ctx, &client, record));
        if let Ok(Ok(org)) = read.await {
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
            dismissed: Vec::new(),
        }
    }

    #[test]
    fn an_older_record_reads_and_the_ceremony_is_kept_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("orgs.json");
        std::fs::write(&path, r#"[{"network":"testnet","orgId":"A","room":"t_000102030405060708090a0b0c0d0e0f","relay":"https://multisig.dashhq.org","authPub":"e4","label":"acme","threshold":2,"members":[]}]"#).unwrap();
        let back = load_all_from(&path).unwrap();
        assert!(back[0].dismissed.is_empty());
        let r = record("testnet", "A", "acme");
        assert!(load_ceremony_in(dir.path(), &r).is_empty());
        save_ceremony_in(dir.path(), &r, &[json!({ "type": "hello" })]).unwrap();
        assert_eq!(load_ceremony_in(dir.path(), &r), vec![json!({ "type": "hello" })]);
        assert!(ceremony_path_in(dir.path(), &r).ends_with("org-ceremonies/testnet-A.json"));
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
