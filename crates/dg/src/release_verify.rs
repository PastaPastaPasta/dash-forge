//! `dg release verify <repo> <tag>` (epic E5): whether a release's tag and assets are what was
//! first published, from the chain ([`forge_core::rules::provenance`]), and the tag's signature
//! when this directory's git holds the tag object. Exits with E504 when the tag moved, was
//! deleted or races, or the assets changed since the first publish, so a script can stop before
//! it installs from the tag.

use anyhow::{bail, Result};
use serde_json::json;

use forge_core::collab::Release;
use forge_core::rules::provenance::{
    release_provenance, ProvenanceAsset, ProvenanceRevision, ReleaseProvenance, TagVerdict,
};
use forge_core::rules::signature::{verify_tag_signature, SignatureVerdict};
use forge_core::user_error::{codes, UserError};

use crate::common::Reader;
use crate::context::Ctx;
use crate::fmt::{safe, short};

/// The tag's signature as this directory's git sees it.
enum LocalSignature {
    /// The tag object is here and carries a signature.
    Signed(SignatureVerdict),
    /// An annotated tag without a signature.
    Unsigned,
    /// The tag names a commit directly: a lightweight tag has no signature.
    Lightweight,
    /// The object is not in this directory's git (or this is no git repository).
    NotHere,
}

impl LocalSignature {
    fn json(&self) -> serde_json::Value {
        match self {
            Self::Signed(v) => json!({"state": "signed", "verdict": v}),
            Self::Unsigned => json!({"state": "unsigned"}),
            Self::Lightweight => json!({"state": "lightweight"}),
            Self::NotHere => json!({"state": "not-checked"}),
        }
    }
}

/// Every revision of `tag`'s release, and the target its first published revision records.
fn revisions_of(all: &[&Release]) -> (Vec<ProvenanceRevision>, Option<String>) {
    let revisions = all
        .iter()
        .map(|r| ProvenanceRevision {
            id: r.document_id.clone(),
            created_at: r.created_at,
            delta: if r.is_unpublish() { -1 } else { r.delta },
            publisher: r.publisher.clone(),
            // A sealed revision's assets are in its encrypted list: no change is claimed for them.
            assets: if r.sealed.is_some() {
                Vec::new()
            } else {
                r.assets
                    .iter()
                    .map(|a| ProvenanceAsset {
                        name: a.name.clone(),
                        sha256: a.sha256.clone(),
                    })
                    .collect()
            },
        })
        .collect();
    let first = all
        .iter()
        .filter(|r| !r.is_unpublish())
        .min_by(|a, b| (a.created_at, &a.document_id).cmp(&(b.created_at, &b.document_id)));
    let pin = first
        .and_then(|r| r.sealed.as_ref())
        .and_then(|s| s.fields.target_oid.clone());
    (revisions, pin)
}

/// The object `oid` in this directory's git: its signature, or why there is none to check.
fn local_signature(oid: &str, signers: &[forge_core::rules::signature::Signer]) -> LocalSignature {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| o.stdout)
    };
    match git(&["cat-file", "-t", oid])
        .as_deref()
        .map(<[u8]>::trim_ascii)
    {
        Some(b"tag") => match git(&["cat-file", "tag", oid]) {
            Some(raw) => verify_tag_signature(&raw, signers)
                .map_or(LocalSignature::Unsigned, LocalSignature::Signed),
            None => LocalSignature::NotHere,
        },
        Some(b"commit") => LocalSignature::Lightweight,
        _ => LocalSignature::NotHere,
    }
}

/// What the tag's verdict means, in a sentence.
fn headline(p: &ReleaseProvenance, tag: &str) -> String {
    match p.tag {
        TagVerdict::Unchanged => {
            format!("{tag} points where it did when the release was published")
        }
        TagVerdict::Restored => {
            format!("{tag} was moved after the release was published, then moved back")
        }
        TagVerdict::Moved if p.pinned_by == "release" => {
            format!("{tag} no longer points at the commit the release records")
        }
        TagVerdict::Moved => format!("{tag} was moved after the release was published"),
        TagVerdict::Deleted => format!("{tag} was deleted after the release was published"),
        TagVerdict::Diverged => format!("two pushes race on {tag}: it points at no single commit"),
        TagVerdict::Missing => format!("no tag named {tag} was ever pushed"),
    }
}

fn when(ms: u64) -> String {
    forge_import::github::unix_to_iso8601(ms / 1000)
        .trim_end_matches('Z')
        .replacen('T', " ", 1)
        + " UTC"
}

fn print_human(p: &ReleaseProvenance, tag: &str, repo: &str, sig: &LocalSignature) {
    println!(
        "{} {}: {}",
        if p.altered() { "✗" } else { "✓" },
        safe(tag),
        headline(p, &safe(tag))
    );
    println!("  repository  {}", safe(repo));
    if let Some(pb) = &p.published {
        println!("  published   {} by {}", when(pb.at), pb.by);
    }
    if let Some(b) = &p.baseline {
        if p.pinned_by == "release" {
            println!("  recorded    {} (the release's own record)", short(&b.oid));
        } else {
            println!(
                "  {:<11} {} pushed by {} at {}",
                if p.late_tag {
                    "first push"
                } else {
                    "at publish"
                },
                short(&b.oid),
                b.by,
                when(b.at)
            );
        }
    }
    if let Some(c) = &p.current {
        println!(
            "  now         {} pushed by {} at {}",
            short(&c.oid),
            c.by,
            when(c.at)
        );
    }
    for m in &p.moves {
        match &m.to {
            Some(to) => println!("  moved       {} by {} to {}", when(m.at), m.by, short(to)),
            None => println!("  deleted     {} by {}", when(m.at), m.by),
        }
    }
    let a = &p.assets;
    for (word, names) in [
        ("replaced", &a.replaced),
        ("added", &a.added),
        ("removed", &a.removed),
    ] {
        if !names.is_empty() {
            println!(
                "  assets      {word} since the first publish: {}",
                names
                    .iter()
                    .map(|n| safe(n).into_owned())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
    match sig {
        LocalSignature::Signed(v) => println!(
            "  signature   {}",
            crate::signing::verdict_words(v, &|id: &str| safe(id).into_owned())
        ),
        LocalSignature::Unsigned => println!("  signature   none: the tag is not signed"),
        LocalSignature::Lightweight => {
            println!("  signature   none: a lightweight tag has no signature");
        }
        LocalSignature::NotHere => println!(
            "  signature   not checked: this directory's git has no copy of the tag (run it in a clone after `git fetch --tags`)"
        ),
    }
}

/// `dg release verify <repo> <tag>`.
pub async fn verify(ctx: &Ctx, repo: &str, tag: &str) -> Result<()> {
    let s = Reader::open(ctx, repo).await?;
    let list = s.collab().releases(&s.repo).await?;
    let all: Vec<&Release> = list
        .current
        .iter()
        .chain(&list.previous)
        .filter(|r| r.tag_name == tag)
        .collect();
    if all.is_empty() {
        bail!(UserError::new(
            codes::USAGE,
            format!("no release of {tag} in {}", s.repo.display())
        )
        .fix(format!("`dg release list {repo}` lists the releases")));
    }
    let (revisions, pin) = revisions_of(&all);
    let ref_name = format!("refs/tags/{tag}");
    let (hash, updates, configs) = s.service().ref_history(&s.repo, &ref_name).await?;
    let p = release_provenance(&hash, &updates, &configs, &revisions, pin.as_deref());
    let sig = match &p.current {
        Some(c) => {
            let signers = forge_core::signing_keys::repo_signers(&s.client, &s.repo, &[]).await?;
            local_signature(&c.oid, &signers)
        }
        None => LocalSignature::NotHere,
    };
    let display = s.repo.display();
    ctx.emit(
        json!({
            "repo": display,
            "tag": tag,
            "altered": p.altered(),
            "provenance": p,
            "signature": sig.json(),
        }),
        || print_human(&p, tag, &display, &sig),
    );
    if p.altered() {
        bail!(UserError::new(
            codes::INTEGRITY,
            format!("{tag} changed since its release was published")
        )
        .cause(headline(&p, tag))
        .fix("ask the repository's maintainers which commit and files the release should name before installing from it"));
    }
    Ok(())
}
