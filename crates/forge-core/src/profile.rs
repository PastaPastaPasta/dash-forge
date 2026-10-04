//! An identity's public profile: forge-community `profile` (`docs/contracts/forge-v2.md` §2),
//! one per identity (unique `$ownerId`), mutable and deletable.
//!
//! What a profile may hold, and how an edit is normalized, is the shared rule in
//! [`crate::rules::profile`]. A profile is public by design: it is never sealed, and a member of
//! a private repository who reads one learns only what anyone can.

use std::collections::BTreeMap;

use crate::error::Result;
use crate::network::ForgeIds;
use crate::platform::{
    self, FetchedDocument, FieldValue, LoadedIdentity, PlatformClient, QueryFilter, WriteEngine,
};
#[cfg(test)]
use crate::rules::profile::PROFILE_FIELDS;
use crate::rules::profile::{check_profile, profile_problems, ProfileFields, ProfileInput};

/// forge-community: an identity's profile.
pub const DOC_PROFILE: &str = "profile";

/// A stored profile.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profile {
    /// The document id.
    pub id: String,
    /// The identity it describes (its `$ownerId`).
    pub owner: String,
    /// `$revision`.
    pub revision: Option<u64>,
    /// The edited fields, as stored.
    pub fields: ProfileFields,
    /// Signing keys (`gpg:…` / `ssh-…`), for signed-commit badges.
    pub pubkeys: Vec<String>,
}

fn text_field(d: &FetchedDocument, name: &str) -> Option<String> {
    d.fields
        .get(name)
        .and_then(FieldValue::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn list_field(d: &FetchedDocument, name: &str) -> Vec<String> {
    d.fields
        .get(name)
        .and_then(FieldValue::as_text_list)
        .unwrap_or_default()
}

/// A `profile` document, flattened.
pub fn profile_from_doc(d: &FetchedDocument) -> Profile {
    let links = list_field(d, "links");
    Profile {
        id: d.id.clone(),
        owner: d.owner_id.clone(),
        revision: d.revision,
        fields: ProfileFields {
            display_name: text_field(d, "displayName"),
            bio: text_field(d, "bio"),
            avatar_config: text_field(d, "avatarConfig"),
            links: (!links.is_empty()).then_some(links),
            location: text_field(d, "location"),
            company: text_field(d, "company"),
        },
        pubkeys: list_field(d, "pubkeys"),
    }
}

/// The profile of `identity_id` (base58), if it has one (proved either way).
pub async fn read_profile(
    client: &PlatformClient,
    forge: &ForgeIds,
    identity_id: &str,
) -> Result<Option<Profile>> {
    let community = client.fetch_contract(&forge.community).await?;
    let owner = platform::decode_identifier(identity_id)?;
    let docs = client
        .query_documents(
            &community,
            DOC_PROFILE,
            &[QueryFilter::eq("$ownerId", FieldValue::identifier(owner))],
            &[],
            1,
            None,
        )
        .await?;
    Ok(docs.first().map(profile_from_doc))
}

/// The value each edited field ([`crate::rules::profile::PROFILE_FIELDS`]) takes (`None`: the
/// property is removed). Every other stored property, `pubkeys` included, is kept.
fn edited_values(fields: &ProfileFields) -> BTreeMap<String, Option<FieldValue>> {
    let text = |v: &Option<String>| v.as_ref().map(|s| FieldValue::text(s.clone()));
    BTreeMap::from([
        ("displayName".to_string(), text(&fields.display_name)),
        ("bio".to_string(), text(&fields.bio)),
        ("avatarConfig".to_string(), text(&fields.avatar_config)),
        (
            "links".to_string(),
            fields.links.clone().map(FieldValue::text_list),
        ),
        ("location".to_string(), text(&fields.location)),
        ("company".to_string(), text(&fields.company)),
    ])
}

/// Normalize `input` by the shared rule, or every field it breaks with why (nothing signed).
pub fn normalize(input: &ProfileInput) -> std::result::Result<ProfileFields, Vec<String>> {
    match check_profile(input).normalized {
        Some(fields) => Ok(fields),
        None => Err(profile_problems(input)
            .into_iter()
            .map(|(f, why)| format!("{f} {why}"))
            .collect()),
    }
}

/// What [`write_profile`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileWrite {
    /// A new profile document.
    Created(String),
    /// The stored profile, replaced.
    Replaced(String),
    /// The stored profile already held these fields: nothing signed.
    Unchanged(String),
}

/// Set the signer's profile to `fields` (already normalized, [`normalize`]): create it when the
/// identity has none, else replace the edited fields, keeping `pubkeys`. `existing` is the
/// profile the caller read (its revision guards the replace: an edit made elsewhere since is
/// refused, not overwritten).
pub async fn write_profile(
    engine: &WriteEngine<'_>,
    client: &PlatformClient,
    forge: &ForgeIds,
    existing: Option<&Profile>,
    fields: &ProfileFields,
) -> Result<ProfileWrite> {
    let community = client.fetch_contract(&forge.community).await?;
    let values = edited_values(fields);
    match existing {
        None => {
            let props: BTreeMap<String, FieldValue> = values
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k, v)))
                .collect();
            let id = engine
                .create_document(&community, DOC_PROFILE, props)
                .await?;
            Ok(ProfileWrite::Created(id))
        }
        Some(p) => {
            let changed = engine
                .replace_document_guarded(&community, DOC_PROFILE, &p.id, &values, p.revision)
                .await?;
            Ok(if changed {
                ProfileWrite::Replaced(p.id.clone())
            } else {
                ProfileWrite::Unchanged(p.id.clone())
            })
        }
    }
}

/// Delete the signer's profile document `profile` (refunds part of its storage fee).
pub async fn delete_profile(
    engine: &WriteEngine<'_>,
    client: &PlatformClient,
    forge: &ForgeIds,
    profile: &Profile,
) -> Result<()> {
    let community = client.fetch_contract(&forge.community).await?;
    engine
        .delete_document(&community, DOC_PROFILE, &profile.id)
        .await
}

/// A profile write's engine for `identity` (its document-operation key, as every write's).
pub fn engine<'a>(
    client: &'a PlatformClient,
    identity: &'a LoadedIdentity,
    bridge: &'a crate::keystore::BridgeIdentity,
) -> Result<WriteEngine<'a>> {
    crate::collab::doc_engine(client, identity, bridge)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cleared_field_is_removed_and_pubkeys_are_not_touched() {
        let values = edited_values(&ProfileFields {
            display_name: Some("Alice".into()),
            links: Some(vec!["https://alice.dev".into()]),
            ..ProfileFields::default()
        });
        assert!(values.keys().map(String::as_str).eq(PROFILE_FIELDS
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()));
        assert!(values["bio"].is_none(), "an unset field is removed");
        assert_eq!(
            values["displayName"],
            Some(FieldValue::text("Alice")),
            "a set field is written"
        );
        assert!(!values.contains_key("pubkeys"));
    }

    #[test]
    fn normalize_reports_every_bad_field() {
        let e = normalize(&ProfileInput {
            display_name: Some("x".repeat(61)),
            links: Some(vec!["http://a.dev".into()]),
            ..ProfileInput::default()
        })
        .unwrap_err();
        assert_eq!(e.len(), 2);
        assert!(
            e[0].starts_with("displayName") && e[1].starts_with("links"),
            "{e:?}"
        );
    }
}
