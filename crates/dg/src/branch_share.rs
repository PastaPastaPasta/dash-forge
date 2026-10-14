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

/// The objects `tips` reach that `public` does not (`rev-list --objects`), or only commits.
fn beyond_public(
    cwd: &Path,
    tips: &[String],
    public: &[String],
    objects: bool,
) -> Result<BTreeSet<String>> {
    let mut input = String::new();
    for t in tips {
        input.push_str(t);
        input.push('\n');
    }
    for p in public {
        input.push('^');
        input.push_str(p);
        input.push('\n');
    }
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
    fn contents(
        &self,
        pack: &[u8],
    ) -> Result<(BTreeSet<String>, BTreeSet<String>, BTreeSet<String>)> {
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
        let mut query = String::new();
        for o in &own {
            query.push_str(o);
            query.push('\n');
        }
        let types = git_with_input(
            &self.cwd,
            Some(git_dir),
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            query.as_bytes(),
        )?;
        let commits = types
            .lines()
            .filter_map(|l| l.strip_suffix(" commit"))
            .map(str::to_owned)
            .collect();
        Ok((own, commits, bases))
    }
}

/// One members-only pack of the repository: its manifest, its file key, and what it holds.
struct Candidate {
    pack_hash: [u8; 32],
    key: Zeroizing<[u8; 32]>,
    contents: PackContents,
}

fn nobody_refusal(why: impl Into<String>) -> anyhow::Error {
    UserError::new(codes::USAGE, why.into())
        .note("nothing was shared")
        .into()
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
        return Err(UserError::new(
            codes::NOT_A_WRITER,
            format!("share {short}: only members with Write or Maintain access can share a members-only branch"),
        )
        .note("nothing was shared")
        .into());
    }
    let kr = svc.keyring(&s.repo).await?;
    if !kr.has_members_key() {
        return Err(UserError::new(
            codes::MEMBERS_ONLY_OFF,
            format!("{} has no members-only content", s.repo.display()),
        )
        .note("nothing was shared")
        .into());
    }
    if kr.resolution().keys.is_empty() {
        return Err(UserError::new(
            codes::NO_KEY_SHARED,
            format!("share {short}: no key has been shared with you yet, so you can't read its members-only branches"),
        )
        .fix("ask a maintainer to run `dg repo members repair`")
        .note("nothing was shared")
        .into());
    }

    // the branch as members see it now, and the push that set its tip
    let state = svc.git_state(&s.repo).await?;
    let view = MembersRefs::of(&state, |k, d| kr.open(k, d));
    let Some(branch) = view.refs.iter().find(|r| r.name == full) else {
        return Err(UserError::new(
            codes::NOT_FOUND,
            format!("{} has no branch {short}", s.repo.display()),
        )
        .note("nothing was shared")
        .into());
    };
    if !branch.members_only {
        return Err(nobody_refusal(format!(
            "{short} is public: anyone can already read it"
        )));
    }
    let Some(tip) = forge_core::rules::tip_of(&branch.state) else {
        return Err(
            UserError::new(codes::NOT_FOUND, format!("{short} was deleted"))
                .note("nothing was shared")
                .into(),
        );
    };
    let updates = view.updates.by_name.get(&full).cloned().unwrap_or_default();
    let introducing = updates.iter().rev().find(|u| {
        u.new_oid.eq_ignore_ascii_case(&tip)
            && view.updates.sealed.get(&u.id).is_some_and(Option::is_some)
    });
    let (Some(u), Some(b)) = (introducing, view.updates.blind_of(&full, &tip)) else {
        return Err(nobody_refusal(format!(
            "{short}'s newest push didn't check out, so it can't be shared; `dg branch` shows it"
        )));
    };
    let Some(doc) = state
        .ref_updates
        .iter()
        .chain(&state.protected_ref_updates)
        .find(|d| d.id == u.id)
    else {
        bail!("the push that set {short} could not be read again");
    };
    let Some(ref_name_hash) = doc.field_bytes32("refNameHash") else {
        bail!("the push that set {short} could not be read again");
    };
    // a share counts for its recipient only when the push it names is a current member's
    let roles = svc.copy_roles(&s.repo).await?;
    if !forge_core::repo::trusted_member(&roles, &doc.owner_id) {
        return Err(UserError::new(
            codes::USAGE,
            format!("{short}'s newest push was made by someone who isn't a member any more, so it can't be shared"),
        )
        .fix(format!("push {short} again yourself, then share it"))
        .note("nothing was shared")
        .into());
    }
    if !git::has_object(&cwd, &tip) {
        return Err(UserError::new(
            codes::USAGE,
            format!("this clone doesn't have {short}'s newest commits yet"),
        )
        .fix("git fetch origin")
        .note("nothing was shared")
        .into());
    }
    let public: Vec<String> = view
        .refs
        .iter()
        .filter(|r| !r.members_only)
        .filter_map(|r| forge_core::rules::tip_of(&r.state))
        .collect();
    if public.iter().any(|t| !git::has_object(&cwd, t)) {
        return Err(UserError::new(
            codes::USAGE,
            "this clone doesn't have the public branches' newest commits yet",
        )
        .cause(format!(
            "what {short} adds to the public branches can only be worked out from them"
        ))
        .fix("git fetch origin")
        .note("nothing was shared")
        .into());
    }
    let needed = beyond_public(&cwd, std::slice::from_ref(&tip), &public, true)?;
    let needed_commits = beyond_public(&cwd, std::slice::from_ref(&tip), &public, false)?;
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
    let scratch = Scratch::new(&cwd)?;
    let mut candidates: Vec<Candidate> = Vec::new();
    for (hash, copies) in &by_hash {
        let (sealed, m) = match svc
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
            .open_members_pack(&s.repo, &kr, copies, m.size_bytes, sealed)
            .await
        {
            Ok(ArtifactRead::Bytes(b)) => b,
            Ok(ArtifactRead::Skipped(_)) => continue,
            Err(e) => {
                tracing::info!(pack = %hex::encode(hash), error = %e, "a members-only pack did not open; left out");
                continue;
            }
        };
        let (own, commits, bases) = match scratch.contents(&plain) {
            Ok(c) => c,
            Err(e) => {
                tracing::info!(pack = %hex::encode(hash), error = %e, "a members-only pack could not be indexed; left out");
                continue;
            }
        };
        candidates.push(Candidate {
            pack_hash: *hash,
            key,
            contents: PackContents {
                own,
                commits,
                bases,
            },
        });
    }
    // bases a public branch reaches are already on the recipient's side
    let all_bases: Vec<String> = candidates
        .iter()
        .flat_map(|c| c.contents.bases.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let private_bases = if all_bases.is_empty() {
        BTreeSet::new()
    } else {
        beyond_public(&cwd, &all_bases, &public, true)?
    };
    for c in &mut candidates {
        c.contents.bases.retain(|b| private_bases.contains(b));
    }
    drop(scratch);
    let contents: Vec<PackContents> = candidates.iter().map(|c| c.contents.clone()).collect();
    let choice = choose_packs(&needed, &needed_commits, &contents).map_err(|missing| {
        anyhow::Error::from(
            UserError::new(
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
            .note("nothing was shared"),
        )
    })?;
    // what else the chosen packs carry that the public branches do not reach: objects stored with
    // the branch's commits by another members-only branch or an earlier (since overwritten) push
    let extra: Vec<String> = choice
        .packs
        .iter()
        .flat_map(|i| contents[*i].own.iter())
        .filter(|o| !needed.contains(*o))
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let extra_objects = if extra.is_empty() {
        0
    } else {
        let beyond = beyond_public(&cwd, &extra, &public, true)?;
        extra.iter().filter(|o| beyond.contains(*o)).count()
    };

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
    let mut recipients = vec![Recipient {
        identity_id: me_bytes,
        public_key: sender.public_key(),
    }];
    let mut names: Vec<(String, String)> = Vec::new();
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
            return Err(UserError::new(
                codes::NO_ENCRYPTION_KEY,
                format!(
                    "{action}: {word} has no encryption key, so nothing can be shared with them"
                ),
            )
            .fix(format!(
                "ask {word} to add one: `dg auth keys add --encryption`"
            ))
            .note("nothing was shared")
            .into());
        };
        recipients.push(Recipient {
            identity_id: forge_core::platform::decode_identifier(&id)?,
            public_key: pk,
        });
        names.push((id, word.to_owned()));
    }
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
    let mut packs: Vec<LetterPack> = choice
        .packs
        .iter()
        .map(|i| LetterPack {
            pack_hash: candidates[*i].pack_hash,
            key: candidates[*i].key.clone(),
        })
        .collect();
    packs.sort_by_key(|p| p.pack_hash);
    let letter = BranchLetter {
        name: full.clone(),
        ref_name_hash,
        head: LetterHead {
            blind: b.blind.clone(),
            oid: b.real.clone(),
            salt: b.salt,
        },
        packs,
        as_of: u.created_at,
    };
    let typed = letter
        .to_typed()
        .context("the share could not be written: its head did not check")?;
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
            choice.packs.len()
        )));
    }
    let credits = forge_core::env::service::snapshot_credits(sealed.len() as u64);
    let who = names
        .iter()
        .map(|(_, w)| w.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let commits = needed_commits.len();
    if !ctx.json {
        eprintln!(
            "Share {} with {who} as it is now: {commits} commit(s) beyond the public branches, head {}.",
            safe(&short),
            crate::fmt::short(&tip)
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
            "packs": choice.packs.len(),
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
