//! `dg repo create [--push]` and `dg init` (UX spec §1c, §7.2): create a forge-v2 repository
//! whose on-chain config advertises where its packs live, and — with `--push` / `init` —
//! wire the git repository in the current directory to it and push.
//!
//! Everything that can refuse runs **before anything is spent** ([`plan`]): the identity,
//! the local repository and its remote, then the storage — `--storage` > git config
//! `dash.storage` (this repo's, then the global one) > the user's only storage profile > a
//! picker (in a terminal) > stop with E508, pricing what Platform storage would cost — and,
//! for a push, that every storage secret resolves.
//!
//! With `--push`, after the create: the remote (`origin` unless `--remote`) is added or
//! checked, the repo-local git config gets `dash.storage` + `dash.replicas`, and — when the
//! helper would otherwise resolve another network — `dash.network` and friends, so a later
//! plain `git push` goes where this one did. Then `git push` with the identity and network
//! this `dg` resolved (`-u` unless the branch already tracks another remote). Everything is
//! safe to re-run: the create is resumable and returns the existing repository, an equal
//! remote is left alone, and a push of an up-to-date branch writes nothing.

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
use forge_core::user_error::{codes, dash, web_url, UserError};

use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, dash_usd_price, REPO_CREATE_ESTIMATE_CREDITS};
use crate::git::{current_branch, dash_env, git, git_ok};
use crate::storage_wizard::shell_word;
use crate::{CreateOptions, InitArgs, RepoCreateArgs};

/// `dg repo create`.
pub async fn create(ctx: &Ctx, args: &RepoCreateArgs) -> Result<()> {
    if !args.push && args.opts.remote.is_some() {
        return Err(crate::errors::usage(
            "--remote only applies with --push (or `dg init`), which add the remote",
        ));
    }
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

/// Which command is running.
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

    /// The whole command line that repeats this run without prompts.
    fn equivalent(self, name: &str, storage: &str, opts: &CreateOptions) -> String {
        let mut words: Vec<String> = match self {
            Flow::Create => vec![
                "dg".into(),
                "repo".into(),
                "create".into(),
                shell_word(name),
            ],
            Flow::CreatePush => vec![
                "dg".into(),
                "repo".into(),
                "create".into(),
                shell_word(name),
                "--push".into(),
            ],
            Flow::Init => vec![
                "dg".into(),
                "init".into(),
                "--name".into(),
                shell_word(name),
            ],
        };
        let mut flag = |f: &str, v: Option<&str>| {
            if let Some(v) = v.filter(|v| !v.is_empty()) {
                words.push(format!("--{f}"));
                words.push(shell_word(v));
            }
        };
        let replicas = opts.replicas.map(|r| r.to_string());
        flag("storage", Some(storage));
        flag("replicas", replicas.as_deref());
        flag("description", Some(&opts.description));
        flag("display-name", Some(&opts.display_name));
        flag("default-branch", opts.default_branch.as_deref());
        flag("remote", opts.remote.as_deref());
        if opts.allow_private_uri {
            words.push("--allow-private-uri".into());
        }
        words.join(" ")
    }
}

/// The git repository a push goes from.
struct Local {
    /// The work tree root.
    root: PathBuf,
    /// The current branch (`None`: detached HEAD).
    branch: Option<String>,
    /// Whether the current branch has a commit (false on an unborn branch).
    has_commits: bool,
}

impl Local {
    /// The git work tree containing the current directory, if any.
    fn discover() -> Option<Self> {
        let cwd = std::env::current_dir().ok()?;
        let root = PathBuf::from(git(&cwd, &["rev-parse", "--show-toplevel"], &[]).ok()?);
        let branch = current_branch(&root);
        let has_commits = match &branch {
            Some(b) => git_ok(
                &root,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{b}"),
                ],
            ),
            None => git_ok(
                &root,
                &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            ),
        };
        Some(Self {
            root,
            branch,
            has_commits,
        })
    }

    /// The repository's size on disk (loose objects + packs), from `git count-objects -v`.
    fn size_bytes(&self) -> Option<u64> {
        git(&self.root, &["count-objects", "-v"], &[])
            .ok()
            .map(|out| count_objects_bytes(&out))
    }

    /// Whether any history exists (any ref at all), for the unborn-branch message.
    fn has_history(&self) -> bool {
        git(
            &self.root,
            &["for-each-ref", "--count=1", "--format=x"],
            &[],
        )
        .is_ok_and(|o| !o.is_empty())
    }

    /// Whether `remote` is configured (with or without a URL).
    fn remote_exists(&self, remote: &str) -> bool {
        git(&self.root, &["remote"], &[]).is_ok_and(|out| out.lines().any(|l| l.trim() == remote))
    }

    /// The remote's fetch and push URLs as git resolves them (`git remote get-url --all`,
    /// then `--push --all`): a push goes to the push URL, a clone reads the fetch URL.
    fn remote_urls(&self, remote: &str) -> Vec<String> {
        let mut urls = Vec::new();
        for args in [
            &["remote", "get-url", "--all", remote][..],
            &["remote", "get-url", "--push", "--all", remote][..],
        ] {
            for u in git(&self.root, args, &[]).unwrap_or_default().lines() {
                if !urls.iter().any(|x| x == u) {
                    urls.push(u.to_string());
                }
            }
        }
        urls
    }

    /// The branch's upstream remote, if it tracks one.
    fn upstream_remote(&self, branch: &str) -> Option<String> {
        git(
            &self.root,
            &["config", "--get", &format!("branch.{branch}.remote")],
            &[],
        )
        .ok()
        .filter(|r| !r.is_empty())
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

/// A `dash://` URL's `(owner, name)`, ignoring a trailing `/` or `.git`; `name` is `None` for
/// the id form (`dash://<repoId>`).
pub(crate) fn parse_dash_url(url: &str) -> Option<(String, Option<String>)> {
    let rest = url.strip_prefix("dash://")?.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    match rest.split_once('/') {
        Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
            Some((owner.to_string(), Some(name.to_ascii_lowercase())))
        }
        None if !rest.is_empty() => Some((rest.to_string(), None)),
        _ => None,
    }
}

/// Where the storage choice came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Flag,
    GitConfig,
    OnlyProfile,
    Prompt,
}

impl Source {
    /// Human wording, for the plan.
    fn label(self) -> &'static str {
        match self {
            Source::Flag => "--storage",
            Source::GitConfig => "git config dash.storage",
            Source::OnlyProfile => "your only storage profile",
            Source::Prompt => "chosen at the prompt",
        }
    }

    /// Stable `--json` value.
    fn key(self) -> &'static str {
        match self {
            Source::Flag => "flag",
            Source::GitConfig => "gitConfig",
            Source::OnlyProfile => "onlyProfile",
            Source::Prompt => "prompt",
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
        let max_len = BACKEND_URIS_V2.max_item_len;
        let mut uris: Vec<String> = self
            .policy
            .advertised_uris()
            .into_iter()
            .filter(|u| u.len() <= max_len)
            .collect();
        uris.truncate(BACKEND_URIS_V2.max_items);
        uris
    }

    fn json(&self) -> Value {
        json!({
            "profiles": self.policy.target_names(),
            "replicas": self.policy.replicas,
            "source": self.source.key(),
            "mode": self.policy.advertised_mode(),
            "uris": self.uris(),
        })
    }

    /// Fail unless every secret the external targets name resolves now (a push that
    /// cannot sign would fail after the create was paid for).
    fn require_secrets(&self) -> Result<()> {
        for (name, profile) in &self.policy.external {
            for (field, r) in profile.secret_refs() {
                if let Err(e) = r.resolve() {
                    return Err(UserError::new(
                        codes::STORAGE_SECRET,
                        "repository not created: storage credentials are not available",
                    )
                    .cause(format!("profile {name}: {field}: {e}"))
                    .fix("export the variable (or add the keychain entry) in this shell, then run the command again")
                    .fix("`dg storage list` shows which references resolve")
                    .note("nothing was written")
                    .into());
                }
            }
        }
        Ok(())
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
            let added = crate::storage_wizard::run(&mut p).await?;
            // Storage that just failed its checks would fail the push after the create.
            if added.broken
                && !crate::prompt::Prompter::confirm(
                    &mut p,
                    &format!(
                        "{} failed its checks. Create the repository with it anyway?",
                        added.name
                    ),
                    false,
                )
                .unwrap_or(false)
            {
                return Err(UserError::new(
                    codes::STORAGE_TEST,
                    "repository not created: the new storage failed its checks",
                )
                .fix(format!(
                    "fix what the failing rows name, run `dg storage test {}`, then run this command again",
                    added.name
                ))
                .note("the profile is saved; nothing was written to Platform")
                .into());
            }
            profiles = StorageProfiles::load()?;
            added.name
        }
        std::cmp::Ordering::Greater => forge_core::storage::PLATFORM_PROFILE.to_string(),
    };
    resolve(&profiles, &spec, replicas.as_deref(), None, Source::Prompt)
}

/// E206.
fn git_repo_error(message: impl Into<String>, cause: impl Into<String>) -> UserError {
    UserError::new(codes::GIT_REPO, message).cause(cause)
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

/// The repo name: `--name`, else (pushing) the name in an existing `dash://` remote of this
/// identity, else the directory's name.
fn repo_name(
    name: Option<&str>,
    local: Option<&Local>,
    remote: &str,
    owner: &str,
) -> Result<String> {
    if let Some(n) = name {
        return Ok(repo_slug(n)?);
    }
    if let Some(l) = local {
        let from_remote = l
            .remote_urls(remote)
            .iter()
            .find_map(|u| match parse_dash_url(u) {
                Some((o, Some(n))) if o == owner => Some(n),
                _ => None,
            });
        if let Some(n) = from_remote {
            return Ok(repo_slug(&n)?);
        }
    }
    // Pushing: the repository's directory. Otherwise: this directory.
    let dir = match local {
        Some(l) => Some(l.root.clone()),
        None => std::env::current_dir().ok(),
    };
    dir.as_deref()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .as_deref()
        .and_then(default_name)
        .ok_or_else(|| {
            crate::errors::usage("cannot derive a repository name from this directory; pass one")
        })
}

/// Check everything that can refuse, before the prompt and before any spend. The cheap,
/// storage-independent checks run first, so the interactive storage setup is never reached
/// when the command would fail anyway.
async fn plan(ctx: &Ctx, name: Option<&str>, opts: &CreateOptions, flow: Flow) -> Result<Plan> {
    if ctx.target.v2.is_none() {
        return Err(forge_core::Error::V2NotDeployed {
            network: ctx.network_label(),
        }
        .into());
    }
    let owner = ctx.load_bridge()?.identity_id;
    let local = if flow.pushes() {
        Some(Local::discover().ok_or_else(|| {
            anyhow::Error::from(
                git_repo_error(
                    "not published: this is not a git repository",
                    "`dg init` and `dg repo create --push` push the git repository in the current directory",
                )
                .fix("run `git init` (and commit something), or `cd` into the repository")
                .note("nothing was written"),
            )
        })?)
    } else {
        None
    };
    let slug = repo_name(name, local.as_ref(), opts.remote(), &owner)?;
    if let Some(l) = &local {
        if let Some(url) = check_local(l, opts.remote(), &owner, &slug)? {
            // `dash://<repoId>`: it fits only if that id is this repository (a free read).
            let id = url.trim_start_matches("dash://").trim_end_matches('/');
            let id = id.strip_suffix(".git").unwrap_or(id);
            let client = ctx.connect().await?;
            let same = forge_core::resolve::resolve_id(&client, id)
                .await
                .is_ok_and(|r| r.owner_id() == owner && r.name() == slug);
            if !same {
                return Err(remote_in_use(opts.remote(), &[url], &owner, &slug));
            }
        }
    }
    // Priced by the repository being pushed; a plain create has nothing to price.
    let size = local.as_ref().and_then(Local::size_bytes);
    let default_branch = opts
        .default_branch
        .clone()
        .or_else(|| local.as_ref().and_then(|l| l.branch.clone()))
        .unwrap_or_else(|| "main".into());
    let storage = choose_storage(ctx, opts, size).await?;
    // The new repo's config advertises these read bases, and its pushes record them.
    crate::storage::check_publishable(
        storage.policy.external.iter().map(|(n, p)| (n.as_str(), p)),
        Some((crate::storage::ALLOW_FLAG, opts.allow_private_uri)),
        Some(opts.remote()),
        "repository not created",
    )?;
    if local.is_some() {
        storage.require_secrets()?;
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

/// Whether `url` names the repository `owner/slug` (`.git` and a trailing `/` ignored).
fn same_repo(url: &str, owner: &str, slug: &str) -> bool {
    matches!(parse_dash_url(url), Some((o, Some(n))) if o == owner && n == slug)
}

/// Refuse a push the local repository cannot take: a bad remote name, a remote that points
/// elsewhere, or a detached HEAD. Returns a `dash://<repoId>` remote URL that can only be
/// compared once resolved.
fn check_local(l: &Local, remote: &str, owner: &str, slug: &str) -> Result<Option<String>> {
    if remote.starts_with('-')
        || !git_ok(
            &l.root,
            &["check-ref-format", &format!("refs/remotes/{remote}/x")],
        )
    {
        return Err(crate::errors::usage(format!(
            "{remote:?} is not a valid git remote name"
        )));
    }
    let mut by_id = None;
    if l.remote_exists(remote) {
        let urls = l.remote_urls(remote);
        let fits = |u: &String| match parse_dash_url(u) {
            Some((_, None)) => {
                by_id = Some(u.clone());
                true
            }
            _ => same_repo(u, owner, slug),
        };
        if urls.is_empty() || !urls.iter().all(fits) {
            return Err(remote_in_use(remote, &urls, owner, slug));
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
    Ok(by_id)
}

/// E206: the remote exists and names another repository (or none).
fn remote_in_use(remote: &str, urls: &[String], owner: &str, slug: &str) -> anyhow::Error {
    let have = if urls.is_empty() {
        "no URL".to_string()
    } else {
        urls.join(", ")
    };
    git_repo_error(
        format!("not published: remote '{remote}' is already in use"),
        format!("it points at {have}, not dash://{owner}/{slug}"),
    )
    .fix(
        "pass `--remote <name>` to add the Forge remote under another name (e.g. `--remote forge`)",
    )
    .note("nothing was written")
    .into()
}

/// Print the plan (§1c), ask `Proceed? [Y/n]`, and print the flags a prompted storage choice
/// maps to.
fn confirm_plan(
    ctx: &Ctx,
    plan: &Plan,
    flow: Flow,
    opts: &CreateOptions,
    price: f64,
) -> Result<()> {
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
            flow.equivalent(&plan.slug, &plan.storage.names(), opts)
        );
    }
    Ok(())
}

async fn publish(ctx: &Ctx, name: Option<&str>, opts: &CreateOptions, flow: Flow) -> Result<()> {
    let plan = plan(ctx, name, opts, flow).await?;
    let price = dash_usd_price();
    confirm_plan(ctx, &plan, flow, opts, price)?;

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
        print_created(&result, &url);
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
    // After the create, a failure keeps what was made: the error carries the repository.
    // `body` gains the remote / git config fields as they are done, so a failure after
    // them still reports what changed locally.
    let mut body = body;
    let (push_cost, balance) = match wire_and_push(
        ctx,
        &client,
        &plan,
        local,
        &repo.remote_url(),
        opts,
        &mut body,
    )
    .await
    {
        Ok(done) => done,
        Err(e) => return Err(after_create(&e, repo.id(), &repo.remote_url(), body)),
    };
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

/// `✓ created  <web url>` (or `✓ exists`), and any step an earlier run left unfinished.
fn print_created(result: &forge_core::create::CreateRepoResult, url: &str) {
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

/// A failure after the repository was created: the error names the repository (human mode),
/// and `--json` prints the create's result object with the error merged in.
fn after_create(
    err: &anyhow::Error,
    repo_id: &str,
    remote_url: &str,
    body: Value,
) -> anyhow::Error {
    let mut user = forge_core::user_error::classify(
        err.chain(),
        &forge_core::user_error::ErrorContext {
            goal: Some("repository created, but publishing it failed"),
            ..forge_core::user_error::ErrorContext::default()
        },
    );
    let exists = format!("the repository exists: {remote_url} (id {repo_id})");
    user.note = Some(match user.note.take() {
        Some(n) => format!("{n}; {exists}"),
        None => exists,
    });
    crate::errors::reported(user, body)
}

/// Add the remote, write the local git config, and push the current branch (when it has
/// commits), recording each step in `body`. Returns the push's cost (`None`: nothing was
/// pushed) and the balance after it.
async fn wire_and_push(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    plan: &Plan,
    local: &Local,
    dash_url: &str,
    opts: &CreateOptions,
    body: &mut Value,
) -> Result<(Option<u64>, Option<u64>)> {
    let remote = opts.remote();
    let added = !local.remote_exists(remote);
    if added {
        git(&local.root, &["remote", "add", remote, dash_url], &[])?;
    }
    let configured = configure_local(ctx, &local.root, &plan.storage, opts)?;
    if !ctx.json {
        println!("✓ remote '{remote}' → {dash_url}");
        println!("✓ git config {}", configured.join(", "));
    }
    body["remote"] = json!(remote);
    body["gitConfig"] = json!(configured);

    let Some(branch) = local.branch.as_ref().filter(|_| local.has_commits) else {
        if !ctx.json {
            if local.has_history() {
                println!("Nothing pushed: the current branch has no commits yet.");
            } else {
                println!("Nothing to push yet: this repository has no commits.");
            }
            println!(
                "  Commit something, then: git push -u {remote} {}",
                local.branch.as_deref().unwrap_or("<branch>")
            );
        }
        return Ok((None, None));
    };
    // Track the Forge remote unless the branch already follows another one (an existing
    // GitHub `origin` stays the upstream when the Forge remote is `--remote forge`).
    let track = local.upstream_remote(branch).is_none_or(|r| r == remote);
    let before = client.get_balance(&plan.owner).await.ok();
    let outcome = run_push(
        ctx,
        &local.root,
        remote,
        branch,
        track,
        opts.allow_private_uri,
    )?;
    let after = client.get_balance(&plan.owner).await.ok();
    // The helper's own measurement; the balance change only when it reported none.
    let push_cost = outcome
        .charged
        .or_else(|| before.zip(after).map(|(b, a)| b.saturating_sub(a)))
        .unwrap_or(0);
    let oid = git(&local.root, &["rev-parse", "HEAD"], &[]).unwrap_or_default();
    let price = dash_usd_price();
    body["push"] = json!({
        "remote": remote,
        "branch": branch,
        "oid": oid,
        "tracking": track,
        "cost": cost_json(push_cost, price),
    });
    body["balanceCredits"] = json!(after);
    if !ctx.json {
        println!(
            "✓ {branch} → {}   this push {}",
            oid.get(..7).unwrap_or(&oid),
            cost_line(push_cost, price)
        );
        if !track {
            println!(
                "  {branch} still tracks its existing upstream; `git push {remote} {branch}` pushes here"
            );
        }
    }
    Ok((Some(push_cost), after))
}

/// Write the repo-local git config a later plain `git push` needs; returns what was set.
fn configure_local(
    ctx: &Ctx,
    root: &Path,
    storage: &Storage,
    opts: &CreateOptions,
) -> Result<Vec<String>> {
    let set = |k: &str, v: &str| git(root, &["config", k, v], &[]).map(drop);
    let mut out = Vec::new();
    let names = storage.names();
    set("dash.storage", &names)?;
    out.push(format!("dash.storage={names}"));
    // The count this run resolved (from --replicas or git config). Written only when it is
    // not the default (every target); a new --storage list without --replicas clears a
    // stale local count that could exceed it.
    let replicas = storage.policy.replicas;
    if replicas < storage.policy.total() || opts.replicas.is_some() {
        set("dash.replicas", &replicas.to_string())?;
        out.push(format!("dash.replicas={replicas}"));
    } else if storage.source != Source::GitConfig {
        // Only a git-config source read the local count; any other source replaces the
        // target list, and a stale count could exceed it.
        let _ = git(root, &["config", "--unset", "dash.replicas"], &[]);
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
            if let forge_core::platform::Network::Devnet {
                dapi_addresses,
                quorum_base_url,
                ..
            } = want
            {
                set("dash.dapiAddresses", &dapi_addresses.join(","))?;
                out.push("dash.dapiAddresses".into());
                if let Some(q) = quorum_base_url {
                    set("dash.quorumUrl", q)?;
                    out.push(format!("dash.quorumUrl={q}"));
                }
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

/// What the helper reported about the push.
struct PushOutcome {
    /// The helper's measured (or estimated) Platform charge, in credits.
    charged: Option<u64>,
}

/// The helper's report file: its `done` / `error` events, one JSON object per line.
struct Report(PathBuf);

impl Report {
    fn new() -> Result<(tempfile::TempDir, Self)> {
        let dir = tempfile::tempdir().context("creating a temporary directory")?;
        let path = dir.path().join("report.jsonl");
        Ok((dir, Self(path)))
    }

    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.0)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
}

/// `git push [-u] <remote> refs/heads/<b>:refs/heads/<b>` with this `dg`'s identity and
/// network. The helper reports its charge and any error through a report file, so its
/// stderr goes straight to the terminal (human mode: git and the helper see a tty and show
/// live progress); `--json` keeps git's and the helper's output off stdout entirely.
fn run_push(
    ctx: &Ctx,
    root: &Path,
    remote: &str,
    branch: &str,
    track: bool,
    allow_private_uri: bool,
) -> Result<PushOutcome> {
    let (_dir, report) = Report::new()?;
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut cmd = Command::new("git");
    cmd.current_dir(root);
    if ctx.yes {
        cmd.args(["-c", "dash.confirm=never"]);
    }
    cmd.arg("push");
    if track {
        cmd.arg("-u");
    }
    if allow_private_uri {
        cmd.args([
            "-o",
            forge_core::storage::publish::ALLOW_PRIVATE_URI_PUSH_OPTION,
        ]);
    }
    cmd.args([remote, spec.as_str()])
        .envs(dash_env(ctx))
        .env(REPORT_FILE_ENV, &report.0)
        .stdin(Stdio::inherit());
    if ctx.json {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }
    let status = cmd.status().context("running git push")?;
    let events = report.events();
    let charged = events
        .iter()
        .rev()
        .find(|e| e["event"] == "done")
        .and_then(|e| e["chargedCredits"].as_u64());
    if status.success() {
        return Ok(PushOutcome { charged });
    }
    let helper_error = events.iter().rev().find(|e| e["event"] == "error");
    let rejected = events.iter().rev().find(|e| e["event"] == "rejected");
    let code = helper_error
        .and_then(|e| e["error"]["code"].as_str())
        .and_then(|c| {
            forge_core::user_error::CATALOGUE
                .iter()
                .find(|(k, _)| *k == c)
                .map(|(k, _)| *k)
        })
        .unwrap_or(codes::UNEXPECTED);
    let cause = match helper_error {
        // The helper's own error block is on the terminal just above.
        Some(_) if !ctx.json => "git-remote-dash reported the error above".to_string(),
        Some(e) => {
            let m = e["error"]["message"].as_str().unwrap_or("git push failed");
            match e["error"]["cause"].as_str() {
                Some(c) => format!("{m}: {c}"),
                None => m.to_string(),
            }
        }
        None => match rejected {
            Some(r) => format!(
                "{} was rejected: {}",
                r["ref"].as_str().unwrap_or("the ref"),
                r["reason"].as_str().unwrap_or("refused")
            ),
            None => format!("git push exited with {status}"),
        },
    };
    let upstream = if track { "-u " } else { "" };
    Err(UserError::new(code, format!("the push of {branch} failed"))
        .cause(cause)
        .fix(format!(
            "fix what the push reported, then `git push {upstream}{remote} {branch}` (or run the same command again)"
        ))
        .into())
}

/// The helper's report-file variable (`git-remote-dash`'s `progress::REPORT_FILE_ENV`).
const REPORT_FILE_ENV: &str = "DASH_FORGE_REPORT_FILE";

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
    fn dash_urls_compare_by_owner_and_name() {
        assert!(same_repo("dash://O/proj", "O", "proj"));
        assert!(same_repo("dash://O/proj.git", "O", "proj"));
        assert!(same_repo("dash://O/Proj/", "O", "proj"));
        assert!(!same_repo("dash://O/other", "O", "proj"));
        assert!(!same_repo("dash://P/proj", "O", "proj"));
        assert!(!same_repo("https://github.com/O/proj", "O", "proj"));
        assert_eq!(
            parse_dash_url("dash://REPOID"),
            Some(("REPOID".into(), None))
        );
        assert_eq!(parse_dash_url("dash://"), None);
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
            source: Source::OnlyProfile,
        };
        assert_eq!(s.uris(), vec!["https://pub.r2.dev".to_string()]);
        assert_eq!(s.json()["mode"], 2);
        assert_eq!(s.json()["source"], "onlyProfile");
        assert!(s.require_secrets().is_ok(), "no secrets to resolve");
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
    fn unresolvable_push_secrets_stop_before_the_create() {
        std::env::remove_var("DG_PUBLISH_TEST_UNSET_SECRET");
        let profiles = StorageProfiles::parse(
            "[profiles.m]\nkind = \"s3\"\nendpoint = \"http://127.0.0.1:9\"\nbucket = \"b\"\naccess_key_id = \"AK\"\nsecret_access_key = \"env:DG_PUBLISH_TEST_UNSET_SECRET\"\n",
        )
        .unwrap();
        let policy = StoragePolicy::from_git_values(Some("m"), None, None)
            .unwrap()
            .resolve(&profiles)
            .unwrap();
        let s = Storage {
            policy,
            source: Source::Flag,
        };
        let e = s.require_secrets().unwrap_err();
        let u = forge_core::user_error::classify(
            e.chain(),
            &forge_core::user_error::ErrorContext::default(),
        );
        assert_eq!(u.code, "E505");
        assert_eq!(u.note.as_deref(), Some("nothing was written"));
    }

    #[test]
    fn a_failure_after_the_create_keeps_the_repository_in_the_json() {
        let e = after_create(
            &anyhow::anyhow!("git remote add failed: boom"),
            "RID",
            "dash://O/p",
            json!({ "status": "created", "repoId": "RID" }),
        );
        let r = e.downcast_ref::<crate::errors::Reported>().unwrap();
        assert_eq!(r.body["repoId"], "RID");
        assert!(r
            .error
            .note
            .as_deref()
            .unwrap()
            .contains("dash://O/p (id RID)"));
    }

    #[test]
    fn the_equivalent_of_a_prompted_choice_parses_and_is_complete() {
        use clap::Parser as _;
        let opts = CreateOptions {
            storage: None,
            replicas: Some(1),
            description: "my project".into(),
            display_name: String::new(),
            default_branch: Some("trunk".into()),
            remote: Some("forge".into()),
            allow_private_uri: true,
        };
        for flow in [Flow::Create, Flow::CreatePush, Flow::Init] {
            let line = flow.equivalent("proj", "r2,platform", &opts);
            let words = shlex_split(&line);
            let cli = crate::Cli::try_parse_from(&words).unwrap();
            let (name, got, pushes) = match cli.command {
                crate::Command::Repo(crate::RepoCommand::Create(a)) => (a.name, a.opts, a.push),
                crate::Command::Init(a) => (a.name, a.opts, true),
                other => panic!("{other:?}"),
            };
            assert_eq!(name.as_deref(), Some("proj"), "{line}");
            assert_eq!(got.storage.as_deref(), Some("r2,platform"), "{line}");
            assert_eq!(got.replicas, Some(1), "{line}");
            assert_eq!(got.description, "my project", "{line}");
            assert_eq!(got.default_branch.as_deref(), Some("trunk"), "{line}");
            assert_eq!(got.remote(), "forge", "{line}");
            assert!(got.allow_private_uri, "{line}");
            assert_eq!(pushes, flow.pushes(), "{line}");
        }
    }

    /// Split a command line the way a POSIX shell does for single-quoted words.
    fn shlex_split(line: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        let mut in_word = false;
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\'' => {
                    quoted = !quoted;
                    in_word = true;
                }
                '\\' if !quoted => {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                }
                ' ' if !quoted => {
                    if in_word {
                        out.push(std::mem::take(&mut cur));
                        in_word = false;
                    }
                }
                c => {
                    cur.push(c);
                    in_word = true;
                }
            }
        }
        if in_word {
            out.push(cur);
        }
        out
    }
}
