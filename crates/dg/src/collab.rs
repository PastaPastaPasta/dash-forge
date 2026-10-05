//! `dg collab` — repository members: accept / add / remove / list.
//!
//! On forge-v2 a member is a `writer` or `maintainer` document the repo owner creates
//! (add) or deletes (remove); consensus refuses the removed member's next write at once. A
//! `writer` document's role is writer, triage or reader (RC2 member roles); adding a member
//! with another of those roles replaces the document.
//! There is no suspend: remove and re-add instead. Adding is a two-party invite: the member
//! first accepts (`dg collab accept`, their own `consent` document), and the owner's add names
//! that consent (RC1 `member_consent`); `dg collab add --wait` waits for it.
//!
//! On a repository with a **members key** — every private repository, and a public one with
//! members-only content turned on (`dg repo members enable`, DESIGN §4.1) — add also wraps the
//! current key epoch to the new member, and remove rotates the key after the delete (a new
//! epoch wrapped to every remaining member, you first, then its anchor). Past content stays
//! readable to the removed member: encryption can't take back what was shared. This keys on
//! the members key existing, never on visibility alone (`keyring::has_members_key`). A private
//! repository refuses an add before anything is written when the member has no encryption key;
//! a public one adds them and says the key will be shared once they have one.

use anyhow::{Context, Result};
use serde_json::json;

use forge_core::keyring::PrivateSigner;
use forge_core::members::{
    awaiting_consent, check_grant, doc_type, holds_members_key, ConsentService, MemberReader,
    MemberService,
};
use forge_core::rules::v2::{Role, Visibility};
use forge_core::user_error::{codes, UserError};

use crate::fmt::{cost_json, cost_line};

use crate::common::{resolve_identity, Reader, Session};
use crate::context::Ctx;
use crate::{CollabCommand, RoleArg};

/// Dispatch a `collab` subcommand.
pub async fn run(ctx: &Ctx, cmd: &CollabCommand) -> Result<()> {
    match cmd {
        CollabCommand::Add {
            repo,
            member,
            role,
            wait,
        } => add(ctx, repo, member, *role, *wait).await,
        CollabCommand::Accept { repo, withdraw } => accept(ctx, repo, *withdraw).await,
        CollabCommand::Remove {
            repo,
            member,
            role,
            no_resave,
        } => remove(ctx, repo, member, *role, *no_resave).await,
        CollabCommand::List { repo } => list(ctx, repo).await,
    }
}

/// A member delete (`dg collab remove`), estimated. A grant is `quote::MEMBER_GRANT`.
const MEMBER_DOC_ESTIMATE_CREDITS: u64 = 20_000_000;
/// How long `dg collab remove` waits for the deleted role to leave a proved read before it
/// rotates: attempts, and the pause between them.
const DELETE_VISIBLE_ATTEMPTS: usize = 12;
const DELETE_VISIBLE_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

/// How often `dg collab add --wait` looks for the member's acceptance.
const CONSENT_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// Wait up to `wait` seconds for `member`'s consent to `handle` (none: look once). Refused with
/// the fix when it does not come.
async fn require_consent(
    ctx: &Ctx,
    client: &forge_core::platform::PlatformClient,
    handle: &forge_core::scope::RepoRef,
    member: &str,
    wait: Option<u64>,
) -> Result<()> {
    if member == handle.owner_id() {
        return Ok(());
    }
    let reader = MemberReader::new(client);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait.unwrap_or(0));
    let mut told = false;
    loop {
        if reader.consented(handle, member).await? {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(awaiting_consent(handle, member).into());
        }
        if !told && !ctx.json {
            eprintln!(
                "waiting for {member} to run `dg collab accept {}` …",
                handle.display()
            );
            told = true;
        }
        tokio::time::sleep(CONSENT_POLL).await;
    }
}

async fn accept(ctx: &Ctx, repo: &str, withdraw: bool) -> Result<()> {
    let s = Session::open(ctx, repo).await?;
    let (client, handle) = (&s.client, &s.repo);
    let consent = ConsentService::new(client, &s.identity, &s.bridge);
    if withdraw {
        let removed = consent
            .withdraw(handle)
            .await
            .context("withdrawing your acceptance")?;
        ctx.emit(
            json!({
                "status": if removed { "withdrawn" } else { "not_accepted" },
                "repo": handle.display(),
            }),
            || {
                if removed {
                    println!("Withdrew your acceptance of {}.", handle.display());
                } else {
                    println!(
                        "You had not accepted {}; nothing to withdraw.",
                        handle.display()
                    );
                }
            },
        );
        return Ok(());
    }
    if !ctx.confirm(&format!(
        "Accept membership of {}? Its owner can then add you as a member (one document, {})",
        handle.display(),
        cost_line(crate::quote::CONSENT, ctx.usd_price())
    ))? {
        return Err(crate::errors::cancelled());
    }
    let before = s.balance().await;
    let (document_id, written) = consent
        .accept(handle)
        .await
        .context("accepting membership")?;
    let spent = if written {
        s.spent_since(before).await
    } else {
        0
    };
    let price = ctx.usd_price();
    let me = s.identity.id();
    ctx.emit(
        json!({
            "cost": cost_json(spent, price),
            "status": if written { "accepted" } else { "already_accepted" },
            "repo": handle.display(),
            "identityId": me,
            "documentId": document_id,
            "id": document_id,
        }),
        || {
            println!(
                "Accepted membership of {}. Its owner can now run `dg collab add {} {me}`.",
                handle.display(),
                handle.display()
            );
            if written {
                println!("  {}", cost_line(spent, price));
            }
        },
    );
    Ok(())
}

#[allow(clippy::too_many_lines)] // one flow: consent, key checks, the grant and its wrap
async fn add(ctx: &Ctx, repo: &str, member: &str, role: RoleArg, wait: Option<u64>) -> Result<()> {
    let role = role.to_core();
    let s = Session::open(ctx, repo).await?;
    let (client, handle) = (&s.client, &s.repo);
    // `member` is an identity id or a DPNS name; resolve it once so every check and write
    // below sees a plain identity id.
    let member: &str = &resolve_identity(client, member, "member").await?;
    // The owner cannot take triage or reader (as the web refuses it).
    check_grant(handle, member, role)?;
    let signer = crate::keys::signer(&s);
    // The member's consent comes first (checked before any cost prompt or key work), unless
    // they already hold the role: re-running an add to finish its key wrap needs none. A
    // writer document with another role is a role change (its consent is checked too).
    let current = MemberReader::new(client)
        .role_doc(handle, member, role)
        .await?
        .map(|m| m.role);
    let held = current == Some(role);
    let change_from = current.filter(|r| *r != role);
    if !held {
        require_consent(ctx, client, handle, member, wait).await?;
    }
    let private = handle.visibility == Visibility::Private;
    // The key goes to the new member whenever the repository has one and the role holds it:
    // a private repository, or a public one with members-only content (never by visibility
    // alone: an add that skipped the wrap would leave a member who cannot read).
    let plan = add_plan(
        forge_core::keyring::has_members_key(client, handle).await?,
        handle.visibility,
        role,
        change_from,
    );
    let (keyed, loses_key) = (plan.wrap, plan.rotate);
    let can_receive = !keyed || crate::keys::member_can_receive(client, handle, member).await?;
    if keyed {
        // Checked before anything is written: in a private repository a member with no
        // encryption key could be granted a role but never read it (§5.5, ux-dx-spec §9). In a
        // public one they can still do everything public; the key is shared once they add one.
        if private && !can_receive {
            return Err(UserError::new(
                codes::NO_ENCRYPTION_KEY,
                format!("{member} has no encryption key yet"),
            )
            .cause(format!(
                "{} is private: its key is wrapped to each member's encryption key",
                handle.display()
            ))
            .fix(format!(
                "send them this: `dg auth keys add --encryption`, or Settings → Keys → Enable private repos (one master-key signature); then run `dg collab add {repo} {member}` again"
            ))
            .note("nothing was written")
            .into());
        }
        // The key must be wrappable by us now (our own key, and an epoch we can write: not a
        // burned or unreadable one).
        let kr = signer.keyring(handle).await?;
        kr.writer(handle)?;
        // §5.3: anchors count only from current maintainers, so a new maintainer's earlier
        // configs (from a past maintainer role) would count again and could replace an anchor.
        if role == forge_core::rules::v2::Role::Maintainer {
            let id = forge_core::platform::decode_identifier(member)?;
            if let Some(epoch) = kr.maintainer_would_move_anchors(id) {
                return Err(UserError::new(
                    codes::ROTATION_PENDING,
                    format!(
                        "adding {member} as a maintainer of {repo} would change key epoch {epoch}"
                    ),
                )
                .cause("a config from their earlier maintainer role would count again")
                .fix("add them as a writer, or make a new identity of theirs the maintainer")
                .note("nothing was written")
                .into());
            }
        }
    }
    // QW4-049: the public add said "(one small document)" with no estimate; both were quoted
    // at 20M, under the 48.1M sakura charged.
    let what = if keyed && can_receive {
        format!(
            "a membership document + a key wrap, {}",
            cost_line(
                crate::quote::MEMBER_GRANT + crate::keys::WRAP_ESTIMATE_CREDITS,
                ctx.usd_price()
            )
        )
    } else {
        format!(
            "one membership document, {}",
            cost_line(crate::quote::MEMBER_GRANT, ctx.usd_price())
        )
    };
    let question = match change_from {
        Some(from) => format!(
            "Change {member}'s role in {repo} from {from} to {role}? (their writer document is \
             deleted and a new one written: 1 delete + {what})"
        ),
        None => format!("Add {member} as a {role} of {repo}? ({what})"),
    };
    // A new maintainer's earlier environment snapshots (ignored until now) start counting with
    // the role: the environments they would change are saved first, unchanged (DESIGN §4.5).
    let promotion = if role == Role::Maintainer && !held {
        Some(crate::env::prepare_promotion(&s, member).await?)
    } else {
        None
    };
    let question = match &promotion {
        Some(p) => format!("{question}{}", p.explain(member, ctx.usd_price())),
        None => question,
    };
    if !ctx.confirm(&question)? {
        return Err(crate::errors::cancelled());
    }
    let before = s.balance().await;
    let (protected, protected_text) = match &promotion {
        Some(p) => p.save(&s).await,
        None => (serde_json::Value::Null, String::new()),
    };
    if !protected_text.is_empty() {
        eprintln!("{}", protected_text.trim_start());
    }
    let granted = MemberService::new(client, &s.identity, &s.bridge)
        .grant(handle, member, role)
        .await
        .context("adding the member")?;
    if keyed && can_receive {
        forge_core::keyring::add_member_wrap(&signer, handle, member)
            .await
            .context("wrapping the repository key to the new member (re-run `dg collab add` to finish: the membership stands)")?;
    }
    let rotation = if loses_key {
        Some(
            rotate_after_removal(&signer, handle, member, None)
                .await
                .map_err(|e| not_rotated(&e, repo, member))?,
        )
    } else {
        None
    };
    // A role already held writes nothing (a keyed repository's wrap may still).
    let spent = if held && !keyed {
        0
    } else {
        s.spent_since(before).await
    };
    let key_pending = keyed && !can_receive;
    let price = ctx.usd_price();
    ctx.emit(
        json!({
            "status": "granted",
            "member": member,
            "role": granted.role.as_str(),
            "previousRole": change_from.map(Role::as_str),
            "environmentsSavedFirst": protected,
            "documentId": granted.document_id,
            "id": granted.document_id,
            "repo": handle.display(),
            "cost": cost_json(spent, price),
            "keyShared": keyed && can_receive,
            "keyPending": key_pending,
            "rotation": rotation.as_ref().map(crate::keys::rotation_json),
        }),
        || {
            println!(
                "{member} is a {} of {} (document {}) · {}",
                granted.role,
                handle.display(),
                granted.document_id,
                cost_line(spent, price)
            );
            if key_pending {
                println!(
                    "  {member} has no encryption key yet, so they can't read members-only content; once they add one (`dg auth keys add --encryption`), run `dg repo keys repair {}`",
                    handle.display()
                );
            }
            if let Some(r) = &rotation {
                crate::keys::print_rotation(handle, r);
            }
        },
    );
    Ok(())
}

#[allow(clippy::too_many_lines)] // one removal: prompt, re-anchor, revoke, rotate, environments
async fn remove(ctx: &Ctx, repo: &str, member: &str, role: RoleArg, no_resave: bool) -> Result<()> {
    let role = role.to_core();
    let s = Session::open(ctx, repo).await?;
    let (client, handle) = (&s.client, &s.repo);
    // `member` is an identity id or a DPNS name; resolve it once so every check and write
    // below sees a plain identity id.
    let member: &str = &resolve_identity(client, member, "member").await?;
    // A repository with a members key (private, or public with members-only content) rotates
    // it away from a removed member whose role held it: keyed on the key, never on visibility.
    let keyed = remove_rotates(
        forge_core::keyring::has_members_key(client, handle).await?,
        handle.visibility,
        role,
    );
    if handle.owner_id() != s.identity.id() {
        return Err(forge_core::Error::NotPermitted {
            action: format!("remove a member of {repo}"),
            reason: "only the repository's owner can change its members".into(),
            needs: "owner".into(),
        }
        .into());
    }
    // Writer, triage and reader are one `writer` document: name the role it grants.
    let shown = MemberReader::new(client)
        .role_doc(handle, member, role)
        .await?
        .map_or(role, |m| m.role);
    let prompt = if keyed {
        let members = MemberReader::new(client).list(handle).await?;
        let kr = crate::keys::signer(&s).keyring(handle).await?;
        keyed_remove_prompt(&kr, &members, handle, repo, member, shown, ctx.usd_price())
    } else {
        format!("Remove {member} as a {shown} of {repo}? Their next write is refused at once")
    };
    // Environments (DESIGN §4.5), read before they go: what they could read (keyed = held the
    // key), and those whose counted head a removed maintainer wrote, pinned and saved again
    // after the rotation (their snapshots stop counting when they go).
    let mut removal =
        crate::env::prepare_removal(&s, member, keyed, role == Role::Maintainer).await;
    let explained = if no_resave {
        removal.explain_skipped(member)
    } else {
        removal.explain(member, ctx.usd_price())
    };
    let prompt = format!("{prompt}{explained}");
    if !ctx.confirm(&prompt)? {
        return Err(crate::errors::cancelled());
    }
    // the saves are a separate decision (`--yes` answers both)
    if removal.saves() && !ctx.confirm("Save those environments again as you after the removal?")? {
        removal.skip_saves(member);
    }
    let signer = crate::keys::signer(&s);
    // Removing a maintainer withdraws their anchors (§5.3): re-anchor their epochs under the
    // same keys first, or the repo would fall back to an older key.
    let (dropped, losing) = if keyed && role == forge_core::rules::v2::Role::Maintainer {
        reanchor(&signer, handle, member).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let removed_role = MemberService::new(client, &s.identity, &s.bridge)
        .revoke(handle, member, role)
        .await
        .context("removing the member")?;
    let removed = removed_role.is_some();
    let shown = removed_role.unwrap_or(shown);
    // A private removal rotates. Also when the member was already gone but the repair check
    // still names them, or the current epoch is burned (an earlier removal whose rotation did
    // not finish, or anyone's interrupted burn: finishing it is the recovery path, and the prompt
    // above named who burned it): re-running `dg collab remove` finishes it.
    // Dropping only the writer role of someone who stays a maintainer changes nobody's access
    // to the key: no rotation (dropping the maintainer role of someone who stays a writer does
    // rotate, since their wraps stop counting, §5.4; they are wrapped the new key).
    let stays_maintainer = role != Role::Maintainer
        && MemberReader::new(client)
            .role_doc(handle, member, forge_core::rules::v2::Role::Maintainer)
            .await?
            .is_some();
    let needs_rotation = keyed
        && !stays_maintainer
        && (removed
            || rotation_still_pending(&signer, handle, member)
                .await
                .unwrap_or(false));
    let rotation = if needs_rotation {
        Some(
            rotate_after_removal(&signer, handle, member, Some(role))
                .await
                .map_err(|e| not_rotated(&e, repo, member))?,
        )
    } else {
        None
    };
    // after the rotation: the pinned environments saved again, unless changed meanwhile
    let (resaved, exposed_lines) = if removed {
        crate::env::finish_removal(&s, member, &removal).await
    } else {
        (serde_json::Value::Null, String::new())
    };
    ctx.emit(
        json!({
            "status": if removed { "removed" } else { "not_a_member" },
            "member": member,
            "role": shown.as_str(),
            "repo": handle.display(),
            "rotation": rotation.as_ref().map(crate::keys::rotation_json),
            "droppedEpochs": dropped,
            "losingMembers": losing,
            "environments": removal.exposed,
            "resavedEnvironments": resaved,
        }),
        || {
            if !dropped.is_empty() {
                println!(
                    "key epochs {dropped:?} were anchored by {member} and held by no other maintainer: they stop existing (content under them stays unreadable)"
                );
                for m in &losing {
                    println!("  {m} held a key for them and loses that content too");
                }
            }
            if let Some(r) = &rotation {
                crate::keys::print_rotation(handle, r);
            }
            if removed {
                println!("Removed {member} ({shown}) from {}.{exposed_lines}", handle.display());
            } else {
                println!(
                    "{member} is not a {shown} of {}; nothing to remove.",
                    handle.display()
                );
            }
        },
    );
    Ok(())
}

/// What a grant does with the repository's members key (DESIGN §4.1, stream 1F): it keys on the
/// key existing (`has_key`: a private repository, or a public one with members-only content),
/// never on visibility alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyPlan {
    /// Wrap the current key to the member (their new role holds it).
    wrap: bool,
    /// Rotate it away from them (a role change to a role that does not hold it).
    rotate: bool,
}

/// The [`KeyPlan`] of granting `role` (changing from `change_from`) in a repository of
/// `visibility` that has a members key or not.
fn add_plan(
    has_key: bool,
    visibility: Visibility,
    role: Role,
    change_from: Option<Role>,
) -> KeyPlan {
    let holds = |r: Role| holds_members_key(r, visibility);
    KeyPlan {
        wrap: has_key && holds(role),
        rotate: has_key && change_from.is_some_and(holds) && !holds(role),
    }
}

/// Whether removing `role` from a member must rotate the members key (when they keep no other
/// role that holds it, which the caller checks): the repository has one and the role held it.
fn remove_rotates(has_key: bool, visibility: Visibility, role: Role) -> bool {
    has_key && holds_members_key(role, visibility)
}

/// The verbatim §9 warning and the cost of a removal from a repository with a members key:
/// after it, everyone else (the rotator included) gets a wrap, plus an anchor. A public
/// repository's warning names only its members-only content.
fn keyed_remove_prompt(
    kr: &forge_core::keyring::Keyring,
    members: &[forge_core::members::Member],
    handle: &forge_core::scope::RepoRef,
    repo: &str,
    member: &str,
    role: forge_core::rules::v2::Role,
    price: Option<f64>,
) -> String {
    // Writer, triage and reader are one `writer` document: another role is the other type.
    let keeps_other_role = members
        .iter()
        .any(|m| m.identity_id == member && doc_type(m.role) != doc_type(role));
    let remaining = crate::keys::distinct_members(members)
        - usize::from(members.iter().any(|m| m.identity_id == member) && !keeps_other_role);
    let (est, what) = crate::keys::rotation_cost(kr, remaining);
    // Finishing someone else's burn is the recovery path: say whose it is, don't block it.
    let burned = kr
        .burned_by()
        .filter(|(_, by)| *by != *kr.reader())
        .map(|(n, by)| {
            format!(
                "\nKey epoch {n} is burned by {}; this removal's rotation also finishes that burn.",
                forge_core::platform::encode_identifier(by)
            )
        })
        .unwrap_or_default();
    let unreadable = if handle.visibility == Visibility::Private {
        "New pushes, issues and comments"
    } else {
        "New members-only issues, comments and reviews"
    };
    format!(
        "Removing {member} rotates the repo key. {unreadable} will be unreadable to {member}. \
         Everything {member} could already read stays readable to {member} — encryption can't \
         take back what was shared.{burned}\n\
         Remove {member} as a {role} of {repo}? (1 delete + {what}, {})",
        cost_line(est + MEMBER_DOC_ESTIMATE_CREDITS, price)
    )
}

/// Re-anchor every epoch `member` anchored before their maintainer role goes, or refuse.
/// Returns the epochs that stop existing with the removal (§5.3: `member` anchored them, no
/// maintainer who stays holds them, and nothing readable sits above), and the members who stay
/// and lose the content under them.
async fn reanchor(
    signer: &PrivateSigner<'_>,
    handle: &forge_core::scope::RepoRef,
    member: &str,
) -> Result<(Vec<u32>, Vec<String>)> {
    let r = forge_core::keyring::reanchor_before_removal(signer, handle, member)
        .await
        .context(
            "re-anchoring the maintainer's key epochs before the removal (nothing was removed)",
        )?;
    Ok((r.dropped, r.losing))
}

/// The error of a removal whose rotation failed after the delete landed.
fn not_rotated(e: &anyhow::Error, repo: &str, member: &str) -> anyhow::Error {
    let why = forge_core::user_error::classify(
        e.chain(),
        &forge_core::user_error::ErrorContext::default(),
    );
    UserError::new(
        codes::ROTATION_PENDING,
        format!("{member} was removed from {repo}, but the key was not rotated"),
    )
    .cause(format!("{}: {}", why.code, why))
    .fix(format!(
        "run `dg repo keys repair {repo}` (any maintainer can)"
    ))
    .fix(format!("run `dg collab remove {repo} {member}` again"))
    .note(format!(
        "until the key rotates, {member} can still read new content"
    ))
    .into()
}

/// Whether an earlier removal of `member` (not a member now) left its rotation unfinished: the
/// repair check still names them, or the current epoch is burned (the removal's rotation burned
/// it and stopped before the next epoch).
async fn rotation_still_pending(
    signer: &PrivateSigner<'_>,
    repo: &forge_core::scope::RepoRef,
    member: &str,
) -> Result<bool> {
    let member = forge_core::platform::decode_identifier(member)?;
    let kr = signer.keyring(repo).await?;
    Ok(kr
        .resolution()
        .repair
        .as_ref()
        .is_some_and(|r| r.rotate && (r.non_members.is_empty() || r.non_members.contains(&member))))
}

/// Whether `member` (not a member now) still holds the current epoch's key.
async fn still_holds_current_key(
    signer: &PrivateSigner<'_>,
    repo: &forge_core::scope::RepoRef,
    member: &str,
) -> Result<bool> {
    let member = forge_core::platform::decode_identifier(member)?;
    let kr = signer.keyring(repo).await?;
    Ok(kr
        .resolution()
        .repair
        .as_ref()
        .is_some_and(|r| r.rotate && r.non_members.contains(&member)))
}

/// The rotation a removal from a repository with a members key runs (§5.5). The member's
/// deletion must be visible first: a wrap for the new epoch to them would hand back what the
/// removal took (they are excluded explicitly too, whatever a lagging read says). A member
/// still holding another role that holds the key keeps it, so they stay a member and are
/// wrapped like the rest. `removed_role` `None`: a role change to a role that does not hold the
/// key (their document was replaced, not deleted), so they are excluded outright.
async fn rotate_after_removal(
    signer: &PrivateSigner<'_>,
    repo: &forge_core::scope::RepoRef,
    member: &str,
    removed_role: Option<forge_core::rules::v2::Role>,
) -> Result<forge_core::keyring::Rotation> {
    let exclude: Vec<String> = match removed_role {
        None => vec![member.to_string()],
        Some(removed_role) => {
            // Wait until the deleted role document is gone from a proved read (a lagging node
            // would otherwise list them, and the rotation must not wrap to them). `rotate`
            // excludes them explicitly as well, unless they still hold another keyed role.
            let reader = MemberReader::new(signer.client);
            let removed_type = doc_type(removed_role);
            let mut roles = reader.roles_of(repo, member).await?;
            for _ in 0..DELETE_VISIBLE_ATTEMPTS {
                if !roles.iter().any(|m| doc_type(m.role) == removed_type) {
                    break;
                }
                tokio::time::sleep(DELETE_VISIBLE_DELAY).await;
                roles = reader.roles_of(repo, member).await?;
            }
            let keeps_key = roles.iter().any(|m| {
                doc_type(m.role) != removed_type && holds_members_key(m.role, repo.visibility)
            });
            if keeps_key {
                Vec::new()
            } else {
                vec![member.to_string()]
            }
        }
    };
    let first = forge_core::keyring::rotate(signer, repo, &exclude)
        .await
        .context("rotating the repository key after the removal")?;
    // §5.6: a concurrent rotation that won from a stale member list may still have wrapped the
    // removed member; the repair check then says rotate again. Once more settles what this
    // removal changed. Anything else (another maintainer's burned epoch, a missing wrap) is
    // theirs or `dg repo keys repair`'s to pay for, with a confirmation: not spent silently here.
    if !still_holds_current_key(signer, repo, member).await? {
        return Ok(first);
    }
    let report = forge_core::keyring::repair(signer, repo)
        .await
        .context("re-checking the key after the rotation")?;
    Ok(report.rotated.unwrap_or(first))
}

async fn list(ctx: &Ctx, repo: &str) -> Result<()> {
    // Membership is public, a private repository's included: no key is needed to list it.
    let r = Reader::open_unsealed(ctx, repo).await?;
    let (client, handle) = (&r.client, &r.repo);

    let members = MemberReader::new(client)
        .list(handle)
        .await
        .context("listing members")?;
    let rows: Vec<_> = members
        .iter()
        .map(|m| {
            json!({
                "identityId": m.identity_id,
                "role": m.role.as_str(),
                "documentId": m.document_id,
                "id": m.document_id,
                "since": m.created_at,
            })
        })
        .collect();
    // DPNS names for the human list only, read together; a failed read shows the bare id.
    let names = if ctx.json {
        std::collections::BTreeMap::default()
    } else {
        client
            .dpns_first_names(members.iter().map(|m| m.identity_id.as_str()))
            .await
    };
    ctx.emit(
        // `roles: true`: each member's `role` is its real role (maintainer, writer, triage or
        // reader). An older dg listed triage and reader documents as "writer"; a consumer that
        // trusts writers (forge-runner) refuses a list without the marker.
        json!({
            "count": rows.len(),
            "members": rows,
            "ownerId": handle.owner_id(),
            "roles": true,
        }),
        || {
            println!(
                "{} of {}:",
                crate::fmt::plural(members.len(), "member"),
                handle.display()
            );
            // Names and full ids differ in width, so pad the first column to keep roles aligned.
            let shown: Vec<String> = members
                .iter()
                .map(|m| crate::fmt::with_name(&m.identity_id, &names))
                .collect();
            let width = shown.iter().map(|s| s.chars().count()).max().unwrap_or(0);
            for (who, m) in shown.iter().zip(&members) {
                println!("  {who:<width$}  {}", m.role);
            }
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROLES: [Role; 4] = [Role::Maintainer, Role::Writer, Role::Triage, Role::Reader];

    #[test]
    fn a_public_repo_with_members_content_wraps_and_rotates_like_a_private_one() {
        for vis in [Visibility::Private, Visibility::Public] {
            for role in ROLES {
                let holds = holds_members_key(role, vis);
                assert_eq!(
                    add_plan(true, vis, role, None),
                    KeyPlan {
                        wrap: holds,
                        rotate: false
                    },
                    "{vis:?} {role:?}"
                );
                assert_eq!(remove_rotates(true, vis, role), holds, "{vis:?} {role:?}");
            }
        }
        // readers are in the members key (the one named constant)
        assert_eq!(
            add_plan(true, Visibility::Public, Role::Reader, None).wrap,
            forge_core::members::READERS_IN_MEMBERS_KEY
        );
    }

    #[test]
    fn a_public_repo_without_members_content_touches_no_key() {
        for role in ROLES {
            for from in [None, Some(Role::Writer), Some(Role::Reader)] {
                assert_eq!(
                    add_plan(false, Visibility::Public, role, from),
                    KeyPlan {
                        wrap: false,
                        rotate: false
                    }
                );
            }
            assert!(!remove_rotates(false, Visibility::Public, role));
        }
    }

    #[test]
    fn a_role_change_between_key_holding_roles_never_rotates() {
        for vis in [Visibility::Private, Visibility::Public] {
            for (from, to) in [
                (Role::Writer, Role::Reader),
                (Role::Reader, Role::Triage),
                (Role::Triage, Role::Writer),
            ] {
                let plan = add_plan(true, vis, to, Some(from));
                assert_eq!(
                    plan.rotate,
                    holds_members_key(from, vis) && !holds_members_key(to, vis),
                    "{vis:?} {from:?} -> {to:?}"
                );
            }
        }
    }
}
