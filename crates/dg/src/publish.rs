//! `dg repo create [--push]` and `dg init` (UX spec §1c, §7.2): create a forge-v2 repository
//! whose on-chain config advertises where its packs live, and — with `--push` / `init` —
//! wire the git repository in the current directory to it and push.
//!
//! Storage is decided **before anything is spent**: `--storage` > git config `dash.storage`
//! (this repo's, then the global one) > the user's only storage profile > a picker (in a
//! terminal) > stop with E508, pricing what Platform storage would cost for this repository.
//!
//! With `--push`, after the create: the remote (`origin` unless `--remote`) is added or
//! checked, the repo-local git config gets `dash.storage` (+ `dash.replicas`), and — when
//! the helper would otherwise resolve another network — `dash.network` / `dash.devnetName`,
//! so a later plain `git push` goes where this one did. Then `git push -u` with the identity
//! and network this `dg` resolved. Everything is safe to re-run: the create is resumable
//! and returns the existing repository, an equal remote is left alone, and a push of an
//! up-to-date branch writes nothing.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context as _, Result};
use serde_json::{json, Value};

use forge_core::create::{create_repo, default_journal_dir, CreateRepoOpts, StepOutcome};
use forge_core::network::NetworkSettings;
use forge_core::repo::BACKEND_URIS_V2;
use forge_core::resolve::repo_slug;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{human_bytes, ResolvedPolicy, StoragePolicy, StorageProfiles};
use forge_core::user_error::{codes, dash, web_url, UserError, CATALOGUE};

use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, REPO_CREATE_ESTIMATE_CREDITS};
use crate::git::{current_branch, dash_env, git, git_ok};
use crate::{CreateOptions, InitArgs, RepoCreateArgs};

/// `dg repo create`.
pub async fn create(ctx: &Ctx, args: &RepoCreateArgs) -> Result<()> {
    let flow = if args.push {
        Flow::CreatePush
    } else {
        Flow::Create
    };
    publish(ctx, args.name.as_deref(), &args.opts, flow).await
}

/// `dg init`: `repo create --push` for the git repository in the current directory.
pub async fn init(ctx: &Ctx, args: &InitArgs) -> Result<()> {
    publish(ctx, args.name.as_deref(), &args.opts, Flow::Init).await
}

/// Which command is running (they differ only in what they print as the equivalent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flow {
    Create,
    CreatePush,
    Init,
}

impl Flow {
    fn pushes(self) -> bool {
        self != Flow::Create
    }

    /// The command line that repeats a prompted storage choice without the prompt.
    fn equivalent(self, name: &str, storage: &str) -> String {
        match self {
            Flow::Create => format!("dg repo create {name} --storage {storage}"),
            Flow::CreatePush => format!("dg repo create {name} --push --storage {storage}"),
            Flow::Init => format!("dg init --name {name} --storage {storage}"),
        }
    }
}

/// The git repository a push goes from.
struct Local {
    /// The work tree root.
    root: PathBuf,
    /// The current branch (`None`: detached HEAD, or an unborn branch without a name).
    branch: Option<String>,
    /// Whether HEAD names a commit.
    has_commits: bool,
}

impl Local {
    /// The git work tree containing the current directory, if any.
    fn discover() -> Option<Self> {
        let cwd = std::env::current_dir().ok()?;
        let root = PathBuf::from(git(&cwd, &["rev-parse", "--show-toplevel"], &[]).ok()?);
        Some(Self {
            branch: current_branch(&root),
            has_commits: git_ok(
                &root,
                &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            ),
            root,
        })
    }

    /// The repository's size on disk (loose objects + packs), from `git count-objects -v`.
    fn size_bytes(&self) -> Option<u64> {
        git(&self.root, &["count-objects", "-v"], &[])
            .ok()
            .map(|out| count_objects_bytes(&out))
    }
}

/// Bytes from `git count-objects -v` output (`size` + `size-pack`, both in KiB).
fn count_objects_bytes(out: &str) -> u64 {
    out.lines()
        .filter_map(|l| l.split_once(": "))
        .filter(|(k, _)| matches!(*k, "size" | "size-pack"))
        .filter_map(|(_, v)| v.trim().parse::<u64>().ok())
        .sum::<u64>()
        * 1024
}

/// A repo name from a directory name: lower-cased, anything outside `a-z 0-9 . _ -` turned
/// into `-`, leading punctuation dropped, at most 63 characters.
pub fn default_name(dir: &str) -> Option<String> {
    let mut out = String::new();
    for c in dir.chars() {
        let c = c.to_ascii_lowercase();
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            c
        } else {
            '-'
        };
        let doubled_dash = c == '-' && out.ends_with('-');
        let leading_punctuation = out.is_empty() && !c.is_ascii_alphanumeric();
        if !doubled_dash && !leading_punctuation {
            out.push(c);
        }
    }
    out.truncate(forge_core::rules::v2::MAX_REPO_NAME_LEN);
    let out = out.trim_end_matches(['-', '.', '_']).to_string();
    (!out.is_empty()).then_some(out)
}

/// Where the storage choice came from (said in the plan and in `--json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Flag,
    GitConfig,
    OnlyProfile,
    Prompt,
}

impl Source {
    fn label(self) -> &'static str {
        match self {
            Source::Flag => "--storage",
            Source::GitConfig => "git config dash.storage",
            Source::OnlyProfile => "your only storage profile",
            Source::Prompt => "chosen at the prompt",
        }
    }
}

/// The storage a new repository's pushes use.
struct Storage {
    policy: ResolvedPolicy,
    source: Source,
}

impl Storage {
    fn names(&self) -> String {
        self.policy.target_names().join(",")
    }

    /// The advertised read bases that fit `config.backend.uris`.
    fn uris(&self) -> Vec<String> {
        let max_len = BACKEND_URIS_V2.max_item_len.unwrap_or(usize::MAX);
        let mut uris: Vec<String> = self
            .policy
            .advertised_uris()
            .into_iter()
            .filter(|u| u.len() <= max_len)
            .collect();
        uris.truncate(BACKEND_URIS_V2.max_items.unwrap_or(usize::MAX));
        uris
    }

    fn json(&self) -> Value {
        json!({
            "profiles": self.policy.target_names(),
            "replicas": self.policy.replicas,
            "source": self.source.label(),
            "mode": self.policy.advertised_mode(),
            "uris": self.uris(),
        })
    }
}

/// `~0.28 DASH/MiB`, plus what `size` bytes would cost when known.
fn platform_price(size: Option<u64>) -> String {
    // The rate is the storage deposit (what the spec and the guides quote); the size's
    // price includes processing fees.
    let per_mib = forge_core::cost::estimate(1024 * 1024).deposit;
    let rate = format!("~{:.2} DASH/MiB", crate::fmt::credits_to_dash(per_mib));
    match size.filter(|b| *b > 0) {
        Some(b) => format!(
            "{rate} ({} ≈ {} DASH)",
            human_bytes(b),
            dash(forge_core::cost::estimate(b).total())
        ),
        None => rate,
    }
}

/// The plan's storage line: `packs → r2-main (1 of 1 must confirm); Platform: manifest + refs only`.
fn packs_line(p: &ResolvedPolicy, size: Option<u64>) -> String {
    let head = format!(
        "packs → {} ({} of {} must confirm)",
        p.target_names().join(", "),
        p.replicas,
        p.total()
    );
    if p.platform {
        format!(
            "{head}; Platform stores the packs at {}",
            platform_price(size)
        )
    } else {
        format!("{head}; Platform: manifest + refs only")
    }
}

/// E508: no storage, stopped before anything was written.
fn no_storage(size: Option<u64>) -> anyhow::Error {
    UserError::new(codes::NO_STORAGE, "repository not created: no storage configured")
        .cause(format!(
            "No storage profile. Packs would go to Platform at {}",
            platform_price(size)
        ))
        .fix("run `dg storage add` first (in a terminal it asks for each value), or pass `--storage platform` to accept that price")
        .fix("`git config --global dash.storage <profile>` makes a profile the default for new repos")
        .note("nothing was written")
        .into()
}

/// Decide the storage (see the module docs). `size`: the repository's size, for prices.
async fn choose_storage(ctx: &Ctx, opts: &CreateOptions, size: Option<u64>) -> Result<Storage> {
    let mut profiles = StorageProfiles::load()?;
    let replicas = opts.replicas.map(|r| r.to_string());
    let resolve = |profiles: &StorageProfiles,
                   spec: &str,
                   replicas: Option<&str>,
                   fallback: Option<&str>,
                   source: Source|
     -> Result<Storage> {
        let policy =
            StoragePolicy::from_git_values(Some(spec), replicas, fallback)?.resolve(profiles)?;
        Ok(Storage { policy, source })
    };
    if let Some(spec) = &opts.storage {
        return resolve(&profiles, spec, replicas.as_deref(), None, Source::Flag);
    }
    let get = |k: &str| git_config_scoped(k).map(|(_, v)| v);
    if let Some(spec) = get("dash.storage") {
        let replicas = replicas.or_else(|| get("dash.replicas"));
        let fallback = get("dash.platformFallback");
        return resolve(
            &profiles,
            &spec,
            replicas.as_deref(),
            fallback.as_deref(),
            Source::GitConfig,
        );
    }
    let external: Vec<String> = profiles
        .profiles
        .iter()
        .filter(|(_, p)| !p.is_platform())
        .map(|(n, _)| n.clone())
        .collect();
    if let [only] = external.as_slice() {
        return resolve(
            &profiles,
            only,
            replicas.as_deref(),
            None,
            Source::OnlyProfile,
        );
    }
    if !ctx.interactive() {
        return Err(no_storage(size));
    }
    // The picker: the user's profiles, setting one up now, or Platform with its price.
    let platform = format!("platform — on-chain, {}", platform_price(size));
    let mut options: Vec<&str> = external.iter().map(String::as_str).collect();
    let add_now = options.len();
    options.push("set up new storage now (dg storage add)");
    options.push(&platform);
    let mut p = crate::prompt::TtyPrompter;
    let pick = crate::prompt::Prompter::choose(
        &mut p,
        "No storage configured for this repo. Where should pushes store packs?",
        &options,
        0,
    )?;
    let spec = match pick.cmp(&add_now) {
        std::cmp::Ordering::Less => external[pick].clone(),
        std::cmp::Ordering::Equal => {
            let name = crate::storage_wizard::run(&mut p).await?;
            profiles = StorageProfiles::load()?;
            name
        }
        std::cmp::Ordering::Greater => forge_core::storage::PLATFORM_PROFILE.to_string(),
    };
    resolve(&profiles, &spec, replicas.as_deref(), None, Source::Prompt)
}

/// E206.
fn git_repo_error(message: impl Into<String>, cause: impl Into<String>) -> UserError {
    UserError::new(codes::GIT_REPO, message).cause(cause)
}

/// The remote's current URL, if the remote exists.
fn remote_url(root: &Path, remote: &str) -> Option<String> {
    git(
        root,
        &["config", "--get", &format!("remote.{remote}.url")],
        &[],
    )
    .ok()
    .filter(|u| !u.is_empty())
}

/// Everything decided before the prompt: nothing here spends or writes.
struct Plan {
    slug: String,
    owner: String,
    storage: Storage,
    /// The local repository, when the flow pushes.
    local: Option<Local>,
    size: Option<u64>,
    default_branch: String,
}

/// Check everything that can refuse, before the prompt and before any spend.
async fn plan(ctx: &Ctx, name: Option<&str>, opts: &CreateOptions, flow: Flow) -> Result<Plan> {
    if ctx.target.v2.is_none() {
        return Err(forge_core::Error::V2NotDeployed {
            network: ctx.network_label(),
        }
        .into());
    }
    let local = Local::discover();
    if flow.pushes() && local.is_none() {
        return Err(git_repo_error(
            "not published: this is not a git repository",
            "`dg init` and `dg repo create --push` push the git repository in the current directory",
        )
        .fix("run `git init` (and commit something), or `cd` into the repository")
        .note("nothing was written")
        .into());
    }
    let dir_name = local
        .as_ref()
        .map(|l| l.root.clone())
        .or_else(|| std::env::current_dir().ok())
        .and_then(|d| d.file_name().map(|n| n.to_string_lossy().into_owned()));
    let slug = match name {
        Some(n) => repo_slug(n)?,
        None => dir_name.as_deref().and_then(default_name).ok_or_else(|| {
            crate::errors::usage("cannot derive a repository name from this directory; pass one")
        })?,
    };
    let size = local.as_ref().and_then(Local::size_bytes);
    let local = local.filter(|_| flow.pushes());
    let default_branch = opts
        .default_branch
        .clone()
        .or_else(|| local.as_ref().and_then(|l| l.branch.clone()))
        .unwrap_or_else(|| "main".into());
    let storage = choose_storage(ctx, opts, size).await?;
    let owner = ctx.load_bridge()?.identity_id;
    if let Some(l) = &local {
        check_local(l, &opts.remote, &format!("dash://{owner}/{slug}"))?;
    }
    Ok(Plan {
        slug,
        owner,
        storage,
        local,
        size,
        default_branch,
    })
}

/// Refuse a push the local repository cannot take: a bad remote name, a remote that points
/// elsewhere, or a detached HEAD.
fn check_local(l: &Local, remote: &str, want: &str) -> Result<()> {
    if !git_ok(
        &l.root,
        &["check-ref-format", &format!("refs/remotes/{remote}/x")],
    ) {
        return Err(crate::errors::usage(format!(
            "{remote:?} is not a valid git remote name"
        )));
    }
    if let Some(have) = remote_url(&l.root, remote) {
        if have != want {
            return Err(git_repo_error(
                format!("not published: remote '{remote}' is already in use"),
                format!("it points at {have}, not {want}"),
            )
            .fix("pass `--remote <name>` to add the Forge remote under another name (e.g. `--remote forge`)")
            .note("nothing was written")
            .into());
        }
    }
    if l.has_commits && l.branch.is_none() {
        return Err(git_repo_error(
            "not published: HEAD is detached",
            "a push needs a branch to push and track",
        )
        .fix("`git switch -c main` (or check out a branch), then run the command again")
        .note("nothing was written")
        .into());
    }
    Ok(())
}

/// Print the plan (§1c), ask `Proceed? [Y/n]`, and print the flags a prompted storage choice
/// maps to.
fn confirm_plan(ctx: &Ctx, plan: &Plan, flow: Flow, price: f64) -> Result<()> {
    if !ctx.json {
        println!(
            "Creating {}/{} on {}",
            plan.owner,
            plan.slug,
            ctx.network_label()
        );
        println!(
            "  repo + maintainer + config     {}",
            cost_line(REPO_CREATE_ESTIMATE_CREDITS, price)
        );
        println!("  {}", packs_line(&plan.storage.policy, plan.size));
        if plan.storage.source != Source::Flag {
            println!("  (storage: {})", plan.storage.source.label());
        }
    }
    ctx.proceed("Proceed?")?;
    if plan.storage.source == Source::Prompt && !ctx.json {
        println!(
            "Equivalent: {}",
            flow.equivalent(&plan.slug, &plan.storage.names())
        );
    }
    Ok(())
}

async fn publish(ctx: &Ctx, name: Option<&str>, opts: &CreateOptions, flow: Flow) -> Result<()> {
    let plan = plan(ctx, name, opts, flow).await?;
    let price = dash_usd_price();
    confirm_plan(ctx, &plan, flow, price)?;

    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let create_opts = CreateRepoOpts {
        display_name: opts.display_name.clone(),
        description: opts.description.clone(),
        default_branch: plan.default_branch.clone(),
        backend_mode: plan.storage.policy.advertised_mode(),
        backend_uris: plan.storage.uris(),
        ..CreateRepoOpts::public(plan.slug.clone())
    };
    let result = create_repo(
        &client,
        &identity,
        &bridge,
        &create_opts,
        &default_journal_dir()?,
    )
    .await
    .context("creating the repository")?;
    let repo = &result.repo;
    let url = web_url(repo.owner_id(), repo.name());
    let steps: serde_json::Map<_, _> = result
        .steps
        .iter()
        .map(|(name, o)| ((*name).to_string(), json!(o)))
        .collect();
    let body = json!({
        "status": if result.already_existed() { "exists" } else { "created" },
        "generation": "v2",
        "repoId": repo.id(),
        "ownerId": repo.owner_id(),
        "name": repo.name(),
        "remoteUrl": repo.remote_url(),
        "webUrl": url,
        "storage": plan.storage.json(),
        "network": ctx.network_label(),
        "steps": steps,
        "cost": cost_json(result.cost_credits, price),
        "push": Value::Null,
    });
    if !ctx.json {
        if result.already_existed() {
            println!("✓ exists   {url}  (nothing written)");
        } else {
            println!("✓ created  {url}");
        }
        for (name, o) in &result.steps {
            if *o == StepOutcome::Resumed {
                println!("  {name}: finished an interrupted create (not paid twice)");
            }
        }
    }

    let Some(local) = &plan.local else {
        ctx.emit(body, || {
            println!("  repo id:  {}", repo.id());
            println!("  remote:   {}", repo.remote_url());
            println!("  cost:     {}", cost_line(result.cost_credits, price));
            println!(
                "  next:     dg init --name {} --storage {}   (adds the remote, sets dash.storage, pushes)",
                repo.name(),
                plan.storage.names()
            );
        });
        return Ok(());
    };
    let (mut body, push_cost, balance) =
        wire_and_push(ctx, &client, &plan, local, &repo.remote_url(), opts, body).await?;
    body["totalCost"] = cost_json(result.cost_credits + push_cost.unwrap_or(0), price);
    ctx.emit(body, || {
        if let Some(push_cost) = push_cost {
            let balance = balance
                .map(|b| format!(" · balance {} DASH", dash(b)))
                .unwrap_or_default();
            println!(
                "  total {} (create {} + push {}){balance}",
                cost_line(result.cost_credits + push_cost, price),
                cost_line(result.cost_credits, price),
                cost_line(push_cost, price),
            );
        } else {
            println!("  cost:     {}", cost_line(result.cost_credits, price));
        }
        println!("Open it: {url}");
    });
    Ok(())
}

/// Add the remote, write the local git config, and push the current branch (when it has
/// commits). Returns `body` with the push fields, the push's measured cost (`None`: nothing
/// was pushed) and the balance after it.
async fn wire_and_push(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    plan: &Plan,
    local: &Local,
    dash_url: &str,
    opts: &CreateOptions,
    mut body: Value,
) -> Result<(Value, Option<u64>, Option<u64>)> {
    let remote = &opts.remote;
    if remote_url(&local.root, remote).is_none() {
        git(&local.root, &["remote", "add", remote, dash_url], &[])?;
    }
    let configured = configure_local(ctx, &local.root, &plan.storage, opts.replicas)?;
    if !ctx.json {
        println!("✓ remote '{remote}' → {dash_url}");
        println!("✓ git config {}", configured.join(", "));
    }
    body["remote"] = json!(remote);
    body["gitConfig"] = json!(configured);

    let Some(branch) = local.branch.as_ref().filter(|_| local.has_commits) else {
        if !ctx.json {
            println!("Nothing to push yet: this repository has no commits.");
            println!(
                "  Commit something, then: git push -u {remote} {}",
                local.branch.as_deref().unwrap_or("<branch>")
            );
        }
        return Ok((body, None, None));
    };
    let before = client.get_balance(&plan.owner).await.ok();
    let outcome = run_push(ctx, &local.root, remote, branch)?;
    let after = client.get_balance(&plan.owner).await.ok();
    // The balance change; the helper's own report when the balance has not moved yet.
    let measured = before.zip(after).map(|(b, a)| b.saturating_sub(a));
    let push_cost = measured.filter(|c| *c > 0).or(outcome.charged).unwrap_or(0);
    let oid = git(&local.root, &["rev-parse", "HEAD"], &[]).unwrap_or_default();
    let price = dash_usd_price();
    body["push"] = json!({
        "remote": remote,
        "branch": branch,
        "oid": oid,
        "cost": cost_json(push_cost, price),
    });
    body["balanceCredits"] = json!(after);
    if !ctx.json {
        println!(
            "✓ {branch} → {}   this push {}",
            oid.get(..7).unwrap_or(&oid),
            cost_line(push_cost, price)
        );
    }
    Ok((body, Some(push_cost), after))
}

/// Write the repo-local git config a later plain `git push` needs; returns what was set.
fn configure_local(
    ctx: &Ctx,
    root: &Path,
    storage: &Storage,
    replicas: Option<usize>,
) -> Result<Vec<String>> {
    let set = |k: &str, v: &str| git(root, &["config", k, v], &[]).map(drop);
    let mut out = Vec::new();
    let names = storage.names();
    set("dash.storage", &names)?;
    out.push(format!("dash.storage={names}"));
    match replicas {
        Some(r) => {
            set("dash.replicas", &r.to_string())?;
            out.push(format!("dash.replicas={r}"));
        }
        // A stale local count could exceed the new target list.
        None => {
            let _ = git(root, &["config", "--unset", "dash.replicas"], &[]);
        }
    }
    // Whether the helper would pick dg's network from env + git config; pin it when not.
    let want = ctx.network();
    let helper_agrees = || {
        NetworkSettings::from_env()
            .overlay(NetworkSettings::from_git_config(|k| {
                git_config_scoped(k).map(|(_, v)| v)
            }))
            .resolve()
            .is_ok_and(|t| t.network == *want)
    };
    if !helper_agrees() {
        set("dash.network", want.kind())?;
        out.push(format!("dash.network={}", want.kind()));
        if let Some(name) = want.devnet_name() {
            set("dash.devnetName", name)?;
            out.push(format!("dash.devnetName={name}"));
        }
        if !helper_agrees() {
            if let forge_core::platform::Network::Devnet { dapi_addresses, .. } = want {
                let list = dapi_addresses.join(",");
                set("dash.dapiAddresses", &list)?;
                out.push("dash.dapiAddresses".into());
            }
        }
        if !helper_agrees() {
            tracing::warn!(
                "git push may still resolve another network: DASH_FORGE_NETWORK and friends in the environment override git config"
            );
        }
    }
    Ok(out)
}

/// What the helper reported during the push.
struct PushOutcome {
    /// The helper's `done` event charge (JSON mode), in credits.
    charged: Option<u64>,
}

/// The catalogue code in a helper error line (`… [E502]`).
fn error_code_in(line: &str) -> Option<&'static str> {
    let at = line.rfind("[E")?;
    let code = line.get(at + 1..at + 5)?;
    if line.get(at + 5..at + 6) != Some("]") {
        return None;
    }
    CATALOGUE.iter().find(|(c, _)| *c == code).map(|(c, _)| *c)
}

/// `git push -u <remote> <branch>` with this `dg`'s identity and network. The helper's
/// stderr is passed through (human mode) and scanned for its error code; `--json` asks the
/// helper for JSON events and keeps git's output off stdout.
fn run_push(ctx: &Ctx, root: &Path, remote: &str, branch: &str) -> Result<PushOutcome> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root);
    if ctx.yes {
        cmd.args(["-c", "dash.confirm=never"]);
    }
    cmd.args(["push", "-u", remote, branch])
        .envs(dash_env(ctx))
        .stdin(Stdio::inherit())
        .stderr(Stdio::piped());
    if ctx.json {
        cmd.env("GIT_DASH_JSON", "1").stdout(Stdio::null());
    } else {
        cmd.stdout(Stdio::inherit());
    }
    let mut child = cmd.spawn().context("running git push")?;
    let mut code = None;
    let mut last_error = None;
    let mut charged = None;
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if !ctx.json {
                eprintln!("{line}");
            }
            if let Ok(ev) = serde_json::from_str::<Value>(&line) {
                if ev["event"] == "done" {
                    charged = ev["chargedCredits"].as_u64();
                }
                continue;
            }
            if let Some(c) = error_code_in(&line) {
                code = Some(c);
                last_error = Some(
                    line.trim_start_matches("dash: ")
                        .trim_start_matches("error: ")
                        .trim()
                        .to_string(),
                );
            }
        }
    }
    let status = child.wait().context("waiting for git push")?;
    if status.success() {
        return Ok(PushOutcome { charged });
    }
    Err(UserError::new(
        code.unwrap_or(codes::UNEXPECTED),
        format!("repository created, but the push of {branch} failed"),
    )
    .cause(last_error.unwrap_or_else(|| format!("git push exited with {status}")))
    .fix(format!(
        "fix what the push reported, then `git push -u {remote} {branch}` (or run `dg init` again)"
    ))
    .note(format!(
        "the repository exists and remote '{remote}' is set; nothing else needs redoing"
    ))
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_names_become_repo_slugs() {
        assert_eq!(default_name("my-project").as_deref(), Some("my-project"));
        assert_eq!(default_name("My Project!").as_deref(), Some("my-project"));
        assert_eq!(default_name(".dotfiles").as_deref(), Some("dotfiles"));
        assert_eq!(default_name("__x__").as_deref(), Some("x"));
        assert_eq!(default_name("Ünïcode repo").as_deref(), Some("n-code-repo"));
        assert_eq!(default_name("---").as_deref(), None);
        let long = "a".repeat(80);
        assert_eq!(default_name(&long).unwrap().len(), 63);
        for n in ["My Project!", ".dotfiles", "a.b_c-d"] {
            let slug = default_name(n).unwrap();
            assert_eq!(repo_slug(&slug).unwrap(), slug, "{n}");
        }
    }

    #[test]
    fn count_objects_sums_loose_and_packed_kib() {
        let out = "count: 3\nsize: 12\nin-pack: 300\npacks: 1\nsize-pack: 1200\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n";
        assert_eq!(count_objects_bytes(out), 1212 * 1024);
        assert_eq!(count_objects_bytes(""), 0);
    }

    #[test]
    fn the_no_storage_error_prices_platform_storage() {
        let e = no_storage(Some(1_258_291)); // 1.2 MiB
        let u = forge_core::user_error::classify(
            e.chain(),
            &forge_core::user_error::ErrorContext::default(),
        );
        assert_eq!((u.code, u.exit_code()), ("E508", 5));
        let cause = u.cause.unwrap();
        assert!(
            cause.starts_with(
                "No storage profile. Packs would go to Platform at ~0.28 DASH/MiB (1.2 MiB ≈ 0.3"
            ),
            "{cause}"
        );
        assert!(u.fix[0].contains("dg storage add") && u.fix[0].contains("--storage platform"));
        assert_eq!(u.note.as_deref(), Some("nothing was written"));
        // Without a size, just the rate.
        assert_eq!(platform_price(None), "~0.28 DASH/MiB");
        assert_eq!(platform_price(Some(0)), "~0.28 DASH/MiB");
    }

    #[test]
    fn plan_lines_say_what_platform_stores() {
        let profiles = StorageProfiles::parse(
            "[profiles.r2-main]\nkind = \"s3\"\nendpoint = \"https://a.r2.cloudflarestorage.com\"\nbucket = \"b\"\npublic_url = \"https://pub.r2.dev\"\n",
        )
        .unwrap();
        let r = StoragePolicy::from_git_values(Some("r2-main"), None, None)
            .unwrap()
            .resolve(&profiles)
            .unwrap();
        assert_eq!(
            packs_line(&r, None),
            "packs → r2-main (1 of 1 must confirm); Platform: manifest + refs only"
        );
        let s = Storage {
            policy: r,
            source: Source::Flag,
        };
        assert_eq!(s.uris(), vec!["https://pub.r2.dev".to_string()]);
        assert_eq!(s.json()["mode"], 2);
        let r = StoragePolicy::from_git_values(Some("platform"), None, None)
            .unwrap()
            .resolve(&profiles)
            .unwrap();
        let line = packs_line(&r, Some(2 * 1024 * 1024));
        assert!(
            line.contains("Platform stores the packs at ~0.28 DASH/MiB (2.0 MiB ≈ 0.5"),
            "{line}"
        );
    }

    #[test]
    fn helper_error_codes_are_recognized() {
        assert_eq!(
            error_code_in("dash: error: push failed: storage policy not met      [E502]"),
            Some("E502")
        );
        assert_eq!(error_code_in("dash: [E999] nope"), None);
        assert_eq!(error_code_in("plain line"), None);
    }

    #[test]
    fn the_equivalent_of_a_prompted_choice_parses() {
        use clap::Parser as _;
        for flow in [Flow::Create, Flow::CreatePush, Flow::Init] {
            let line = flow.equivalent("proj", "r2,platform");
            let cli = crate::Cli::try_parse_from(line.split(' ')).unwrap();
            let (name, opts, pushes) = match cli.command {
                crate::Command::Repo(crate::RepoCommand::Create(a)) => (a.name, a.opts, a.push),
                crate::Command::Init(a) => (a.name, a.opts, true),
                other => panic!("{other:?}"),
            };
            assert_eq!(name.as_deref(), Some("proj"), "{line}");
            assert_eq!(opts.storage.as_deref(), Some("r2,platform"), "{line}");
            assert_eq!(pushes, flow.pushes(), "{line}");
        }
    }
}
