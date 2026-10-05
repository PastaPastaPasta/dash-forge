//! Long bodies in `dg` (`docs/contracts/forge-v2.md` §6.3): a body, comment, review or set of
//! release notes longer than its field holds (5,120 bytes, less in a private repository) is
//! stored as a repository artifact, and the field keeps its first part and a line naming the
//! artifact. Writers store it on the repository's storage policy (`dash.storage`, as a push
//! reads it), else on Platform; readers fetch and check it. The rule itself is forge-core's
//! (`rules::long_body`, `collab::long_body`).

use anyhow::Result;
use forge_core::collab::long_body::{BodyField, BodyStore};
use forge_core::collab::v2::Collab;
use forge_core::collab::Imported;
use forge_core::rules::v2::{Audience, Visibility};
use forge_core::scope::RepoRef;
use forge_core::storage::policy::git_config_scoped;
use forge_core::storage::{ExternalTarget, StoragePolicy, StorageProfiles, StorageTarget};

/// Where `dg` stores a long body's full text: the repository's storage policy (`dash.storage`
/// and `dash.replicas` in the git config, every scope, as a push reads it), else Platform
/// `chunk` documents, which every reader can fetch.
pub struct BodyTargets {
    external: Vec<ExternalTarget>,
    platform: bool,
    required: usize,
}

impl BodyTargets {
    /// The policy in the git config, opened.
    pub fn resolve() -> Result<Self> {
        let list = git_config_scoped("dash.storage").map(|(_, v)| v);
        let replicas = git_config_scoped("dash.replicas").map(|(_, v)| v);
        let policy = StoragePolicy::from_git_values(list.as_deref(), replicas.as_deref(), None)?;
        if policy.is_platform_only() {
            return Ok(Self {
                external: Vec::new(),
                platform: true,
                required: 1,
            });
        }
        let resolved = policy.resolve(&StorageProfiles::load()?)?;
        // every reader fetches the full text: storage only its owner can read is refused, as
        // for release assets
        crate::storage::check_publishable(
            resolved.external.iter().map(|(n, p)| (n.as_str(), p)),
            None,
            crate::storage::dash_remote_name().as_deref(),
            "the text was not written",
        )?;
        let http = forge_core::storage::http_client();
        let external = resolved
            .external
            .iter()
            .map(|(name, profile)| ExternalTarget::from_profile(name, profile, &http))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(Self {
            external,
            platform: resolved.platform,
            required: resolved.replicas,
        })
    }

    /// As forge-core's writer takes them.
    pub fn store(&self) -> BodyStore<'_> {
        BodyStore {
            external: self
                .external
                .iter()
                .map(|t| t as &dyn StorageTarget)
                .collect(),
            platform: self.platform,
            required: self.required,
        }
    }

    /// Where the text goes, for the confirmation ("Platform", "r2 and Platform").
    pub fn describe(&self) -> String {
        let mut names: Vec<String> = self.external.iter().map(|t| t.name().to_string()).collect();
        if self.platform {
            names.push("Platform".to_string());
        }
        match names.len() {
            0 => "nowhere".to_string(),
            1 => names.remove(0),
            _ => {
                let last = names.pop().unwrap_or_default();
                format!("{} and {last}", names.join(", "))
            }
        }
    }

    /// An upper bound on the credits of storing `bytes` of text in `repo`.
    pub fn credits(&self, repo: &RepoRef, bytes: u64) -> u64 {
        forge_core::cost::push_fees::long_body(
            bytes,
            repo.visibility == Visibility::Private,
            self.external.len() as u64,
            self.platform,
        )
    }
}

/// A text to write into `field`, and where its full text goes when the field cannot hold it.
pub struct Planned<'f> {
    field: BodyField<'f>,
    full: String,
    room: usize,
    /// Who the document carrying it is for: a members-only text has the members-only room and
    /// is never stored where everyone can read it.
    audience: Audience,
    /// The storage, when the text is stored as an artifact.
    targets: Option<BodyTargets>,
}

impl<'f> Planned<'f> {
    /// Plan writing `full` into `field` of `repo`, in a document for `audience`
    /// (`Collab::new_audience`, or the stored document's for an edit): the storage policy is read
    /// only when the text needs an artifact.
    pub fn new(
        repo: &RepoRef,
        field: BodyField<'f>,
        imported: Option<&Imported>,
        full: &str,
        audience: Audience,
    ) -> Result<Self> {
        let room = field.room_for(repo.visibility, audience, imported);
        let targets = forge_core::rules::long_body::needs_artifact(full, room)
            .then(BodyTargets::resolve)
            .transpose()?;
        Ok(Self {
            field,
            full: full.to_string(),
            room,
            audience,
            targets,
        })
    }

    /// The bytes the field itself takes (at most its room), for a quote.
    pub fn field_bytes(&self) -> u64 {
        self.full.len().min(self.room) as u64
    }

    /// What storing the full text adds to the write, in credits (0 when it fits the field).
    pub fn extra_credits(&self, repo: &RepoRef) -> u64 {
        self.targets
            .as_ref()
            .map_or(0, |t| t.credits(repo, self.full.len() as u64))
    }

    /// A clause for the confirmation, or "" when the text fits: "; the text (23,456 bytes) is
    /// stored as a repository artifact on Platform".
    pub fn clause(&self) -> String {
        self.targets.as_ref().map_or_else(String::new, |t| {
            format!(
                "; the text ({} bytes, over the field's {}) is stored as a repository artifact on {}",
                self.full.len(),
                self.room,
                t.describe()
            )
        })
    }

    /// The field a write will carry as a resumable create's journal keys it, known before
    /// anything is stored: the text itself, or its prefix and trailer with any artifact hash
    /// (the journal key leaves the hash out, `rules::long_body::journal_key`).
    pub fn journal_text(&self) -> String {
        if self.targets.is_none() {
            return self.full.clone();
        }
        forge_core::rules::long_body::stored_text(&self.full, self.room, &[0; 32])
            .unwrap_or_else(|| self.full.clone())
    }

    /// The text to write into the field: the text itself, or (after storing the full text)
    /// its first part and the line naming the artifact (never stored where everyone can read it
    /// for a members-only document: core refuses that).
    pub async fn field_text(
        &self,
        collab: &Collab<'_>,
        repo: &RepoRef,
        imported: Option<&Imported>,
    ) -> Result<String> {
        match &self.targets {
            None => Ok(self.full.clone()),
            Some(t) => Ok(collab
                .store_long_body(
                    repo,
                    self.field,
                    imported,
                    &self.full,
                    &t.store(),
                    self.audience,
                )
                .await?),
        }
    }
}

/// The body a private issue's or PR's edit of its other text alone (a new title) writes:
/// its stored long body cut again to the room `field` now leaves (`rules::long_body::refit`),
/// naming the same artifact. `None` when the stored body is kept as it is: a public
/// repository, a body that still fits, or one that cannot (the edit is then refused as before).
pub fn refit_kept(
    repo: &RepoRef,
    field: BodyField<'_>,
    imported: Option<&Imported>,
    stored: &str,
) -> Option<String> {
    if repo.visibility != Visibility::Private {
        return None;
    }
    forge_core::rules::long_body::refit(stored, field.room(repo.visibility, imported))
        .filter(|f| f != stored)
}

/// The line printed under a text of which only the first part could be read.
pub fn partial_line(why: &str) -> String {
    format!("[only the first part is shown: {why}]")
}

/// Read every text in `texts` (each field with no trailer as it is, each continued one fetched
/// and checked; the repository's manifests and members read once) and put it in place of its
/// field; returns, in order, why only the first part of a text could be read (`None` for a
/// whole one).
pub async fn read_in_place(
    collab: &Collab<'_>,
    repo: &RepoRef,
    texts: Vec<&mut String>,
) -> Vec<Option<String>> {
    let reads = {
        let refs: Vec<&str> = texts.iter().map(|t| t.as_str()).collect();
        collab.read_long_bodies(repo, &refs).await
    };
    texts
        .into_iter()
        .zip(reads)
        .map(|(t, r)| {
            *t = r.text().to_string();
            r.incomplete().map(str::to_string)
        })
        .collect()
}
