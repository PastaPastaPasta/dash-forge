//! TEST FIXTURE ONLY: write and read members-only content in a public repository through
//! forge-core's own writers and readers (`docs/security/private-repos.md` §17), before `dg`
//! has `--members` flags (phase-1 stream 1E). For live QA.
//!
//! ```text
//! DASH_FORGE_NETWORK=devnet DASH_FORGE_DEVNET_NAME=sakura \
//!   cargo run -p forge-core --example members_only -- <command> …
//!
//!   issue    <identity file> <repo id> <title> <body>       a members-only issue
//!   comment  <identity file> <repo id> <issue #> <body> [public]
//!                                                           a comment (default: members-only)
//!   review   <identity file> <repo id> <pr #> approve|changes <body>
//!                                                           a members-only review on the head
//!   read     <identity file|-> <repo id> <issue #>          the issue (or its placeholder) and
//!                                                           its comments as this reader sees them
//!   approvals <identity file|-> <repo id> <pr #>            the PR's approvals as this reader counts them
//! ```
//!
//! `-` reads anonymously. Prints what it did or read; never prints key material.

use forge_core::collab::v2::{Collab, TargetKind, TargetRead};
use forge_core::keystore::BridgeIdentity;
use forge_core::platform::PlatformClient;
use forge_core::rules::v2::Audience;
use forge_core::rules::Verdict;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[tokio::main]
#[allow(clippy::too_many_lines)] // one command per arm, side by side
async fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cmd, identity, repo_id, rest) = match args.as_slice() {
        [cmd, identity, repo_id, rest @ ..] => (cmd.as_str(), identity, repo_id, rest),
        _ => return Err("usage: members_only <issue|comment|review|read|approvals> <identity file|-> <repo id> …".into()),
    };
    let target = forge_core::network::NetworkSettings::from_env().resolve()?;
    let client = PlatformClient::connect(target).await?;
    let repo = forge_core::resolve::resolve_id(&client, repo_id).await?;
    let signer = if identity == "-" {
        None
    } else {
        let bridge = BridgeIdentity::load_from_file(identity)?;
        let loaded = client.fetch_identity(&bridge.identity_id).await?;
        Some((bridge, loaded))
    };
    let collab = match &signer {
        Some((bridge, loaded)) => Collab::new(&client, loaded, bridge),
        None => Collab::reader(&client),
    };
    let number = |s: &String| s.parse::<u32>().map_err(|e| format!("not a number: {e}"));
    match (cmd, rest) {
        ("issue", [title, body]) => {
            collab.request_audience(Some(Audience::Members));
            let dir = std::env::temp_dir().join("members-only-fixture-journal");
            let c = collab.create_issue(&repo, title, body, &dir).await?;
            println!("members-only issue #{} {}", c.number, c.document_id);
        }
        ("comment", [n, body, aud @ ..]) => {
            let audience = match aud.first().map(String::as_str) {
                Some("public") => Audience::Public,
                _ => Audience::Members,
            };
            collab.request_audience(Some(audience));
            let issue = collab
                .issue(&repo, number(n)?)
                .await?
                .ok_or("no such issue")?;
            let id = collab
                .comment(&repo, &issue.document_id, body, None, None)
                .await?;
            println!("{audience:?} comment {id} on #{n}");
        }
        ("review", [n, verdict, body]) => {
            collab.request_audience(Some(Audience::Members));
            let p = collab.patch(&repo, number(n)?).await?.ok_or("no such PR")?;
            let view = collab.patch_view(&repo, p).await?;
            let v = match verdict.as_str() {
                "approve" => Verdict::Approve,
                "changes" => Verdict::RequestChanges,
                _ => Verdict::Comment,
            };
            let head = hex::decode(&view.head)?;
            let id = collab
                .review(&repo, &view.patch.document_id, v, &head, body, None, None)
                .await?;
            println!(
                "members-only review {id} ({verdict}) on #{n} at {}",
                view.head
            );
        }
        ("read", [n]) => {
            match collab
                .target_read(&repo, TargetKind::Issue, number(n)?)
                .await?
            {
                None => println!("#{n}: no such issue"),
                Some(TargetRead::MembersOnly(m)) => println!(
                    "#{n} · members-only issue by {} (asMember: {}, why: {:?})",
                    m.author, m.as_member, m.why
                ),
                Some(TargetRead::Readable(d)) => println!(
                    "#{n} {:?} (sealed: {})",
                    d.field_str("title").unwrap_or_default(),
                    d.field_bytes("enc").is_some_and(|e| !e.is_empty())
                ),
            }
            let id = match collab
                .target_read(&repo, TargetKind::Issue, number(n)?)
                .await?
            {
                Some(TargetRead::Readable(d)) => d.id,
                Some(TargetRead::MembersOnly(m)) => m.document_id,
                None => return Ok(()),
            };
            let (shown, members_only, malformed) = collab.comments_read(&repo, &id).await?;
            for c in &shown {
                println!("  comment {} by {}: {:?}", c.document_id, c.author, c.body);
            }
            for m in &members_only {
                println!(
                    "  members-only comment {} by {} (asMember: {}, why: {:?})",
                    m.document_id, m.author, m.as_member, m.why
                );
            }
            println!(
                "  {} readable, {} members-only, {malformed} malformed",
                shown.len(),
                members_only.len()
            );
        }
        ("approvals", [n]) => {
            let p = collab.patch(&repo, number(n)?).await?.ok_or("no such PR")?;
            let view = collab.patch_view(&repo, p).await?;
            let (a, reviews) = collab.approvals(&repo, &view).await?;
            for r in &reviews {
                println!(
                    "  review {} by {} {:?} members_only={} body={:?}",
                    r.document_id, r.reviewer, r.verdict, r.members_only, r.body
                );
            }
            println!(
                "approvers {:?} changes {:?}",
                a.approvers, a.changes_requested
            );
        }
        _ => return Err("bad arguments (see the file's header)".into()),
    }
    Ok(())
}
