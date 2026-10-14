//! `dg branch share <b> --to @x`: give someone outside the members one members-only branch as it
//! is now (mixed-visibility DESIGN §4.3 "Branch keys for CI and people", §9 3G;
//! `docs/security/private-repos.md` §20.2).
//!
//! The share is a `branch` key letter (kind 10) to the recipients and the sharer: the branch's
//! head, the blind its push carries with its salt, the keyed name hash of that push, and the file
//! keys of the members-only packs that hold the branch's commits beyond the public branches. The
//! recipient's `git fetch` then lists the branch and opens just those packs, without the members
//! key. It is a snapshot: what is pushed to the branch later is under the members key, which the
//! recipient does not hold, until it is shared again.
//!
//! Which packs: every members-only pack of the repository is opened (members key) and indexed in
//! a scratch repository borrowing this clone's objects, so its own objects and the delta bases it
//! needs from elsewhere are known. Packs are then chosen until they hold every object of
//! `rev-list --objects head ^P` (P: the public tips) and every base they need that P does not
//! reach, preferring at each step the pack that adds the fewest commits not on the branch (a pack
//! another members-only branch pushed shares that branch's commits; the sharer is told).

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{bail, Context as _, Result};
use serde_json::json;
use zeroize::Zeroizing;

use forge_core::private::key_letter::{self, BranchLetter, LetterHead, LetterPack};
use forge_core::private::named::{Recipient, MAX_ARTIFACT_RECIPIENTS};
use forge_core::repo::{ArtifactRead, MembersRefs, PackManifestInfo};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::user_error::{codes, UserError};

use crate::common::Session;
use crate::context::Ctx;
use crate::fmt::safe;
use crate::git;

/// What one members-only pack holds, as indexed here.
#[derive(Debug, Clone, Default)]
pub struct PackContents {
    /// Every object the pack itself carries.
    pub own: BTreeSet<String>,
    /// The commits among them.
    pub commits: BTreeSet<String>,
    /// Delta bases it needs from elsewhere that the public branches do not reach.
    pub bases: BTreeSet<String>,
}

/// The packs to share and how many commits not on the branch they carry along.
#[derive(Debug, PartialEq, Eq)]
pub struct Choice {
    /// Indexes into the candidate list, in the order chosen.
    pub packs: Vec<usize>,
    /// Commits the chosen packs hold that are not on the branch (beyond the public branches).
    pub extra_commits: usize,
}

/// Choose packs among `packs` that hold every object of `needed` (the branch's objects the public
/// branches do not reach) and every base those packs need: at each step the pack with the fewest
/// commits not in `needed_commits` among those adding something still missing, then the one adding
/// the most. `Err`: the objects no pack holds.
pub fn choose_packs(
    needed: &BTreeSet<String>,
    needed_commits: &BTreeSet<String>,
    packs: &[PackContents],
) -> std::result::Result<Choice, Vec<String>> {
    let mut chosen: Vec<usize> = Vec::new();
    let mut held: BTreeSet<&String> = BTreeSet::new();
    let mut required: BTreeSet<&String> = needed.iter().collect();
    loop {
        let missing: BTreeSet<&String> = required.difference(&held).copied().collect();
        if missing.is_empty() {
            break;
        }
        let best = packs
            .iter()
            .enumerate()
            .filter(|(i, _)| !chosen.contains(i))
            .map(|(i, p)| {
                let adds = p.own.iter().filter(|o| missing.contains(o)).count();
                let extra = p.commits.difference(needed_commits).count();
                (i, adds, extra)
            })
            .filter(|(_, adds, _)| *adds > 0)
            .min_by_key(|(i, adds, extra)| (*extra, std::cmp::Reverse(*adds), *i));
        let Some((i, _, _)) = best else {
            return Err(missing.into_iter().cloned().collect());
        };
        chosen.push(i);
        held.extend(packs[i].own.iter());
        required.extend(packs[i].bases.iter());
    }
    let extra: BTreeSet<&String> = chosen
        .iter()
        .flat_map(|i| packs[*i].commits.difference(needed_commits))
        .collect();
    Ok(Choice {
        packs: chosen,
        extra_commits: extra.len(),
    })
}

/// `git <args>` in `dir` with `input` on stdin; trimmed stdout.
fn git_with_input(
    dir: &Path,
    git_dir: Option<&Path>,
    args: &[&str],
    input: &[u8],
) -> Result<String> {
    let mut cmd = Command::new("git");
    if let Some(g) = git_dir {
        cmd.arg(format!("--git-dir={}", g.display()));
    }
    let mut child = cmd
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("running git {}", args.first().unwrap_or(&"")))?;
    let mut stdin = child.stdin.take().expect("piped");
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output()?;
    let _ = writer.join();
    if !out.status.success() {
        bail!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn oid_lines(out: &str) -> BTreeSet<String> {
    out.lines()
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_owned)
        .collect()
}

/// `oids`, one per line, each after `prefix` (`^` excludes it from a `rev-list`).
fn stdin_lines<'a>(prefix: &str, oids: impl IntoIterator<Item = &'a String>) -> String {
    oids.into_iter().fold(String::new(), |mut out, o| {
        out.push_str(prefix);
        out.push_str(o);
        out.push('\n');
        out
    })
}

/// The objects `tips` reach that `public` does not (`rev-list --objects`), or only commits, in
/// the clone at `cwd`.
fn beyond_public(
    cwd: &Path,
    tips: &[String],
    public: &[String],
    objects: bool,
) -> Result<BTreeSet<String>> {
    let input = stdin_lines("", tips) + &stdin_lines("^", public);
    let args: &[&str] = if objects {
        &["rev-list", "--objects", "--stdin"]
    } else {
        &["rev-list", "--stdin"]
    };
    Ok(oid_lines(&git_with_input(
        cwd,
        None,
        args,
        input.as_bytes(),
    )?))
}

/// [`beyond_public`] for objects the members-only packs carry, in the scratch repository that
/// indexed them (and borrows the clone's objects): a pack may hold objects this clone never
/// fetched, and the walk goes on past one that no pack or clone has.
fn beyond_public_in(
    scratch: &Scratch,
    objects: &[String],
    public: &[String],
) -> Result<BTreeSet<String>> {
    let input = stdin_lines("", objects) + &stdin_lines("^", public);
    Ok(oid_lines(&git_with_input(
        &scratch.cwd,
        Some(scratch.dir.path()),
        &["rev-list", "--objects", "--missing=allow-any", "--stdin"],
        input.as_bytes(),
    )?))
}

/// A scratch bare repository under the clone's git directory borrowing its objects, where
/// members-only packs are indexed to see what they hold (never in a shared temporary directory:
/// they are members-only content).
struct Scratch {
    dir: tempfile::TempDir,
    cwd: PathBuf,
    /// The clone's hash length in bytes (a pack's trailer): 20 for SHA-1, 32 for SHA-256.
    hash_len: u64,
}

impl Scratch {
    fn new(cwd: &Path) -> Result<Self> {
        let common = PathBuf::from(git::git(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            &[],
        )?);
        let objects = PathBuf::from(git::git(
            cwd,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
            &[],
        )?);
        let parent = common.join("dash");
        std::fs::create_dir_all(&parent)?;
        let dir = tempfile::Builder::new()
            .prefix("share-")
            .tempdir_in(&parent)?;
        let format = git::git(cwd, &["rev-parse", "--show-object-format"], &[])
            .unwrap_or_else(|_| "sha1".to_owned());
        git::git(
            cwd,
            &[
                "init",
                "-q",
                "--bare",
                &format!("--object-format={format}"),
                &dir.path().display().to_string(),
            ],
            &[],
        )?;
        std::fs::write(
            dir.path().join("objects/info/alternates"),
            format!("{}\n", objects.display()),
        )?;
        Ok(Self {
            dir,
            cwd: cwd.to_path_buf(),
            hash_len: if format == "sha256" { 32 } else { 20 },
        })
    }

    /// Index the plaintext git pack `pack` here and say what it holds: its own objects (those
    /// before the bases `--fix-thin` appends), the commits among them, and the appended bases.
    fn contents(&self, pack: &[u8]) -> Result<PackContents> {
        let git_dir = self.dir.path();
        let out = git_with_input(
            &self.cwd,
            Some(git_dir),
            &["index-pack", "--stdin", "--fix-thin"],
            pack,
        )?;
        let name = out
            .split_whitespace()
            .last()
            .context("git index-pack named no pack")?
            .to_owned();
        let idx = std::fs::read(git_dir.join(format!("objects/pack/pack-{name}.idx")))?;
        let listing = git_with_input(&self.cwd, Some(git_dir), &["show-index"], &idx)?;
        let own_end = (pack.len() as u64).saturating_sub(self.hash_len);
        let (mut own, mut bases) = (BTreeSet::new(), BTreeSet::new());
        for line in listing.lines() {
            let mut f = line.split_whitespace();
            let (Some(off), Some(oid)) = (f.next(), f.next()) else {
                continue;
            };
            let off: u64 = off.parse().context("git show-index")?;
            if off < own_end {
                own.insert(oid.to_owned());
            } else {
                bases.insert(oid.to_owned());
            }
        }
        let types = git_with_input(
            &self.cwd,
            Some(git_dir),
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            stdin_lines("", &own).as_bytes(),
        )?;
        let commits = types
            .lines()
            .filter_map(|l| l.strip_suffix(" commit"))
            .map(str::to_owned)
            .collect();
        Ok(PackContents {
            own,
            commits,
            bases,
        })
    }
}

/// One members-only pack of the repository: its `packHash` and its file key.
struct Candidate {
    pack_hash: [u8; 32],
    key: Zeroizing<[u8; 32]>,
}

/// A refusal that shares nothing.
fn nothing_shared(code: &'static str, why: impl Into<String>) -> UserError {
    UserError::new(code, why).note("nothing was shared")
}

fn nobody_refusal(why: impl Into<String>) -> anyhow::Error {
    nothing_shared(codes::USAGE, why).into()
}

/// Drop from each pack's `bases` those a public branch reaches: they are already on the
/// recipient's side.
fn keep_private_bases(
    scratch: &Scratch,
    contents: &mut [PackContents],
    public: &[String],
) -> Result<()> {
    let all: BTreeSet<&String> = contents.iter().flat_map(|c| &c.bases).collect();
    if all.is_empty() {
        return Ok(());
    }
    let all: Vec<String> = all.into_iter().cloned().collect();
    let private = beyond_public_in(scratch, &all, public)?;
    for c in contents {
        c.bases.retain(|b| private.contains(b));
    }
    Ok(())
}

/// How many objects the chosen packs carry beyond `needed` that the public branches do not reach
/// (stored with the branch's commits by another members-only branch or an earlier push).
fn count_extra_objects(
    scratch: &Scratch,
    choice: &Choice,
    contents: &[PackContents],
    needed: &BTreeSet<String>,
    public: &[String],
) -> Result<usize> {
    let extra: Vec<String> = choice
        .packs
        .iter()
        .flat_map(|i| contents[*i].own.iter())
        .filter(|o| !needed.contains(*o))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if extra.is_empty() {
        return Ok(0);
    }
    let beyond = beyond_public_in(scratch, &extra, public)?;
    Ok(extra.iter().filter(|o| beyond.contains(*o)).count())
}

/// The people `--to` names, each once and never the sharer: `(identity id, the word that named
/// them)` and their recipient slots, in the same order.
async fn resolve_recipients(
    s: &Session,
    to: &[String],
    me: &str,
    action: &str,
) -> Result<(Vec<(String, String)>, Vec<Recipient>)> {
    let mut names: Vec<(String, String)> = Vec::new();
    let mut recipients: Vec<Recipient> = Vec::new();
    for word in to.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        let id = crate::common::resolve_identity(&s.client, word, "recipient").await?;
        if id == me || names.iter().any(|(i, _)| *i == id) {
            continue;
        }
        let identity = s.client.fetch_identity(&id).await?;
        let keys = identity.public_keys();
        let Some(pk) = forge_core::keyring::recipient_key(&keys, &s.repo.forge().core)
            .and_then(|k| <[u8; 33]>::try_from(k.public_key.as_slice()).ok())
        else {
            return Err(nothing_shared(
                codes::NO_ENCRYPTION_KEY,
                format!(
                    "{action}: {word} has no encryption key, so nothing can be shared with them"
                ),
            )
            .fix(format!(
                "ask {word} to add one: `dg auth keys add --encryption`"
            ))
            .into());
        };
        recipients.push(Recipient {
            identity_id: forge_core::platform::decode_identifier(&id)?,
            public_key: pk,
        });
        names.push((id, word.to_owned()));
    }
    Ok((names, recipients))
}

/// A members-only branch as it is now, as a `branch` letter's body, with what it carries
/// (what `dg branch share` and `dg bot ask` hand on).
pub struct Snapshot {
    /// The letter's body: the head, the push's name hash, the packs and their file keys.
    pub letter: BranchLetter,
    /// The head commit (hex).
    pub tip: String,
    /// Commits on the branch beyond the public branches.
    pub commits: usize,
    /// Commits the chosen packs hold that are not on the branch.
    pub extra_commits: usize,
    /// Git objects the chosen packs hold that are not on the branch.
    pub extra_objects: usize,
    /// How many packs.
    pub packs: usize,
}

/// Branch `full` of the repository of session `s` as it is now, read in the clone at `cwd`:
/// the members-only ref update that set its tip (a current member's) and the stored
/// members-only packs that hold its commits beyond the public branches, indexed in a scratch
/// repository. The caller has checked the signer's role and that `kr` holds the members key.
#[allow(clippy::too_many_lines, clippy::many_single_char_names)] // one pass, as share() was
pub async fn snapshot(
    ctx: &Ctx,
    s: &Session,
    svc: &forge_core::repo::RepoService<'_>,
    kr: &std::sync::Arc<forge_core::keyring::Keyring>,
    cwd: &Path,
    full: &str,
) -> Result<Snapshot> {
    let short = forge_core::repo::short_branch_name(full).to_owned();
    // the branch as members see it now, and the push that set its tip
    let state = svc.git_state(&s.repo).await?;
    let view = MembersRefs::of(&state, |k, d| kr.open(k, d));
    let Some(branch) = view.refs.iter().find(|r| r.name == *full) else {
        return Err(nothing_shared(
            codes::NOT_FOUND,
            format!("{} has no branch {short}", s.repo.display()),
        )
        .into());
    };
    if !branch.members_only {
        return Err(nobody_refusal(format!(
            "{short} is public: anyone can already read it"
        )));
    }
    let Some(tip) = forge_core::rules::tip_of(&branch.state) else {
        return Err(nothing_shared(codes::NOT_FOUND, format!("{short} was deleted")).into());
    };
    let introducing = view.updates.by_name.get(full).and_then(|updates| {
        updates.iter().rev().find(|u| {
            u.new_oid.eq_ignore_ascii_case(&tip)
                && view.updates.sealed.get(&u.id).is_some_and(Option::is_some)
        })
    });
    let (Some(update), Some(head_blind)) = (introducing, view.updates.blind_of(full, &tip)) else {
        return Err(nobody_refusal(format!(
            "{short}'s newest push didn't check out, so it can't be shared; `dg branch` shows it"
        )));
    };
    let Some((doc, ref_name_hash)) = state
        .ref_updates
        .iter()
        .chain(&state.protected_ref_updates)
        .find(|d| d.id == update.id)
        .and_then(|d| Some((d, d.field_bytes32("refNameHash")?)))
    else {
        bail!("the push that set {short} could not be read again");
    };
    // a share counts for its recipient only when the push it names is a current member's
    let roles = svc.copy_roles(&s.repo).await?;
    if !forge_core::repo::trusted_member(&roles, &doc.owner_id) {
        return Err(nothing_shared(
            codes::USAGE,
            format!("{short}'s newest push was made by someone who isn't a member any more, so it can't be shared"),
        )
        .fix(format!("push {short} again yourself, then share it"))
        .into());
    }
    if !git::has_object(cwd, &tip) {
        return Err(nothing_shared(
            codes::USAGE,
            format!("this clone doesn't have {short}'s newest commits yet"),
        )
        .fix("git fetch origin")
        .into());
    }
    let public: Vec<String> = view
        .refs
        .iter()
        .filter(|r| !r.members_only)
        .filter_map(|r| forge_core::rules::tip_of(&r.state))
        .collect();
    if public.iter().any(|t| !git::has_object(cwd, t)) {
        return Err(nothing_shared(
            codes::USAGE,
            "this clone doesn't have the public branches' newest commits yet",
        )
        .cause(format!(
            "what {short} adds to the public branches can only be worked out from them"
        ))
        .fix("git fetch origin")
        .into());
    }
    let needed = beyond_public(cwd, std::slice::from_ref(&tip), &public, true)?;
    let needed_commits = beyond_public(cwd, std::slice::from_ref(&tip), &public, false)?;
    if needed_commits.is_empty() {
        return Err(nobody_refusal(format!(
            "every commit on {short} is already on a public branch: there is nothing members-only to share"
        )));
    }

    // what every members-only pack holds
    let manifests = svc.read_pack_manifests(&s.repo).await?;
    let members_kind = u64::from(forge_core::pack::KIND_MEMBERS_GIT_PACK);
    let mut by_hash: BTreeMap<[u8; 32], Vec<&PackManifestInfo>> = BTreeMap::new();
    for m in manifests
        .iter()
        .filter(|m| m.kind == members_kind && forge_core::repo::trusted_member(&roles, &m.owner_id))
    {
        by_hash.entry(m.pack_hash).or_default().push(m);
    }
    if !ctx.json {
        eprintln!(
            "Reading {} members-only pack(s) to find the ones that hold {}…",
            by_hash.len(),
            safe(&short)
        );
    }
    let contract = svc.repo_contract(&s.repo).await?;
    let reader = svc.repo_reader(&s.repo, &manifests, &roles).await;
    let scratch = Scratch::new(cwd)?;
    // `contents[i]` is what `candidates[i]` holds
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut contents: Vec<PackContents> = Vec::new();
    for (hash, copies) in &by_hash {
        let (sealed, copy) = match svc
            .fetch_best_copy_or_mirror(&s.repo, &contract, copies, &roles, &reader)
            .await
        {
            Ok(got) => got,
            Err(e) => {
                tracing::info!(pack = %hex::encode(hash), error = %e, "a members-only pack could not be fetched; left out");
                continue;
            }
        };
        let Ok(header) = forge_core::private::PackHeader::parse(&sealed, sealed.len() as u64)
        else {
            continue;
        };
        let Some(keys) = kr.epoch_keys(header.epoch()) else {
            continue;
        };
        let key = header.file_key(keys)?;
        // a pack this key does not open, or one a removed member wrote late (§8.2), is left out
        let plain = match svc
            .open_members_pack(&s.repo, kr, copies, copy.size_bytes, sealed)
            .await
        {
            Ok(ArtifactRead::Bytes(b)) => b,
            Ok(ArtifactRead::Skipped(_)) => continue,
            Err(e) => {
                tracing::info!(pack = %hex::encode(hash), error = %e, "a members-only pack did not open; left out");
                continue;
            }
        };
        match scratch.contents(&plain) {
            Ok(c) => contents.push(c),
            Err(e) => {
                tracing::info!(pack = %hex::encode(hash), error = %e, "a members-only pack could not be indexed; left out");
                continue;
            }
        }
        candidates.push(Candidate {
            pack_hash: *hash,
            key,
        });
    }
    keep_private_bases(&scratch, &mut contents, &public)?;
    let choice = choose_packs(&needed, &needed_commits, &contents).map_err(|missing| {
        nothing_shared(
            codes::PACKS_UNREADABLE,
            format!(
                "share {short}: {} of its objects aren't in any stored members-only pack",
                missing.len()
            ),
        )
        .cause("the commits were pushed from somewhere whose packs are gone, or never stored")
        .fix(format!(
            "push {short} again from a clone that has it, then share it"
        ))
    })?;
    let extra_objects = count_extra_objects(&scratch, &choice, &contents, &needed, &public)?;
    drop(scratch);

    let mut packs: Vec<LetterPack> = choice
        .packs
        .iter()
        .map(|i| LetterPack {
            pack_hash: candidates[*i].pack_hash,
            key: candidates[*i].key.clone(),
        })
        .collect();
    packs.sort_by_key(|p| p.pack_hash);
    Ok(Snapshot {
        letter: BranchLetter {
            name: full.to_owned(),
            ref_name_hash,
            head: LetterHead {
                blind: b.blind.clone(),
                oid: b.real.clone(),
                salt: b.salt,
            },
            packs,
            as_of: u.created_at,
        },
        tip,
        commits: needed_commits.len(),
        extra_commits: choice.extra_commits,
        extra_objects,
        packs: choice.packs.len(),
    })
}

/// Run `dg branch share <name> --to …`.
#[allow(clippy::too_many_lines)] // one pass: who, which branch, which packs, the letter, the write
pub async fn share(ctx: &Ctx, name: &str, to: &[String]) -> Result<()> {
    let cwd = std::env::current_dir().context("reading the current directory")?;
    let full = git::full_ref(name);
    git::require_branch_ref(&full)?;
    let short = forge_core::repo::short_branch_name(&full).to_owned();
    let repo = crate::storage::clone_repo().ok_or_else(|| {
        crate::errors::usage(
            "not in a clone of a Forge repository: share a members-only branch from a clone that has it",
        )
    })?;
    let s = Session::open_for_write(ctx, &repo, "nothing shared").await?;
    if s.repo.visibility != Visibility::Public {
        return Err(nobody_refusal(format!(
            "{} is private: everyone who can see its branches is a member. Add people with `dg collab add`",
            s.repo.display()
        )));
    }
    let svc = forge_core::repo::RepoService::new(&s.client, &s.identity, &s.bridge);
    let me = s.identity.id();
    let role = forge_core::members::MemberReader::new(&s.client)
        .best_role(&s.repo, &me)
        .await?;
    if !matches!(role, Some(Role::Maintainer | Role::Writer)) {
        return Err(nothing_shared(
            codes::NOT_A_WRITER,
            format!("share {short}: only members with Write or Maintain access can share a members-only branch"),
        )
        .into());
    }
    let kr = svc.keyring(&s.repo).await?;
    if !kr.has_members_key() {
        return Err(nothing_shared(
            codes::MEMBERS_ONLY_OFF,
            format!("{} has no members-only content", s.repo.display()),
        )
        .into());
    }
    if kr.resolution().keys.is_empty() {
        return Err(nothing_shared(
            codes::NO_KEY_SHARED,
            format!("share {short}: no key has been shared with you yet, so you can't read its members-only branches"),
        )
        .fix("ask a maintainer to run `dg repo members repair`")
        .into());
    }

    let snap = snapshot(ctx, &s, &svc, &kr, &cwd, &full).await?;
    let (tip, commits, choice, extra_objects) =
        (&snap.tip, snap.commits, &snap, snap.extra_objects);

    // the recipients: the sharer first, then each person named
    let signer = forge_core::keyring::PrivateSigner {
        client: &s.client,
        identity: &s.identity,
        bridge: &s.bridge,
    };
    let enc = signer.encryption_keys(&s.repo);
    let action = format!("share {short}");
    let (sender_key_id, sender) = enc
        .sender()
        .ok_or_else(|| forge_core::keyring::no_members_encryption_key_held(&action))?;
    let me_bytes = forge_core::platform::decode_identifier(&me)?;
    let (names, others) = resolve_recipients(&s, to, &me, &action).await?;
    let mut recipients = vec![Recipient {
        identity_id: me_bytes,
        public_key: sender.public_key(),
    }];
    recipients.extend(others);
    if names.is_empty() {
        return Err(crate::errors::usage(
            "--to names nobody to share with but you: give @names or identity ids",
        ));
    }
    if recipients.len() > MAX_ARTIFACT_RECIPIENTS {
        return Err(nobody_refusal(format!(
            "a branch can be shared with at most {} people at once",
            MAX_ARTIFACT_RECIPIENTS - 1
        )));
    }

    // the letter
    let letter = &snap.letter;
    let typed = letter
        .to_typed()
        .context("the share could not be written: its head did not check")?;
    if let Err(key_letter::LetterError::TooLarge(_)) = typed.encode() {
        return Err(nobody_refusal(format!(
            "{short} has too many pushes to share at once ({} packs)",
            choice.packs
        )));
    }
    let sealed = key_letter::seal(
        &s.repo.scope()?.repo_id,
        sender,
        sender_key_id,
        &me_bytes,
        &recipients,
        &typed,
    )
    .map_err(|e| anyhow::anyhow!("{action}: {e}"))?;
    if sealed.len() as u64 > forge_core::env::service::MAX_SEALED {
        return Err(nobody_refusal(format!(
            "{short} has too many pushes to share at once ({} packs)",
            choice.packs
        )));
    }
    let credits = forge_core::env::service::snapshot_credits(sealed.len() as u64);
    let who = names
        .iter()
        .map(|(_, w)| w.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    if !ctx.json {
        eprintln!(
            "Share {} with {who} as it is now: {commits} commit(s) beyond the public branches, head {}.",
            safe(&short),
            crate::fmt::short(tip)
        );
        if extra_objects > 0 {
            eprintln!(
                "  They also get {extra_objects} git object(s) that aren't on {} ({} of them commits): another members-only branch or an earlier push stored them with its commits.",
                safe(&short),
                choice.extra_commits
            );
        }
        eprintln!(
            "  They won't see anything pushed to {} later unless you share it again. Sharing can't be undone.",
            safe(&short)
        );
        eprintln!(
            "  Cost: {}",
            crate::fmt::cost_line(credits, ctx.usd_price())
        );
    }
    ctx.confirm_or_cancel(&format!("Share {} with {who}?", safe(&short)))?;
    let ((id, pack_hash), spent) = s.metered(|| svc.store_key_letter(&s.repo, &sealed)).await?;
    ctx.emit(
        json!({
            "status": "shared",
            "branch": short,
            "ref": full,
            "head": tip,
            "commits": commits,
            "extraCommits": choice.extra_commits,
            "extraObjects": extra_objects,
            "packs": choice.packs,
            "to": names.iter().map(|(i, _)| i).collect::<Vec<_>>(),
            "letter": id,
            "packHash": hex::encode(pack_hash),
            "cost": crate::fmt::cost_json(spent, ctx.usd_price()),
        }),
        || {
            println!("✓ shared {} with {who} as it is now", safe(&short));
            println!("  they get it with `git fetch`; anything pushed to it later isn't shared unless you share it again");
            println!("  spent {}", crate::fmt::cost_line(spent, ctx.usd_price()));
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(xs: &[&str]) -> BTreeSet<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }

    fn pack(own: &[&str], commits: &[&str], bases: &[&str]) -> PackContents {
        PackContents {
            own: set(own),
            commits: set(commits),
            bases: set(bases),
        }
    }

    #[test]
    fn the_branch_own_packs_win_over_a_pack_that_carries_other_commits() {
        // B forked from members-only A at a2; B's first pack holds a1, a2 and b1 (thin against P)
        let needed = set(&["a1", "a2", "b1", "t"]);
        let commits = set(&["a1", "a2", "b1"]);
        let packs = [
            pack(&["a1", "a2", "a3", "t"], &["a1", "a2", "a3"], &[]),
            pack(&["a1", "a2", "b1", "t"], &["a1", "a2", "b1"], &[]),
        ];
        let c = choose_packs(&needed, &commits, &packs).unwrap();
        assert_eq!(
            c,
            Choice {
                packs: vec![1],
                extra_commits: 0
            }
        );
    }

    #[test]
    fn a_thin_pack_brings_the_pack_holding_its_bases() {
        // b2's pack deltas against b1's tree, which only b1's pack holds
        let needed = set(&["b1", "b2", "t2"]);
        let commits = set(&["b1", "b2"]);
        let packs = [
            pack(&["b2", "t2"], &["b2"], &["t1"]),
            pack(&["b1", "t1"], &["b1"], &[]),
            pack(&["x"], &["x"], &[]),
        ];
        let c = choose_packs(&needed, &commits, &packs).unwrap();
        assert_eq!(c.packs.len(), 2);
        assert!(!c.packs.contains(&2));
        assert_eq!(c.extra_commits, 0);
    }

    #[test]
    fn a_force_pushed_away_commit_comes_along_when_its_pack_is_needed() {
        let needed = set(&["y1", "ty"]);
        let commits = set(&["y1"]);
        let packs = [
            pack(&["y1"], &["y1"], &["tx"]),
            pack(&["x1", "tx", "ty"], &["x1"], &[]),
        ];
        let c = choose_packs(&needed, &commits, &packs).unwrap();
        assert_eq!(c.packs.len(), 2);
        assert_eq!(c.extra_commits, 1);
    }

    #[test]
    fn objects_no_pack_holds_are_named() {
        let needed = set(&["c1", "c2"]);
        let commits = set(&["c1", "c2"]);
        let packs = [pack(&["c1"], &["c1"], &[])];
        assert_eq!(
            choose_packs(&needed, &commits, &packs),
            Err(vec!["c2".to_owned()])
        );
    }
}
