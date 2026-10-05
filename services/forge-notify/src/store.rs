//! The subscriber store: one SQLite file (`<data dir>/notify.sqlite3`, WAL).
//!
//! What it holds, per identity: the sealed address and its blind index, whether it is verified
//! or paused, the preferences, the push subscriptions (sealed), the repositories followed (from
//! public chain data), the threads seen participating in, and pending digest items. Nothing
//! here is on chain, and nothing here is needed to use Forge: deleting the file only stops
//! notifications.
//!
//! Every call is short and synchronous behind one mutex; the service's volume (a few writes per
//! notice) does not need a pool.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{NotifyError, Result};

/// When to deliver.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    /// As soon as the service sees the activity.
    #[default]
    Instant,
    /// One mail a day ([`crate::config::Config::digest_hour`]); pushes are not sent. Without a
    /// working address (push only) notices go as pushes when they happen.
    Daily,
}

/// What a subscriber wants. Unknown fields are refused, so a client typo is an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
#[allow(clippy::struct_excessive_bools)]
pub struct Prefs {
    /// Activity on issues and PRs I opened or commented on.
    pub participating: bool,
    /// Someone asked me for a review.
    pub review_requested: bool,
    /// Someone assigned me.
    pub assigned: bool,
    /// Someone @mentioned me.
    pub mentioned: bool,
    /// New issues, PRs, comments, reviews and merges on repositories I watch.
    pub watching: bool,
    /// Treat the repositories I own or am a member of as watched.
    pub own_repos: bool,
    /// Releases of repositories I watch, own or belong to (even with `watching` off).
    pub releases: bool,
    /// "New activity in a private repository you belong to" (no titles, no text).
    pub private_activity: bool,
    /// Instant or a daily digest.
    pub delivery: Delivery,
    /// Send email (when an address is verified).
    pub email: bool,
    /// Send Web Push (when a browser is subscribed).
    pub push: bool,
    /// Repositories (ids) to hear nothing from.
    pub muted_repos: Vec<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            participating: true,
            review_requested: true,
            assigned: true,
            mentioned: true,
            watching: true,
            own_repos: true,
            releases: true,
            private_activity: false,
            delivery: Delivery::Instant,
            email: true,
            push: true,
            muted_repos: Vec::new(),
        }
    }
}

/// At most this many muted repositories.
pub const MAX_MUTED: usize = 200;

impl Prefs {
    /// Refuse what is not sensible.
    pub fn check(&self) -> Result<()> {
        if self.muted_repos.len() > MAX_MUTED {
            return Err(NotifyError::BadRequest(format!(
                "at most {MAX_MUTED} muted repositories"
            )));
        }
        if self
            .muted_repos
            .iter()
            .any(|r| forge_core::platform::decode_identifier(r).is_err())
        {
            return Err(NotifyError::BadRequest(
                "mutedRepos must be repository ids".into(),
            ));
        }
        Ok(())
    }
}

/// One subscriber.
#[derive(Debug, Clone)]
pub struct Subscriber {
    /// The identity id.
    pub identity: String,
    /// The sealed address (verified or not yet replaced).
    pub email_sealed: Option<Vec<u8>>,
    /// Whether that address was confirmed (double opt-in).
    pub email_verified: bool,
    /// Paused after repeated hard failures.
    pub email_paused: bool,
    /// Preferences.
    pub prefs: Prefs,
    /// The unsubscribe-link epoch.
    pub unsub_epoch: u32,
    /// The DPNS label, for mention matching (cached from Platform).
    pub name: Option<String>,
    /// When the row was created (ms).
    pub created_at: u64,
}

impl Subscriber {
    /// Whether mail can go to this subscriber now.
    pub fn mail_ok(&self) -> bool {
        self.email_sealed.is_some() && self.email_verified && !self.email_paused && self.prefs.email
    }
}

/// A pending address change, waiting for its confirmation click.
#[derive(Debug, Clone)]
pub struct Pending {
    /// The identity.
    pub identity: String,
    /// The sealed address.
    pub email_sealed: Vec<u8>,
    /// Its blind index.
    pub email_idx: String,
    /// When the link expires (ms).
    pub expires_at: u64,
}

/// A stored push subscription.
#[derive(Debug, Clone)]
pub struct PushRow {
    /// The row id.
    pub id: i64,
    /// The identity.
    pub identity: String,
    /// The endpoint's hash (`api::endpoint_hash`).
    pub endpoint_hash: String,
    /// The sealed `{endpoint, p256dh, auth}` JSON.
    pub sealed: Vec<u8>,
    /// A label the browser gave (`Firefox on Linux`).
    pub label: Option<String>,
    /// When it was added (ms).
    pub created_at: u64,
}

/// Why an identity follows a repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FollowReason {
    /// A public `watch` document.
    Watch,
    /// Owner, maintainer or writer.
    Member,
}

impl FollowReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Watch => "watch",
            Self::Member => "member",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "watch" {
            Self::Watch
        } else {
            Self::Member
        }
    }
}

/// A followed repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Follow {
    /// The repository id.
    pub repo_id: String,
    /// Why.
    pub reason: FollowReason,
    /// Whether it is private (then only metadata notices).
    pub private: bool,
}

/// The store.
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

const SCHEMA: &str = r"
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS subscriber (
  identity TEXT PRIMARY KEY,
  email_sealed BLOB,
  email_idx TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_paused INTEGER NOT NULL DEFAULT 0,
  email_failures INTEGER NOT NULL DEFAULT 0,
  prefs TEXT NOT NULL,
  unsub_epoch INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriber_email_idx ON subscriber(email_idx);
CREATE TABLE IF NOT EXISTS pending_email (
  token_hash TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  email_sealed BLOB NOT NULL,
  email_idx TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_identity ON pending_email(identity);
CREATE TABLE IF NOT EXISTS push_sub (
  id INTEGER PRIMARY KEY,
  identity TEXT NOT NULL REFERENCES subscriber(identity) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL,
  sealed BLOB NOT NULL,
  label TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (identity, endpoint_hash)
);
CREATE INDEX IF NOT EXISTS push_identity ON push_sub(identity);
CREATE TABLE IF NOT EXISTS nonce (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS follow (
  identity TEXT NOT NULL REFERENCES subscriber(identity) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  private INTEGER NOT NULL,
  PRIMARY KEY (identity, repo_id)
);
CREATE INDEX IF NOT EXISTS follow_repo ON follow(repo_id);
CREATE TABLE IF NOT EXISTS participant (
  repo_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  identity TEXT NOT NULL REFERENCES subscriber(identity) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, thread, identity)
);
CREATE TABLE IF NOT EXISTS digest_item (
  id INTEGER PRIMARY KEY,
  identity TEXT NOT NULL REFERENCES subscriber(identity) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  item TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS digest_identity ON digest_item(identity);
CREATE TABLE IF NOT EXISTS sent (
  identity TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (identity, notice_id)
);
CREATE TABLE IF NOT EXISTS counter (key TEXT PRIMARY KEY, day INTEGER NOT NULL, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cursor (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
";

/// A store made before push subscriptions were keyed per identity had `endpoint_hash UNIQUE`
/// on its own, so registering an endpoint moved it to the identity that registered it last.
/// Rebuild that table with `UNIQUE (identity, endpoint_hash)`, keeping its rows.
fn migrate_push_sub(conn: &mut Connection) -> Result<()> {
    let old: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'push_sub'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if !old.is_some_and(|sql| sql.contains("endpoint_hash TEXT NOT NULL UNIQUE")) {
        return Ok(());
    }
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE push_sub_v2 (
           id INTEGER PRIMARY KEY,
           identity TEXT NOT NULL REFERENCES subscriber(identity) ON DELETE CASCADE,
           endpoint_hash TEXT NOT NULL,
           sealed BLOB NOT NULL,
           label TEXT,
           failures INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           UNIQUE (identity, endpoint_hash)
         );
         INSERT INTO push_sub_v2 (id, identity, endpoint_hash, sealed, label, failures, created_at)
           SELECT id, identity, endpoint_hash, sealed, label, failures, created_at FROM push_sub;
         DROP TABLE push_sub;
         ALTER TABLE push_sub_v2 RENAME TO push_sub;
         CREATE INDEX IF NOT EXISTS push_identity ON push_sub(identity);",
    )?;
    tx.commit()?;
    tracing::info!("store: push subscriptions are now keyed per identity");
    Ok(())
}

fn to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// Milliseconds since the epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The UTC day number of `ms`.
pub fn day_of(ms: u64) -> u64 {
    ms / 86_400_000
}

impl Store {
    /// Open (or create) the store in `dir`, which is created with mode 0700.
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| NotifyError::Config(format!("data dir {}: {e}", dir.display())))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let conn = Connection::open(dir.join("notify.sqlite3"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    /// An in-memory store (tests).
    pub fn memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate_push_sub(&mut conn)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Whether the database answers.
    pub fn ping(&self) -> bool {
        self.db()
            .query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .is_ok()
    }

    /// How many subscribers there are.
    pub fn subscriber_count(&self) -> Result<u64> {
        Ok(to_u64(self.db().query_row(
            "SELECT COUNT(*) FROM subscriber",
            [],
            |r| r.get(0),
        )?))
    }

    /// Aggregate gauges for `/metrics`: counts only, nothing about anyone.
    pub fn gauges(&self) -> Result<Vec<(&'static str, u64)>> {
        const Q: &[(&str, &str)] = &[
            (
                "forge_notify_subscribers",
                "SELECT COUNT(*) FROM subscriber",
            ),
            (
                "forge_notify_emails_verified",
                "SELECT COUNT(*) FROM subscriber WHERE email_verified = 1 AND email_paused = 0",
            ),
            (
                "forge_notify_emails_paused",
                "SELECT COUNT(*) FROM subscriber WHERE email_paused = 1",
            ),
            (
                "forge_notify_push_subscriptions",
                "SELECT COUNT(*) FROM push_sub",
            ),
            (
                "forge_notify_followed_repos",
                "SELECT COUNT(DISTINCT repo_id) FROM follow",
            ),
            (
                "forge_notify_digest_items",
                "SELECT COUNT(*) FROM digest_item",
            ),
        ];
        let db = self.db();
        let mut out = Vec::with_capacity(Q.len() + 1);
        for (name, sql) in Q {
            out.push((*name, to_u64(db.query_row(sql, [], |r| r.get(0))?)));
        }
        let today = to_i64(day_of(now_ms()));
        let sent: i64 = db
            .query_row(
                "SELECT n FROM counter WHERE key = 'global' AND day = ?1",
                [today],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        out.push(("forge_notify_sent_today", to_u64(sent)));
        Ok(out)
    }

    fn row_to_subscriber(r: &rusqlite::Row<'_>) -> rusqlite::Result<Subscriber> {
        let prefs: String = r.get(5)?;
        Ok(Subscriber {
            identity: r.get(0)?,
            email_sealed: r.get(1)?,
            email_verified: r.get::<_, i64>(2)? != 0,
            email_paused: r.get::<_, i64>(3)? != 0,
            unsub_epoch: u32::try_from(r.get::<_, i64>(4)?).unwrap_or(0),
            prefs: serde_json::from_str(&prefs).unwrap_or_default(),
            name: r.get(6)?,
            created_at: to_u64(r.get(7)?),
        })
    }

    const SUBSCRIBER_COLS: &'static str = "identity, email_sealed, email_verified, email_paused, \
         unsub_epoch, prefs, name, created_at";

    /// One subscriber.
    pub fn subscriber(&self, identity: &str) -> Result<Option<Subscriber>> {
        Ok(self
            .db()
            .query_row(
                &format!(
                    "SELECT {} FROM subscriber WHERE identity = ?1",
                    Self::SUBSCRIBER_COLS
                ),
                [identity],
                Self::row_to_subscriber,
            )
            .optional()?)
    }

    /// Every subscriber that can receive something (a verified address or a push subscription).
    pub fn active_subscribers(&self) -> Result<Vec<Subscriber>> {
        let db = self.db();
        let mut st = db.prepare(&format!(
            "SELECT {} FROM subscriber s WHERE (email_sealed IS NOT NULL AND email_verified = 1 \
             AND email_paused = 0) OR EXISTS (SELECT 1 FROM push_sub p WHERE p.identity = s.identity)",
            Self::SUBSCRIBER_COLS
        ))?;
        let rows = st.query_map([], Self::row_to_subscriber)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Create the subscriber row with default preferences if it is missing. Whether it was
    /// created.
    pub fn ensure_subscriber(&self, identity: &str) -> Result<bool> {
        let now = to_i64(now_ms());
        let prefs = serde_json::to_string(&Prefs::default())
            .map_err(|e| NotifyError::Internal(e.to_string()))?;
        // A random first epoch: unsubscribe links mailed before a `data.delete` must not work
        // for the identity's next subscription.
        let epoch = i64::from(rand::random::<u32>() >> 1);
        let n = self.db().execute(
            "INSERT OR IGNORE INTO subscriber (identity, prefs, created_at, updated_at, unsub_epoch) \
             VALUES (?1, ?2, ?3, ?3, ?4)",
            params![identity, prefs, now, epoch],
        )?;
        Ok(n == 1)
    }

    /// Replace the preferences.
    pub fn set_prefs(&self, identity: &str, prefs: &Prefs) -> Result<()> {
        let json =
            serde_json::to_string(prefs).map_err(|e| NotifyError::Internal(e.to_string()))?;
        self.db().execute(
            "UPDATE subscriber SET prefs = ?2, updated_at = ?3 WHERE identity = ?1",
            params![identity, json, to_i64(now_ms())],
        )?;
        Ok(())
    }

    /// Cache the subscriber's DPNS label.
    pub fn set_name(&self, identity: &str, name: Option<&str>) -> Result<()> {
        self.db().execute(
            "UPDATE subscriber SET name = ?2 WHERE identity = ?1",
            params![identity, name],
        )?;
        Ok(())
    }

    /// Record a pending address (replacing that identity's earlier pending ones).
    pub fn add_pending(&self, token_hash: &str, p: &Pending) -> Result<()> {
        let db = self.db();
        db.execute(
            "DELETE FROM pending_email WHERE identity = ?1",
            [&p.identity],
        )?;
        db.execute(
            "INSERT INTO pending_email (token_hash, identity, email_sealed, email_idx, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![token_hash, p.identity, p.email_sealed, p.email_idx, to_i64(p.expires_at)],
        )?;
        Ok(())
    }

    /// A pending address by token hash, if not expired (not consumed).
    pub fn pending(&self, token_hash: &str) -> Result<Option<Pending>> {
        let now = to_i64(now_ms());
        Ok(self
            .db()
            .query_row(
                "SELECT identity, email_sealed, email_idx, expires_at FROM pending_email WHERE token_hash = ?1 AND expires_at > ?2",
                params![token_hash, now],
                |r| {
                    Ok(Pending {
                        identity: r.get(0)?,
                        email_sealed: r.get(1)?,
                        email_idx: r.get(2)?,
                        expires_at: to_u64(r.get(3)?),
                    })
                },
            )
            .optional()?)
    }

    /// Confirm a pending address: it becomes the identity's verified address. `None` when the
    /// token is unknown or expired.
    pub fn confirm_pending(&self, token_hash: &str) -> Result<Option<String>> {
        let Some(p) = self.pending(token_hash)? else {
            return Ok(None);
        };
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "DELETE FROM pending_email WHERE identity = ?1",
            [&p.identity],
        )?;
        let n = tx.execute(
            "UPDATE subscriber SET email_sealed = ?2, email_idx = ?3, email_verified = 1, \
             email_paused = 0, email_failures = 0, unsub_epoch = unsub_epoch + 1, \
             updated_at = ?4 WHERE identity = ?1",
            params![p.identity, p.email_sealed, p.email_idx, to_i64(now_ms())],
        )?;
        tx.commit()?;
        Ok((n == 1).then_some(p.identity))
    }

    /// How many identities use (or are confirming) this address.
    pub fn identities_with_email(&self, email_idx: &str) -> Result<u64> {
        let db = self.db();
        let a: i64 = db.query_row(
            "SELECT COUNT(*) FROM subscriber WHERE email_idx = ?1",
            [email_idx],
            |r| r.get(0),
        )?;
        let b: i64 = db.query_row(
            "SELECT COUNT(DISTINCT identity) FROM pending_email WHERE email_idx = ?1 AND expires_at > ?2",
            params![email_idx, to_i64(now_ms())],
            |r| r.get(0),
        )?;
        Ok(to_u64(a) + to_u64(b))
    }

    /// Forget the identity's address (and pending ones), and void its unsubscribe links.
    pub fn remove_email(&self, identity: &str) -> Result<()> {
        let db = self.db();
        db.execute("DELETE FROM pending_email WHERE identity = ?1", [identity])?;
        db.execute(
            "UPDATE subscriber SET email_sealed = NULL, email_idx = NULL, email_verified = 0, \
             email_paused = 0, email_failures = 0, unsub_epoch = unsub_epoch + 1, updated_at = ?2 \
             WHERE identity = ?1",
            params![identity, to_i64(now_ms())],
        )?;
        Ok(())
    }

    /// A one-click unsubscribe at `epoch`: forget the address if the epoch is current.
    pub fn unsubscribe(&self, identity: &str, epoch: u32) -> Result<bool> {
        let current: Option<i64> = self
            .db()
            .query_row(
                "SELECT unsub_epoch FROM subscriber WHERE identity = ?1",
                [identity],
                |r| r.get(0),
            )
            .optional()?;
        if current != Some(i64::from(epoch)) {
            return Ok(false);
        }
        self.remove_email(identity)?;
        Ok(true)
    }

    /// Count a failed mail; after `pause_after` in a row the address is paused. Whether it is
    /// now paused.
    pub fn email_failed(&self, identity: &str, pause_after: u32) -> Result<bool> {
        let db = self.db();
        db.execute(
            "UPDATE subscriber SET email_failures = email_failures + 1, \
             email_paused = CASE WHEN email_failures + 1 >= ?2 THEN 1 ELSE email_paused END \
             WHERE identity = ?1",
            params![identity, pause_after],
        )?;
        let paused: i64 = db
            .query_row(
                "SELECT email_paused FROM subscriber WHERE identity = ?1",
                [identity],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        Ok(paused != 0)
    }

    /// A mail went through: reset the failure count.
    pub fn email_ok(&self, identity: &str) -> Result<()> {
        self.db().execute(
            "UPDATE subscriber SET email_failures = 0 WHERE identity = ?1 AND email_failures > 0",
            [identity],
        )?;
        Ok(())
    }

    /// Add (or refresh) one of the identity's push subscriptions. Another identity's row for
    /// the same endpoint is left alone (one browser may serve several identities).
    pub fn add_push(
        &self,
        identity: &str,
        endpoint_hash: &str,
        sealed: &[u8],
        label: Option<&str>,
    ) -> Result<()> {
        self.db().execute(
            "INSERT INTO push_sub (identity, endpoint_hash, sealed, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(identity, endpoint_hash) DO UPDATE SET sealed = ?3, label = ?4, failures = 0",
            params![identity, endpoint_hash, sealed, label, to_i64(now_ms())],
        )?;
        Ok(())
    }

    /// Remove one of the identity's push subscriptions. Whether there was one.
    pub fn remove_push(&self, identity: &str, endpoint_hash: &str) -> Result<bool> {
        Ok(self.db().execute(
            "DELETE FROM push_sub WHERE identity = ?1 AND endpoint_hash = ?2",
            params![identity, endpoint_hash],
        )? == 1)
    }

    /// Remove a push subscription by row (the push service said it is gone).
    pub fn drop_push(&self, id: i64) -> Result<()> {
        self.db()
            .execute("DELETE FROM push_sub WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The identity's push subscriptions.
    pub fn pushes(&self, identity: &str) -> Result<Vec<PushRow>> {
        let db = self.db();
        let mut st = db.prepare(
            "SELECT id, identity, endpoint_hash, sealed, label, created_at FROM push_sub \
             WHERE identity = ?1 ORDER BY id",
        )?;
        let rows = st.query_map([identity], |r| {
            Ok(PushRow {
                id: r.get(0)?,
                identity: r.get(1)?,
                endpoint_hash: r.get(2)?,
                sealed: r.get(3)?,
                label: r.get(4)?,
                created_at: to_u64(r.get(5)?),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Use a nonce once: false when it was seen before (a replay).
    pub fn use_nonce(&self, nonce: &str, expires_at: u64) -> Result<bool> {
        let db = self.db();
        db.execute(
            "DELETE FROM nonce WHERE expires_at < ?1",
            [to_i64(now_ms())],
        )?;
        Ok(db.execute(
            "INSERT OR IGNORE INTO nonce (nonce, expires_at) VALUES (?1, ?2)",
            params![nonce, to_i64(expires_at)],
        )? == 1)
    }

    /// Replace the identity's followed repositories.
    pub fn set_follows(&self, identity: &str, follows: &[Follow]) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM follow WHERE identity = ?1", [identity])?;
        for f in follows {
            tx.execute(
                "INSERT OR REPLACE INTO follow (identity, repo_id, reason, private) VALUES (?1, ?2, ?3, ?4)",
                params![identity, f.repo_id, f.reason.as_str(), i64::from(f.private)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The identity's followed repositories.
    pub fn follows(&self, identity: &str) -> Result<Vec<Follow>> {
        let db = self.db();
        let mut st = db.prepare(
            "SELECT repo_id, reason, private FROM follow WHERE identity = ?1 ORDER BY repo_id",
        )?;
        let rows = st.query_map([identity], |r| {
            Ok(Follow {
                repo_id: r.get(0)?,
                reason: FollowReason::parse(&r.get::<_, String>(1)?),
                private: r.get::<_, i64>(2)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Who follows `repo_id`, and why.
    pub fn followers(&self, repo_id: &str) -> Result<Vec<(String, FollowReason)>> {
        let db = self.db();
        let mut st = db.prepare("SELECT identity, reason FROM follow WHERE repo_id = ?1")?;
        let rows = st.query_map([repo_id], |r| {
            Ok((r.get(0)?, FollowReason::parse(&r.get::<_, String>(1)?)))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every public repository someone follows, most followed first, at most `max`.
    pub fn followed_public_repos(&self, max: usize) -> Result<BTreeSet<String>> {
        let db = self.db();
        let mut st = db.prepare(
            "SELECT repo_id FROM follow WHERE private = 0 GROUP BY repo_id ORDER BY COUNT(*) DESC, repo_id LIMIT ?1",
        )?;
        let rows = st.query_map([to_i64(max as u64)], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<BTreeSet<String>>>()?)
    }

    /// Every private repository someone follows, with its followers.
    pub fn followed_private_repos(&self) -> Result<BTreeMap<String, Vec<String>>> {
        let db = self.db();
        let mut st = db.prepare("SELECT repo_id, identity FROM follow WHERE private = 1")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for row in rows {
            let (repo, who) = row?;
            out.entry(repo).or_default().push(who);
        }
        Ok(out)
    }

    /// Note that `identity` took part in a thread.
    pub fn add_participant(&self, repo_id: &str, thread: &str, identity: &str) -> Result<()> {
        self.db().execute(
            "INSERT OR REPLACE INTO participant (repo_id, thread, identity, at) \
             SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM subscriber WHERE identity = ?3)",
            params![repo_id, thread, identity, to_i64(now_ms())],
        )?;
        Ok(())
    }

    /// The subscribers who took part in a thread.
    pub fn participants(&self, repo_id: &str, thread: &str) -> Result<Vec<String>> {
        let db = self.db();
        let mut st =
            db.prepare("SELECT identity FROM participant WHERE repo_id = ?1 AND thread = ?2")?;
        let rows = st.query_map([repo_id, thread], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The repositories of threads the identity takes part in (followed for it).
    pub fn participating_repos(&self, identity: &str) -> Result<BTreeSet<String>> {
        let db = self.db();
        let mut st = db.prepare("SELECT DISTINCT repo_id FROM participant WHERE identity = ?1")?;
        let rows = st.query_map([identity], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<BTreeSet<String>>>()?)
    }

    /// Queue a digest item.
    pub fn push_digest(&self, identity: &str, item: &str) -> Result<()> {
        self.db().execute(
            "INSERT INTO digest_item (identity, created_at, item) VALUES (?1, ?2, ?3)",
            params![identity, to_i64(now_ms()), item],
        )?;
        Ok(())
    }

    /// The identities with digest items waiting.
    pub fn digest_identities(&self) -> Result<Vec<String>> {
        let db = self.db();
        let mut st = db.prepare("SELECT DISTINCT identity FROM digest_item")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// An identity's digest items, oldest first, and the row id of the newest (0 when there
    /// is none). They stay until [`Store::drop_digest`]: a digest that fails to go keeps them.
    pub fn digest(&self, identity: &str) -> Result<(Vec<String>, i64)> {
        let db = self.db();
        let mut st =
            db.prepare("SELECT id, item FROM digest_item WHERE identity = ?1 ORDER BY id")?;
        let rows = st.query_map([identity], |r| Ok((r.get::<_, i64>(0)?, r.get(1)?)))?;
        let rows = rows.collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
        let upto = rows.last().map_or(0, |(id, _)| *id);
        Ok((rows.into_iter().map(|(_, item)| item).collect(), upto))
    }

    /// Delete an identity's digest items up to row id `upto` (what a sent digest held; items
    /// queued meanwhile wait for the next one).
    pub fn drop_digest(&self, identity: &str, upto: i64) -> Result<()> {
        self.db().execute(
            "DELETE FROM digest_item WHERE identity = ?1 AND id <= ?2",
            params![identity, upto],
        )?;
        Ok(())
    }

    /// Record that a notice reached an identity: false when it already had.
    pub fn mark_sent(&self, identity: &str, notice_id: &str) -> Result<bool> {
        Ok(self.db().execute(
            "INSERT OR IGNORE INTO sent (identity, notice_id, at) VALUES (?1, ?2, ?3)",
            params![identity, notice_id, to_i64(now_ms())],
        )? == 1)
    }

    /// Count one use of a daily quota `key`: false (and not counted) when `limit` is reached.
    pub fn take_quota(&self, key: &str, limit: u64) -> Result<bool> {
        let day = to_i64(day_of(now_ms()));
        let mut db = self.db();
        let tx = db.transaction()?;
        let (d, n): (i64, i64) = tx
            .query_row("SELECT day, n FROM counter WHERE key = ?1", [key], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
            .unwrap_or((day, 0));
        let n = if d == day { n } else { 0 };
        if to_u64(n) >= limit {
            return Ok(false);
        }
        tx.execute(
            "INSERT OR REPLACE INTO counter (key, day, n) VALUES (?1, ?2, ?3)",
            params![key, day, n + 1],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// A stored cursor.
    pub fn cursor(&self, key: &str) -> Result<Option<u64>> {
        Ok(self
            .db()
            .query_row("SELECT value FROM cursor WHERE key = ?1", [key], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?
            .map(to_u64))
    }

    /// Store a cursor.
    pub fn set_cursor(&self, key: &str, value: u64) -> Result<()> {
        self.db().execute(
            "INSERT OR REPLACE INTO cursor (key, value) VALUES (?1, ?2)",
            params![key, to_i64(value)],
        )?;
        Ok(())
    }

    /// Delete everything about an identity.
    pub fn delete_identity(&self, identity: &str) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        for sql in [
            "DELETE FROM pending_email WHERE identity = ?1",
            "DELETE FROM push_sub WHERE identity = ?1",
            "DELETE FROM follow WHERE identity = ?1",
            "DELETE FROM participant WHERE identity = ?1",
            "DELETE FROM digest_item WHERE identity = ?1",
            "DELETE FROM sent WHERE identity = ?1",
            "DELETE FROM subscriber WHERE identity = ?1",
        ] {
            tx.execute(sql, [identity])?;
        }
        tx.execute(
            "DELETE FROM cursor WHERE key LIKE ?1",
            [format!("%:{identity}")],
        )?;
        // The day's quota counters stay (they hold no address and are purged tomorrow):
        // deleting must not reset the confirmation-mail limit.
        tx.commit()?;
        Ok(())
    }

    /// Drop what has aged out: sent marks after 14 days, participation after 180, digest items
    /// after 7, expired pending addresses and nonces, and past days' quota counters.
    pub fn purge(&self) -> Result<()> {
        let now = now_ms();
        let ago = |days: u64| to_i64(now.saturating_sub(days * 86_400_000));
        let db = self.db();
        db.execute("DELETE FROM sent WHERE at < ?1", [ago(14)])?;
        db.execute("DELETE FROM participant WHERE at < ?1", [ago(180)])?;
        db.execute("DELETE FROM digest_item WHERE created_at < ?1", [ago(7)])?;
        db.execute(
            "DELETE FROM pending_email WHERE expires_at < ?1",
            [to_i64(now)],
        )?;
        db.execute("DELETE FROM nonce WHERE expires_at < ?1", [to_i64(now)])?;
        // Daily quotas only count today.
        db.execute("DELETE FROM counter WHERE day < ?1", [to_i64(day_of(now))])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_push_endpoint_belongs_to_each_identity_that_adds_it() {
        let s = Store::memory().unwrap();
        s.ensure_subscriber("A").unwrap();
        s.ensure_subscriber("B").unwrap();
        s.add_push("A", "h", b"a", Some("one")).unwrap();
        s.add_push("B", "h", b"b", None).unwrap();
        s.add_push("A", "h", b"a2", Some("two")).unwrap();
        let a = s.pushes("A").unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(
            (a[0].sealed.as_slice(), a[0].label.as_deref()),
            (&b"a2"[..], Some("two"))
        );
        assert_eq!(s.pushes("B").unwrap()[0].sealed, b"b");
        assert!(s.remove_push("B", "h").unwrap());
        assert_eq!(s.pushes("A").unwrap().len(), 1);
    }

    #[test]
    fn an_old_store_is_migrated_to_per_identity_push_rows() {
        // The schema as it was: `endpoint_hash` unique on its own.
        let old = SCHEMA
            .replace(
                "endpoint_hash TEXT NOT NULL,",
                "endpoint_hash TEXT NOT NULL UNIQUE,",
            )
            .replace(",\n  UNIQUE (identity, endpoint_hash)", "");
        assert_ne!(old, SCHEMA);
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&old).unwrap();
        conn.execute_batch(
            "INSERT INTO subscriber (identity, prefs, created_at, updated_at)
               VALUES ('A', '{}', 0, 0), ('B', '{}', 0, 0);
             INSERT INTO push_sub (identity, endpoint_hash, sealed, label, created_at)
               VALUES ('A', 'h', x'01', 'Firefox', 5);",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        let a = s.pushes("A").unwrap();
        assert_eq!(
            (
                a[0].endpoint_hash.as_str(),
                a[0].label.as_deref(),
                a[0].created_at
            ),
            ("h", Some("Firefox"), 5)
        );
        s.add_push("B", "h", b"b", None).unwrap();
        assert_eq!(s.pushes("A").unwrap().len(), 1);
        assert_eq!(s.pushes("B").unwrap().len(), 1);
        // Opening it again changes nothing.
        let conn = std::mem::replace(&mut *s.db(), Connection::open_in_memory().unwrap());
        let s = Store::init(conn).unwrap();
        assert_eq!(s.pushes("A").unwrap().len(), 1);
    }

    #[test]
    fn subscriber_lifecycle() {
        let s = Store::memory().unwrap();
        assert!(s.ensure_subscriber("A").unwrap());
        assert!(!s.ensure_subscriber("A").unwrap());
        let sub = s.subscriber("A").unwrap().unwrap();
        assert_eq!(sub.prefs, Prefs::default());
        assert!(!sub.mail_ok());

        let p = Pending {
            identity: "A".into(),
            email_sealed: vec![1, 2, 3],
            email_idx: "idx".into(),
            expires_at: now_ms() + 60_000,
        };
        s.add_pending("h", &p).unwrap();
        assert_eq!(s.identities_with_email("idx").unwrap(), 1);
        let before = s.subscriber("A").unwrap().unwrap().unsub_epoch;
        assert_eq!(s.confirm_pending("h").unwrap().as_deref(), Some("A"));
        let epoch = s.subscriber("A").unwrap().unwrap().unsub_epoch;
        assert_eq!(epoch, before + 1, "a new address voids the old links");
        assert!(s.confirm_pending("h").unwrap().is_none());
        assert!(s.subscriber("A").unwrap().unwrap().mail_ok());

        assert!(!s.email_failed("A", 3).unwrap());
        assert!(!s.email_failed("A", 3).unwrap());
        assert!(s.email_failed("A", 3).unwrap());
        assert!(!s.subscriber("A").unwrap().unwrap().mail_ok());

        assert!(
            !s.unsubscribe("A", before).unwrap(),
            "a link to the old address"
        );
        assert!(s.unsubscribe("A", epoch).unwrap());
        let sub = s.subscriber("A").unwrap().unwrap();
        assert!(sub.email_sealed.is_none() && sub.unsub_epoch == epoch + 1);
        assert!(!s.unsubscribe("A", epoch).unwrap(), "an old link is void");

        // A deleted and re-created subscriber does not start where it left off.
        s.delete_identity("A").unwrap();
        s.ensure_subscriber("A").unwrap();
        let again = s.subscriber("A").unwrap().unwrap().unsub_epoch;
        assert_ne!(again, epoch + 1);
    }

    #[test]
    fn follows_quotas_nonces_and_delete() {
        let s = Store::memory().unwrap();
        s.ensure_subscriber("A").unwrap();
        s.ensure_subscriber("B").unwrap();
        let f = |r: &str, private| Follow {
            repo_id: r.into(),
            reason: FollowReason::Watch,
            private,
        };
        s.set_follows("A", &[f("R1", false), f("P1", true)])
            .unwrap();
        s.set_follows("B", &[f("R1", false), f("R2", false)])
            .unwrap();
        assert_eq!(
            s.followed_public_repos(10).unwrap(),
            BTreeSet::from(["R1".to_string(), "R2".to_string()])
        );
        assert_eq!(
            s.followed_public_repos(1).unwrap(),
            BTreeSet::from(["R1".to_string()])
        );
        assert_eq!(
            s.followed_private_repos().unwrap()["P1"],
            vec!["A".to_string()]
        );
        assert_eq!(s.followers("R1").unwrap().len(), 2);

        assert!(s.take_quota("q", 2).unwrap());
        assert!(s.take_quota("q", 2).unwrap());
        assert!(!s.take_quota("q", 2).unwrap());

        assert!(s.use_nonce("n1", now_ms() + 1000).unwrap());
        assert!(!s.use_nonce("n1", now_ms() + 1000).unwrap());

        s.add_participant("R1", "issue:1", "A").unwrap();
        s.add_participant("R1", "issue:1", "nobody").unwrap();
        assert_eq!(
            s.participants("R1", "issue:1").unwrap(),
            vec!["A".to_string()]
        );
        s.push_digest("A", "{}").unwrap();
        assert!(s.mark_sent("A", "n").unwrap());
        assert!(!s.mark_sent("A", "n").unwrap());

        s.delete_identity("A").unwrap();
        assert!(s.subscriber("A").unwrap().is_none());
        assert!(s.follows("A").unwrap().is_empty());
        assert!(s.participants("R1", "issue:1").unwrap().is_empty());
        assert!(s.digest("A").unwrap().0.is_empty());
        assert!(s.mark_sent("A", "n").unwrap());
    }
}
