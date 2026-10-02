//! `dg profile` — an identity's public profile (forge-community `profile`, one per identity):
//! display name, bio, avatar, links, location and company. Everything in it is public, private
//! repositories' members included: it is never encrypted.

use anyhow::Result;
use serde_json::{json, Value};

use crate::context::Ctx;
use crate::fmt::{cost_json, cost_line, safe};
use crate::ProfileCommand;
use forge_core::platform::PlatformClient;
use forge_core::profile::{self as core_profile, ProfileWrite};
use forge_core::rules::profile::{avatar_spec, AvatarSpec, ProfileFields, ProfileInput};
use forge_core::user_error::{codes, UserError};

/// Dispatch a `profile` subcommand.
pub async fn run(ctx: &Ctx, cmd: &ProfileCommand) -> Result<()> {
    match cmd {
        ProfileCommand::Show { who } => show(ctx, who.as_deref()).await,
        ProfileCommand::Set(args) => set(ctx, args).await,
        ProfileCommand::Delete => delete(ctx).await,
        ProfileCommand::Key(cmd) => crate::signing::run_key(ctx, cmd).await,
    }
}

/// `who` (an identity id, a DPNS name, `@name` or `me`), as a base58 identity id; `me` (and
/// nothing) is the configured identity.
async fn identity_of(ctx: &Ctx, client: &PlatformClient, who: Option<&str>) -> Result<String> {
    let me = || match ctx.identity_id_hint() {
        Some(id) => Ok(id),
        None => Ok(ctx.load_bridge()?.identity_id),
    };
    crate::issue::identity_arg(client, me, who.unwrap_or("me")).await
}

fn fields_json(f: &ProfileFields) -> Value {
    serde_json::to_value(f).unwrap_or(Value::Null)
}

/// How the avatar is drawn, in words.
fn avatar_words(config: Option<&str>, identity: &str) -> String {
    match avatar_spec(config, identity) {
        AvatarSpec::Default => "the default (an initial on a colour)".into(),
        AvatarSpec::Identicon { seed } if seed == identity => {
            "a pattern from the identity id".into()
        }
        AvatarSpec::Identicon { seed } => format!("a pattern from {:?}", safe(&seed)),
        AvatarSpec::Url { url } => {
            format!("an image at {} (loaded when a viewer asks)", safe(&url))
        }
        AvatarSpec::Invalid => format!(
            "the default ({:?} is not a convention Forge reads)",
            safe(config.unwrap_or_default())
        ),
    }
}

async fn show(ctx: &Ctx, who: Option<&str>) -> Result<()> {
    let client = ctx.connect().await?;
    let forge = ctx.target.require_v2()?;
    let id = identity_of(ctx, &client, who).await?;
    let profile = core_profile::read_profile(&client, forge, &id).await?;
    ctx.emit(
        json!({
            "identityId": id,
            "profile": profile.as_ref().map(|p| json!({
                "documentId": p.id,
                "revision": p.revision,
                "fields": fields_json(&p.fields),
                "avatar": serde_json::to_value(avatar_spec(p.fields.avatar_config.as_deref(), &id)).unwrap_or(Value::Null),
                "pubkeys": p.pubkeys,
            })),
        }),
        || {
            let Some(p) = &profile else {
                println!("{id} has no profile on this network");
                if who.is_none() {
                    println!("  `dg profile set --name <name> --bio <text>` writes one (public)");
                }
                return;
            };
            let f = &p.fields;
            let line = |label: &str, v: &Option<String>| {
                if let Some(v) = v {
                    println!("{label:<10} {}", safe(v));
                }
            };
            println!("identity   {id}");
            line("name", &f.display_name);
            line("company", &f.company);
            line("location", &f.location);
            for l in f.links.iter().flatten() {
                println!("link       {}", safe(l));
            }
            println!("avatar     {}", avatar_words(f.avatar_config.as_deref(), &id));
            for k in &p.pubkeys {
                println!("key        {}", crate::signing::describe(k));
            }
            if let Some(bio) = &f.bio {
                println!();
                for l in bio.lines() {
                    println!("  {}", safe(l));
                }
            }
        },
    );
    Ok(())
}

/// `dg profile set` arguments: each given flag replaces its field, an empty value clears it, and
/// a field not given is kept.
#[derive(Debug, clap::Args)]
pub struct SetArgs {
    /// Display name (at most 60 characters; "" clears it).
    #[arg(long = "name", value_name = "NAME")]
    pub display_name: Option<String>,
    /// Bio (at most 500 characters; line breaks are kept; "" clears it).
    #[arg(long, conflicts_with = "bio_file")]
    pub bio: Option<String>,
    /// Read the bio from a file (`-` for stdin).
    #[arg(long, value_name = "PATH")]
    pub bio_file: Option<std::path::PathBuf>,
    /// Company or organization (at most 60 characters; "" clears it).
    #[arg(long)]
    pub company: Option<String>,
    /// Location (at most 60 characters; "" clears it).
    #[arg(long)]
    pub location: Option<String>,
    /// A link (https only); repeat for up to four. Replaces every stored link.
    #[arg(long = "link", value_name = "URL", conflicts_with = "clear_links")]
    pub links: Vec<String>,
    /// Remove every link.
    #[arg(long)]
    pub clear_links: bool,
    /// Avatar: `identicon` (a pattern drawn from your identity id), `identicon:<seed>`, an
    /// https image URL (viewers load it only when they ask), or "" for the default.
    #[arg(long, value_name = "CONFIG")]
    pub avatar: Option<String>,
}

impl SetArgs {
    fn bio(&self) -> Result<Option<String>> {
        match &self.bio_file {
            None => Ok(self.bio.clone()),
            Some(p) if p.as_os_str() == "-" => {
                let mut s = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
                Ok(Some(s))
            }
            Some(p) => Ok(Some(std::fs::read_to_string(p).map_err(|e| {
                crate::errors::usage(format!("reading the bio from {}: {e}", p.display()))
            })?)),
        }
    }

    /// The edit over `stored`: every given flag replaces its field.
    fn input(&self, stored: &ProfileFields) -> Result<ProfileInput> {
        let pick = |given: &Option<String>, kept: &Option<String>| given.clone().or(kept.clone());
        let links = if self.clear_links {
            Some(Vec::new())
        } else if self.links.is_empty() {
            stored.links.clone()
        } else {
            Some(self.links.clone())
        };
        Ok(ProfileInput {
            display_name: pick(&self.display_name, &stored.display_name),
            bio: pick(&self.bio()?, &stored.bio),
            avatar_config: pick(&self.avatar, &stored.avatar_config),
            links,
            location: pick(&self.location, &stored.location),
            company: pick(&self.company, &stored.company),
        })
    }

    fn is_empty(&self) -> bool {
        self.display_name.is_none()
            && self.bio.is_none()
            && self.bio_file.is_none()
            && self.company.is_none()
            && self.location.is_none()
            && self.links.is_empty()
            && !self.clear_links
            && self.avatar.is_none()
    }
}

/// The text bytes a profile stores (what its cost grows with).
fn text_bytes(f: &ProfileFields) -> u64 {
    let s = |v: &Option<String>| v.as_ref().map_or(0, String::len);
    (s(&f.display_name)
        + s(&f.bio)
        + s(&f.avatar_config)
        + s(&f.location)
        + s(&f.company)
        + f.links.iter().flatten().map(String::len).sum::<usize>()) as u64
}

/// E201 naming every field the shared rule refuses (`problems`), before anything is signed.
fn refusal(why: &[String]) -> anyhow::Error {
    UserError::new(codes::USAGE, "the profile breaks its rules")
        .cause(why.join("; "))
        .fix("see `dg profile set --help` for each field's limits")
        .note("checked before anything was signed; nothing was written or paid")
        .into()
}

async fn set(ctx: &Ctx, args: &SetArgs) -> Result<()> {
    if args.is_empty() {
        return Err(crate::errors::usage(
            "name a field to set: --name, --bio, --bio-file, --company, --location, --link, --clear-links or --avatar",
        ));
    }
    // A bio read from stdin leaves no stdin for the prompt: it needs --yes. Either way, a run
    // that cannot confirm stops here, before anything is read.
    if args
        .bio_file
        .as_deref()
        .is_some_and(|p| p.as_os_str() == "-")
        && !ctx.yes
    {
        return Err(crate::errors::usage(
            "--bio-file - reads the bio from stdin, which then can't answer the confirmation: pass --yes",
        ));
    }
    ctx.require_confirmable("dg profile set")?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let forge = ctx.target.require_v2()?;
    let me = identity.id();
    let stored = core_profile::read_profile(&client, forge, &me).await?;
    let none = ProfileFields::default();
    let input = args.input(stored.as_ref().map_or(&none, |p| &p.fields))?;
    let fields = core_profile::normalize(&input).map_err(|why| refusal(&why))?;
    if stored.is_none() && fields == ProfileFields::default() {
        return Err(crate::errors::usage(
            "there is nothing to write: you have no profile, and every field given is empty",
        ));
    }
    if stored.as_ref().is_some_and(|p| p.fields == fields) {
        ctx.emit(
            json!({"status": "unchanged", "fields": fields_json(&fields)}),
            || {
                println!("profile unchanged (it already holds these fields)");
            },
        );
        return Ok(());
    }
    let price = ctx.usd_price();
    let quote = match &stored {
        None => crate::quote::profile(text_bytes(&fields)),
        Some(_) => crate::quote::replace(text_bytes(&fields)),
    };
    ctx.confirm_or_cancel(&format!(
        "{} your public profile? ({}; anyone can read it, members of your private repositories included)",
        if stored.is_none() { "Create" } else { "Update" },
        cost_line(quote, price)
    ))?;
    let engine = core_profile::engine(&client, &identity, &bridge)?;
    let before = client.get_balance(&me).await.unwrap_or(0);
    let wrote =
        core_profile::write_profile(&engine, &client, forge, stored.as_ref(), &fields).await?;
    let spent = crate::common::spent_since(&client, &me, before).await;
    let (status, id) = match &wrote {
        ProfileWrite::Created(id) => ("created", id),
        ProfileWrite::Replaced(id) => ("updated", id),
        ProfileWrite::Unchanged(id) => ("unchanged", id),
    };
    ctx.emit(
        json!({
            "status": status,
            "documentId": id,
            "fields": fields_json(&fields),
            "cost": cost_json(spent, price),
        }),
        || println!("✓ profile {status} · {}", cost_line(spent, price)),
    );
    Ok(())
}

async fn delete(ctx: &Ctx) -> Result<()> {
    ctx.require_confirmable("dg profile delete")?;
    let (client, bridge, identity) = ctx.connect_with_identity().await?;
    let forge = ctx.target.require_v2()?;
    let me = identity.id();
    let Some(stored) = core_profile::read_profile(&client, forge, &me).await? else {
        ctx.emit(json!({"status": "absent"}), || {
            println!("you have no profile on this network");
        });
        return Ok(());
    };
    ctx.confirm_or_cancel(
        "Delete your profile (display name, bio, avatar, links and signing keys)? Part of its storage fee is refunded.",
    )?;
    let engine = core_profile::engine(&client, &identity, &bridge)?;
    core_profile::delete_profile(&engine, &client, forge, &stored).await?;
    ctx.emit(
        json!({"status": "deleted", "documentId": stored.id}),
        || {
            println!("✓ profile deleted");
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> SetArgs {
        SetArgs {
            display_name: None,
            bio: None,
            bio_file: None,
            company: None,
            location: None,
            links: vec![],
            clear_links: false,
            avatar: None,
        }
    }

    #[test]
    fn unset_flags_keep_the_stored_fields_and_empty_clears() {
        let stored = ProfileFields {
            display_name: Some("Alice".into()),
            company: Some("Acme".into()),
            links: Some(vec!["https://alice.dev".into()]),
            ..ProfileFields::default()
        };
        let a = SetArgs {
            company: Some(String::new()),
            location: Some("Lisbon".into()),
            ..args()
        };
        let f = core_profile::normalize(&a.input(&stored).unwrap()).unwrap();
        assert_eq!(f.display_name.as_deref(), Some("Alice"));
        assert_eq!(f.company, None, "an empty value clears");
        assert_eq!(f.location.as_deref(), Some("Lisbon"));
        assert_eq!(f.links, Some(vec!["https://alice.dev".into()]));

        let cleared = SetArgs {
            clear_links: true,
            ..args()
        };
        let f = core_profile::normalize(&cleared.input(&stored).unwrap()).unwrap();
        assert_eq!(f.links, None);
    }

    #[test]
    fn nothing_to_set_is_empty() {
        assert!(args().is_empty());
        assert!(!SetArgs {
            clear_links: true,
            ..args()
        }
        .is_empty());
    }
}
