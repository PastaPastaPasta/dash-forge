//! Shared command helpers: `owner/name` parsing and repo resolution.

use anyhow::{Context as _, Result};

use forge_core::platform::{LoadedIdentity, PlatformClient};
use forge_core::rules::v2::Visibility;
use forge_core::scope::RepoRef as Repo;
use forge_core::user_error::{codes, UserError};

/// A parsed `owner/name` (or bare `name`) repository reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    /// The owner: a base58 identity id or a DPNS name (`alice`, `alice.dash`), resolved by
    /// `forge_core::resolve::resolve_owner`. `None` when the caller passed a bare `name` and
    /// the signing identity should be used.
    pub owner: Option<String>,
    /// The repository name.
    pub name: String,
}

impl RepoRef {
    /// Parse an `owner/name` reference, or a bare `name` (owner defaults to the signing
    /// identity). The owner is a base58 identity id or a DPNS name; anything else is
    /// rejected with an actionable message.
    pub fn parse(s: &str) -> Result<Self> {
        let Some((owner, name)) = s.split_once('/') else {
            if s.is_empty() {
                return Err(invalid_ref(s, "the repository reference is empty"));
            }
            return Ok(Self {
                owner: None,
                name: s.to_string(),
            });
        };
        if owner.is_empty() || name.is_empty() {
            return Err(invalid_ref(s, "expected `owner/name`"));
        }
        // `a/b/c` is a malformed reference (E203), not a bad name `b/c` (E202, QW-082).
        if name.contains('/') {
            return Err(invalid_ref(s, "expected `owner/name`, with one `/`"));
        }
        // `@alice/project`: the `@` people type before a username (QW2-082), as the
        // identity arguments already take it.
        let owner = owner.strip_prefix('@').unwrap_or(owner);
        if !looks_like_identity_id(owner) && forge_core::resolve::dpns_label(owner).is_none() {
            return Err(invalid_ref(
                s,
                &format!("owner {owner:?} is neither a base58 identity id nor a DPNS name"),
            ));
        }
        Ok(Self {
            owner: Some(owner.to_string()),
            name: name.to_string(),
        })
    }

    /// The repo id, when the reference is a bare base58 id (a forge-v2 repo document id, as
    /// `dash://<id>` takes). Repo names are lowercase, so a base58 id — which mixes cases —
    /// can never be mistaken for one.
    pub fn repo_id(&self) -> Option<&str> {
        (self.owner.is_none()
            && looks_like_identity_id(&self.name)
            && self.name.chars().any(|c| c.is_ascii_uppercase()))
        .then_some(self.name.as_str())
    }
}

/// E606: `action` refused because `repo` is archived.
pub fn archived_refusal(repo: &str, action: &str) -> UserError {
    UserError::new(codes::ARCHIVED, format!("{action}: {repo} is archived"))
        .cause("a maintainer marked the repository archived (read-only by agreement)")
        .fix(format!(
            "ask a maintainer to run `dg repo unarchive {repo}`"
        ))
        .fix("pass --allow-archived (Forge apps enforce archiving, not Platform)")
        .note("checked before anything was signed; nothing was written or paid")
}

/// E203 for an unusable `owner/name`.
fn invalid_ref(input: &str, why: &str) -> anyhow::Error {
    UserError::new(
        codes::INVALID_REPO_REF,
        format!("invalid repository reference {input:?}"),
    )
    .cause(why)
    .fix("use `<owner>/<name>` with the owner's identity id or DPNS name, e.g. `alice/project`, `@alice/project` or `8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB/project`, a bare `<name>` for your own repositories, or the repo's id")
    .into()
}

/// Refuse a `what` argument (a comment, review or thread id) that cannot be a document id,
/// before any read: E201 naming the argument and where the ids are listed (`listed_by`).
/// Before, `dg issue delete-comment <repo> 2` was E204 "invalid configuration" with a raw
/// "Identifier must be 32 bytes long" (QW2-076).
pub fn document_id_arg(value: &str, what: &str, listed_by: &str) -> Result<()> {
    if looks_like_identity_id(value) {
        return Ok(());
    }
    Err(UserError::new(
        codes::USAGE,
        format!("{:?} is not a {what}", crate::fmt::safe(value)),
    )
    .cause(format!(
        "a {what} is a document id (about 44 base58 characters), not a number"
    ))
    .fix(format!("{listed_by} lists the ids"))
    .into())
}

/// Whether `s` is plausibly a base58 identity id (32-byte id ≈ 42-44 base58 chars, no
/// `0OIl` and no `/`). Used to distinguish an identity owner from a DPNS label.
fn looks_like_identity_id(s: &str) -> bool {
    forge_core::resolve::looks_like_identity_id(s)
}

/// Resolve a [`RepoRef`]: a bare id as a repo document id; otherwise `owner/name`.
pub async fn resolve(
    client: &PlatformClient,
    identity: &LoadedIdentity,
    repo_ref: &RepoRef,
) -> Result<Repo> {
    resolve_for(client, Some(&identity.id()), repo_ref).await
}

/// [`resolve`] for a command that may run without an identity: a bare `name` needs
/// `default_owner` (the signer), else it is a usage error.
pub async fn resolve_for(
    client: &PlatformClient,
    default_owner: Option<&str>,
    repo_ref: &RepoRef,
) -> Result<Repo> {
    if let Some(id) = repo_ref.repo_id() {
        return forge_core::resolve::resolve_id(client, id)
            .await
            .with_context(|| format!("resolving repo {id}"));
    }
    let owner = repo_ref
        .owner
        .as_deref()
        .or(default_owner)
        .ok_or_else(|| crate::errors::usage("name the repository as `<owner>/<name>`"))?
        .to_string();
    // `with_context`, not a flattened message: the typed forge-core error must survive for
    // the error renderer (NotFound → E102, a network failure → E701).
    let repo = forge_core::resolve::resolve_named(client, &owner, &repo_ref.name)
        .await
        .with_context(|| format!("resolving {owner}/{}", repo_ref.name))?;
    // QW4-013: a name this clone pinned to another repository is refused before anything is
    // read from or written to it, as `git fetch` refuses it (E504).
    crate::pin::check(
        &owner,
        &repo_ref.name,
        &client.target().network.key(),
        &repo,
    )?;
    Ok(repo)
}

/// A connected signer and the repository a command acts on.
pub struct Session {
    /// The connection.
    pub client: PlatformClient,
    /// The signing key material.
    pub bridge: forge_core::keystore::BridgeIdentity,
    /// The signing identity.
    pub identity: LoadedIdentity,
    /// The resolved repository.
    pub repo: Repo,
}

/// The one-line note a command prints (to stderr) for a public repository a maintainer marked as
/// moved (`config.movedTo`): where it went, by name when the new repository resolves. Nothing is
/// redirected: the command still acts on `repo`.
pub async fn note_moved(client: &PlatformClient, repo: &Repo, moved_to: Option<&str>) {
    let Some(id) = moved_to.filter(|id| *id != repo.repo_id) else {
        return;
    };
    let to = forge_core::resolve::resolve_id(client, id)
        .await
        .map_or_else(|_| id.to_string(), |r| r.display());
    eprintln!("{}", moved_note(&repo.display(), &to));
}

/// The text of [`note_moved`].
pub fn moved_note(from: &str, to: &str) -> String {
    format!(
        "note: {} has moved to {} (this command still uses {})",
        crate::fmt::safe(from),
        crate::fmt::safe(to),
        crate::fmt::safe(from)
    )
}

impl Session {
    /// Parse `repo`, connect, fetch the signer and resolve the repository.
    pub async fn open(ctx: &crate::context::Ctx, repo: &str) -> Result<Self> {
        let repo_ref = RepoRef::parse(repo)?;
        let (client, bridge, identity) = ctx.connect_with_identity().await?;
        let repo = resolve(&client, &identity, &repo_ref).await?;
        Ok(Self {
            client,
            bridge,
            identity,
            repo,
        })
    }

    /// [`Self::open`] for a write to the repository: refused with E606 when it is archived
    /// ([`Self::refuse_if_archived`]; `action` names what was not done).
    pub async fn open_for_write(
        ctx: &crate::context::Ctx,
        repo: &str,
        action: &str,
    ) -> Result<Self> {
        let s = Self::open(ctx, repo).await?;
        s.refuse_if_archived(ctx, action).await?;
        Ok(s)
    }

    /// E606 before anything is signed when the repository is archived, unless
    /// `--allow-archived`. Forge apps enforce archiving (`config.archived`), not Platform, so
    /// every Forge app refuses the writes instead. An unreadable config
    /// proceeds (the check is advisory, like the role pre-checks).
    pub async fn refuse_if_archived(&self, ctx: &crate::context::Ctx, action: &str) -> Result<()> {
        if ctx.allow_archived {
            return Ok(());
        }
        let svc = forge_core::repo::RepoService::new(&self.client, &self.identity, &self.bridge);
        match svc.current_config(&self.repo).await {
            Ok(c) if c.archived => Err(archived_refusal(&self.repo.display(), action).into()),
            Ok(c) => {
                // A move redirects nothing: the write goes here, and says where the repo went.
                if self.repo.visibility == Visibility::Public {
                    note_moved(&self.client, &self.repo, c.moved_to.as_deref()).await;
                }
                Ok(())
            }
            Err(_) => Ok(()),
        }
    }

    /// The forge-v2 collaboration service, signing as this session's identity.
    pub fn collab(&self) -> forge_core::collab::v2::Collab<'_> {
        forge_core::collab::v2::Collab::new(&self.client, &self.identity, &self.bridge)
    }

    /// Credits spent since `before` (0 when the balance cannot be read). A write that just
    /// landed can be read from a node a block behind, which still shows the old balance, so
    /// the balance is read a few times until it moves.
    pub async fn spent_since(&self, before: u64) -> u64 {
        spent_since(&self.client, &self.identity.id(), before).await
    }

    /// Run `write` and measure what it paid: its result, and the credits the signer's balance
    /// dropped by over it ([`Self::spent_since`]). Every paid write reports its cost
    /// (QW3-070 / QW4-049).
    /// `write` makes the write's future only once the balance is read, so the two are never held
    /// together (each is large).
    pub async fn metered<T, E, F, W>(&self, write: W) -> Result<(T, u64)>
    where
        W: FnOnce() -> F,
        F: std::future::Future<Output = std::result::Result<T, E>>,
        anyhow::Error: From<E>,
    {
        let before = self.balance().await;
        let out = write().await?;
        Ok((out, self.spent_since(before).await))
    }

    /// The signer's balance now (0 when unreadable), for [`Self::spent_since`].
    pub async fn balance(&self) -> u64 {
        self.client
            .get_balance(&self.identity.id())
            .await
            .unwrap_or(0)
    }
}

/// A connection and the repository a command READS (L-12). No key is loaded for a public
/// repository: anyone can read it, and a configured key that cannot be opened here (a sealed
/// file with no terminal, a locked keychain) is never touched. A private repository's
/// documents are sealed to its members' keys, so only then is the identity loaded, and without
/// one the read stops with E301 saying why.
pub struct Reader {
    /// The connection.
    pub client: PlatformClient,
    /// The resolved repository.
    pub repo: Repo,
    /// The identity, loaded only for a private repository.
    signer: Option<(forge_core::keystore::BridgeIdentity, LoadedIdentity)>,
    /// Who is reading, when it is known without unsealing a key (see [`Ctx::identity_id_hint`]).
    viewer: Option<String>,
}

impl Reader {
    /// Parse `repo`, connect and resolve it; load the identity only if it is private.
    pub async fn open(ctx: &crate::context::Ctx, repo: &str) -> Result<Self> {
        Self::open_for(ctx, repo, true).await
    }

    /// [`Self::open`] for a read of what a private repository keeps in the clear (its members:
    /// `maintainer` and `writer` documents are not sealed): no identity is loaded for it, so
    /// anyone can read it signed out, as the web shows it (QW4-054: `dg collab list` stopped
    /// with E301).
    pub async fn open_unsealed(ctx: &crate::context::Ctx, repo: &str) -> Result<Self> {
        Self::open_for(ctx, repo, false).await
    }

    async fn open_for(ctx: &crate::context::Ctx, repo: &str, sealed: bool) -> Result<Self> {
        let repo_ref = RepoRef::parse(repo)?;
        let client = ctx.connect().await?;
        let hint = ctx.identity_id_hint();
        // A bare `name` is one of the reader's own repositories: when the key source does not
        // say whose it is without opening it, open it.
        let mut signer = if hint.is_none()
            && repo_ref.owner.is_none()
            && repo_ref.repo_id().is_none()
            && ctx.identity_path.is_some()
        {
            Some(ctx.signer_on(&client).await?)
        } else {
            None
        };
        let owner = signer.as_ref().map(|(_, i)| i.id()).or(hint);
        let repo = resolve_for(&client, owner.as_deref(), &repo_ref).await?;
        if sealed && repo.visibility == Visibility::Private && signer.is_none() {
            if ctx.identity_path.is_none() {
                return Err(forge_core::user_error::private_needs_identity(&repo.display()).into());
            }
            signer = Some(ctx.signer_on(&client).await?);
        }
        let viewer = signer.as_ref().map(|(_, i)| i.id()).or(owner);
        // Best effort, one small read: a public repository marked as moved says where it went.
        if let Ok(moved) = forge_core::repo::RepoService::reader(&client)
            .moved_to(&repo)
            .await
        {
            note_moved(&client, &repo, moved.as_deref()).await;
        }
        Ok(Self {
            client,
            repo,
            signer,
            viewer,
        })
    }

    /// The forge-v2 collaboration service: with the identity's keys for a private repository,
    /// an anonymous reader otherwise.
    pub fn collab(&self) -> forge_core::collab::v2::Collab<'_> {
        match &self.signer {
            Some((bridge, identity)) => {
                forge_core::collab::v2::Collab::new(&self.client, identity, bridge)
            }
            None => forge_core::collab::v2::Collab::reader(&self.client),
        }
    }

    /// The git data-plane service, keyed like [`Self::collab`].
    pub fn service(&self) -> forge_core::repo::RepoService<'_> {
        match &self.signer {
            Some((bridge, identity)) => {
                forge_core::repo::RepoService::new(&self.client, identity, bridge)
            }
            None => forge_core::repo::RepoService::reader(&self.client),
        }
    }

    /// Who is reading, when known without opening a key (`None` signed out).
    pub fn viewer(&self) -> Option<&str> {
        self.viewer.as_deref()
    }

    /// The reader's identity id for a filter that names `me`: known without the key when the
    /// key source says it, else read from the key (which may ask for its passphrase).
    pub fn me(&self, ctx: &crate::context::Ctx) -> Result<String> {
        match &self.viewer {
            Some(id) => Ok(id.clone()),
            None => Ok(ctx.load_bridge()?.identity_id),
        }
    }
}

/// What `identity_id` has paid since its balance was `before`: the balance read again, a few
/// times while it has not moved yet (a node a block behind still shows the old one).
pub async fn spent_since(client: &PlatformClient, identity_id: &str, before: u64) -> u64 {
    for attempt in 0..4 {
        if let Ok(after) = client.get_balance(identity_id).await {
            if after < before || attempt == 3 {
                return before.saturating_sub(after);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }
    0
}

/// An issue / PR number as the contract stores it (1..=2^32-1), or a usage error.
pub fn number_arg(n: u64) -> Result<u32> {
    u32::try_from(n).ok().filter(|n| *n > 0).ok_or_else(|| {
        crate::errors::usage(format!("{n} is not an issue or PR number (1-4294967295)"))
    })
}

/// The identity id an identity-naming argument (`who`) names: an identity id, or a DPNS
/// name (`alice`, `@alice`, `alice.dash`). `what` names the argument in the error context
/// (`resolving runner @alice`); `with_context` keeps the typed forge-core error for the
/// error renderer.
pub async fn resolve_identity(client: &PlatformClient, who: &str, what: &str) -> Result<String> {
    forge_core::resolve::resolve_owner(client, who.strip_prefix('@').unwrap_or(who))
        .await
        .with_context(|| format!("resolving {what} {who}"))
}

/// DPNS names of who hid the listed rows, for the human list only (`--include-hidden`): no read
/// in `--json` or when no listed row is hidden; a failed read shows the bare id.
pub async fn hider_names<'a>(
    ctx: &crate::context::Ctx,
    client: &PlatformClient,
    hides: impl Iterator<Item = &'a forge_core::rules::v2::Hidden>,
) -> std::collections::BTreeMap<String, String> {
    let ids: Vec<&str> = hides.map(|h| h.by.as_str()).collect();
    if ctx.json || ids.is_empty() {
        return std::collections::BTreeMap::new();
    }
    client.dpns_first_names(ids).await
}

#[cfg(test)]
mod tests {
    use super::{document_id_arg, looks_like_identity_id, RepoRef};

    // A real testnet identity id shape (DEPLOYER).
    const ID: &str = "8hJmcHWTsdvkHyCrk4UgjbyugDAmE7QfuCTQXpXAc7nB";

    /// QW2-076: a number where a comment id goes is E201 naming the argument, not E204.
    #[test]
    fn a_document_id_argument_is_checked_before_any_read() {
        assert!(document_id_arg(ID, "comment id", "`dg issue view`").is_ok());
        let e =
            document_id_arg("2", "comment id", "`dg issue view <repo> <n> --json`").unwrap_err();
        let u = e
            .downcast_ref::<forge_core::user_error::UserError>()
            .unwrap();
        assert_eq!((u.code, u.exit_code()), ("E201", 2));
        assert_eq!(u.message, "\"2\" is not a comment id");
        assert!(
            u.fix[0].contains("dg issue view <repo> <n> --json"),
            "{u:?}"
        );
    }

    #[test]
    fn parses_owner_slash_name() {
        let r = RepoRef::parse(&format!("{ID}/my-repo")).unwrap();
        assert_eq!(r.owner.as_deref(), Some(ID));
        assert_eq!(r.name, "my-repo");
    }

    #[test]
    fn parses_bare_name_as_default_owner() {
        let r = RepoRef::parse("just-a-name").unwrap();
        assert!(r.owner.is_none());
        assert_eq!(r.name, "just-a-name");
    }

    #[test]
    fn a_bare_contract_id_is_a_contract_reference() {
        let r = RepoRef::parse(ID).unwrap();
        assert_eq!(r.repo_id(), Some(ID));
        assert_eq!(RepoRef::parse("my-repo").unwrap().repo_id(), None);
        assert_eq!(
            RepoRef::parse(&format!("{ID}/my-repo")).unwrap().repo_id(),
            None
        );
    }

    #[test]
    fn accepts_a_dpns_owner_and_refuses_junk() {
        for (input, owner) in [
            ("alice/project", "alice"),
            ("alice.dash/project", "alice.dash"),
            ("@alice/project", "alice"),
        ] {
            let r = RepoRef::parse(input).unwrap();
            assert_eq!(r.owner.as_deref(), Some(owner));
            assert_eq!(r.name, "project");
        }
        for bad in [
            "al ice/project",
            "a_b/project",
            ".dash/project",
            "@/project",
            "alice/b/c",
        ] {
            assert!(RepoRef::parse(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn identity_id_shape_detection() {
        assert!(looks_like_identity_id(ID));
        assert!(!looks_like_identity_id("alice"));
        assert!(!looks_like_identity_id(
            "has space in it xxxxxxxxxxxxxxxxxxx"
        ));
    }
}
