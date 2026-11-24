# Pin and fork: copies on your own storage

Owner request (2026-11-24): from any repo page, and in `dg`, a user can either **fork** a repo
(their own copy they can push to) or **pin** it (keep a copy of its packs on their own storage,
without taking ownership, so they help host and preserve it). Both store the bytes on the
user's own storage profile.

No contract change. Everything below uses types that are live on testnet and mainnet.

## Pin

A pin of a **public** repository:

1. **What gets copied.** One copy of every pack that a member's (maintainer or writer)
   `packManifest` lists, deduplicated by pack hash. Superseded packs are included, since an
   older clone may still need them. Release assets are not copied, because `packMirror` names
   packs only.
2. **Bytes.** The pinner reads each pack through the normal verified read path (manifest
   copies first, then existing mirrors) and checks it against `packHash`. It then stores the
   pack on the chosen storage profile with the same verified upload a push uses
   (`ExternalTarget::store` in Rust, `storeFile` in the web app).
3. **Record.** For each pack, one `packMirror` document (`repoId`, `packHash`, `kind`,
   `uris`), written by the pinner. The contract allows one per
   `(repoId, packHash, $ownerId)` and only for a public repo. Which address is recorded:
   - **S3/R2 with a public URL:** that `https://` URL (kind 1), once an anonymous read of it
     returns the whole pack. If it does not, nothing is recorded for that pack.
   - **IPFS with a public gateway:** `https://<gateway>/ipfs/<cid>` (kind 1), once it serves the
     whole pack; until then the `ipfs://<cid>`. Readers reach the pinner's node directly
     instead of waiting on the DHT.
   - **IPFS without a public gateway:** `ipfs://<cid>` (kind 2). Readers' gateways find it on
     the IPFS network.
   - **S3 without a public URL, or Platform:** not offered. Nobody else can read a private
     bucket. Platform chunks are already permanent and non-deletable, so they need no pin.

   The record is written even when its address equals one in the manifest (an `ipfs://` CID).
   It is the durable "I pin this" record: the web app shows Pinned from it on any device, and
   `dg repo unpin` deletes it (refunding its storage).

   The cost is one document per pack, about 0.00075 DASH each. Both clients show it before the
   user confirms.
4. **Discovery.** Nothing new is needed. Readers (dg, git-remote-dash, web) already try the
   `packMirror` addresses when every copy a manifest names has failed, members' records first,
   then at most 2 addresses per non-member, and use them only when the bytes hash to the pack
   (`rules::pack_mirror::mirror_read_order`). A pin therefore keeps a clone working after the
   repo's own storage goes away.
5. **Staying in sync.**
   - **dg:** `dg repo pin <repo> --follow` adds the repo to the follow list in
     `~/.config/dash-forge/pins.toml`. `dg repo pin --all` refreshes every followed repo: it
     copies and records only packs that have no record of yours yet, so a refresh with nothing
     new is reads only. Run it from cron or a systemd timer on any machine with `dg` and the
     storage profile (the one-command self-hosted backend runs kubo only, not `dg`).
   - **Web:** the Pin button reads your `packMirror` records for the repo. Once every pack is
     covered it shows **Pinned**. When new packs land it shows **Update pin (N new)**, and one
     click copies just those.
6. **Unpin.** `dg repo unpin <repo>` (and Unpin in the web app) deletes your `packMirror`
   records for the repo and removes it from the follow list. The files stay on your storage;
   delete them there if you want.

**Private repos.** The contract refuses mirror records for private repos, and readers never use
mirrors for them. A member can still keep a backup copy of the encrypted packs on their IPFS
node with `dg ipfs pin` (as before, no record). The web Pin dialog keeps that IPFS-only path for
private repos.

## Fork

Before this change, a fork recorded the parent's packs by reference and stored nothing of its
own. If the parent's external storage went away, the fork broke with it. Now:

- If the forker has an external storage profile (the default push policy's first external
  target, or `--storage <profile>`), each parent pack is copied there before its fork manifest
  is written. The manifest's `uris` list the forker's copy first, then the parent's addresses as
  a fallback, cut to the manifest URI budget.
- Platform chunk copies are still referenced through the parent's chunk locator. They are
  permanent, so copying them again would pay twice for nothing.
- `dg repo sync` and the web Sync button copy the parent's new packs the same way.
- With no external storage, a fork still works by reference, as before. The fork dialog says so
  in one line and links to storage setup.
- `--no-copy` keeps the by-reference behaviour when storage is configured.

## UX

The repo page header shows **Fork** (primary) and **Pin** (secondary) side by side.

The Pin dialog shows:

- one line: "N files · X MiB → <profile> · ~Y DASH to record";
- one storage picker, shown only when there is more than one usable profile;
- one primary button, **Pin**;
- details (per-file progress, skipped counts, the `dg repo pin --follow` command) collapsed.

With no usable storage, the primary action is **Set up storage**, linking to Settings → Storage
and the self-host guide.
