//! A connected organization: its log read from Platform (§10), and the request flows (§4, §9,
//! §11): create, sign, decline and finish. The relay is read only for the key ceremony, when a
//! member connects.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::network::ForgeIds;
use crate::platform::org::{
    attach_signature, decode_unsigned, holds_group_key, DecodedWrite, NonceState, UnsignedWrite,
};
use crate::platform::{
    BroadcastOutcome, FetchedDocument, FieldValue, LoadedContract, LoadedIdentity, PlatformClient,
    QueryFilter, QueryOrder, WriteEngine,
};
use crate::user_error::{codes, UserError};

use super::derive::{MemberKeys, Seed};
use super::envelope::{now_iso, seal};
use super::member::{self, Shares};
use super::request::{self, ChainView, DocState, Note, PartFacts, PartState, Request, Summary};
use super::review::{self, Expect, Names, Reviewed};
use super::state::{reduce, reduce_with, Ceremony, ProposalStatus, RoomState};
use super::transport::{self, MemberDoc, MessageDoc, Roster, ShareDoc, Timed};
use super::{bls, signing_ceremonies, signing_slot, MemberRecord, OrgError, OrgRecord, Relay};

const CONFIRM_ATTEMPTS: usize = 8;
const CONFIRM_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);
/// The most `orgMember` documents read per member key.
const MEMBER_DOCS_READ: u32 = 100;

/// "Forge won't sign this: <reasons>." (§11.1): its own code, and the free next step.
pub fn refused(req_id: &str, problems: &[String]) -> Error {
    UserError::new(codes::ORG_REFUSED, request::refused_text(problems))
        .fix(format!(
            "it can't be signed as it is: `dg org dismiss {req_id}` hides it on this computer"
        ))
        .into()
}

fn not_open(summary: &Summary) -> Error {
    let text = summary
        .text()
        .unwrap_or_else(|| format!("This request is {}.", summary.status.label()));
    UserError::new(codes::USAGE, text).into()
}

/// The envelope types of a key ceremony: what a member keeps from the relay.
const CEREMONY_TYPES: [&str; 7] = [
    "hello",
    "config",
    "accept",
    "dkg-commit",
    "dkg-reveal",
    "dkg-complete",
    "dkg-complaint",
];

/// Connect the organization a member's group controls (§3, §10.5): read and verify its key
/// ceremony from the relay, find the identity holding its HIGH group key (§9 "Which identity a
/// group controls"), and bind this Forge identity to the member with an `orgMember` carrying the
/// sealed share. Returns the local record and the ceremony's envelopes to keep beside it.
pub async fn connect(
    client: &PlatformClient,
    org_contract: &str,
    relay_url: &str,
    room: &str,
    seed: &Seed,
    keys: &MemberKeys,
    engine: &WriteEngine<'_>,
) -> Result<(OrgRecord, Vec<Value>)> {
    let relay = Relay::new(relay_url)?;
    let messages: Vec<Value> = relay
        .messages(room)
        .await?
        .into_iter()
        .filter(|m| CEREMONY_TYPES.contains(&m["type"].as_str().unwrap_or_default()))
        .collect();
    let state = reduce(&messages, Some(room));
    let network = client.network().key();
    let candidates = signing_ceremonies(&state);
    if candidates.is_empty() {
        return Err(Error::Config(
            "this group has no finished key ceremony yet: finish it in multisig.dashhq.org first"
                .into(),
        ));
    }
    let mine: Vec<&Ceremony> = candidates
        .into_iter()
        .filter(|c| c.config.index_of(&keys.auth_pub).is_some())
        .collect();
    if mine.is_empty() {
        return Err(OrgError::NotAMember.into());
    }
    if mine.iter().all(|c| c.config.network != network) {
        return Err(Error::Config(format!(
            "this group's organization is on {}, not {network}",
            mine[0].config.network
        )));
    }
    for c in mine {
        if c.config.network != network {
            continue;
        }
        let (slot, slot_keys) = signing_slot(c).expect("a signing ceremony");
        let key =
            hex::decode(&slot_keys.group_public_key).map_err(|e| Error::Config(e.to_string()))?;
        let Some(identity) = client.identity_by_public_key(&key).await? else {
            continue;
        };
        if !holds_group_key(&identity, slot.key_id, &slot_keys.group_public_key) {
            continue;
        }
        let record = OrgRecord {
            network: network.clone(),
            org_id: identity.id(),
            room: room.to_string(),
            relay: relay.url().to_string(),
            auth_pub: keys.auth_pub.clone(),
            label: c.config.label.clone(),
            threshold: c.config.threshold,
            members: c
                .config
                .participants
                .iter()
                .map(|p| MemberRecord {
                    index: p.index,
                    name: p.name.clone(),
                    auth_pub: p.auth_pub.clone(),
                })
                .collect(),
            dismissed: Vec::new(),
        };
        let mut org = Org::load(client, org_contract, record.clone(), messages.clone()).await?;
        org.ensure_member(client, engine, seed, keys).await?;
        return Ok((record, messages));
    }
    Err(Error::Config(format!(
        "no identity on {network} holds this group's key yet: create the organization's identity in multisig.dashhq.org first"
    )))
}

/// The organization's published roster, when its key is still the identity's enabled group key
/// (§10.1: otherwise it is stale and ignored).
pub async fn read_roster(
    client: &PlatformClient,
    contract: &LoadedContract,
    identity: &LoadedIdentity,
) -> Result<Option<Roster>> {
    let docs = client
        .query_documents(
            contract,
            transport::DOC_ORG,
            &[QueryFilter::eq(
                "$ownerId",
                FieldValue::identifier(crate::platform::decode_identifier(&identity.id())?),
            )],
            &[],
            1,
            None,
        )
        .await?;
    Ok(docs
        .first()
        .and_then(roster_of)
        .filter(|r| holds_group_key(identity, r.key_id, &r.group_key)))
}

fn roster_of(d: &FetchedDocument) -> Option<Roster> {
    Roster::from_props(&d.fields)
}

fn member_doc(d: &FetchedDocument) -> Option<MemberDoc> {
    Some(MemberDoc {
        id: d.id.clone(),
        owner: d.owner_id.clone(),
        created_at: d.created_at?,
        org: crate::platform::encode_identifier(d.field_bytes32("org")?),
        auth_pub: d.field_bytes("authPub")?,
        proof: d.field_bytes("proof")?,
    })
}

fn share_doc(d: &FetchedDocument) -> Option<ShareDoc> {
    Some(ShareDoc {
        owner: d.owner_id.clone(),
        org: crate::platform::encode_identifier(d.field_bytes32("org")?),
        cid: hex::encode(d.field_bytes("cid")?),
        sealed: d.field_bytes("sealed")?,
    })
}

fn message_doc(d: &FetchedDocument) -> Option<MessageDoc> {
    Some(MessageDoc {
        id: d.id.clone(),
        owner: d.owner_id.clone(),
        created_at: d.created_at?,
        digest: d.field_bytes("digest")?,
        part: d.field_u64("part")?,
        parts: d.field_u64("parts")?,
        fmt: d.field_u64("fmt")?,
        body: d.field_bytes("body")?,
    })
}

/// A connected organization with its current log.
pub struct Org {
    pub record: OrgRecord,
    pub state: RoomState,
    /// The published roster, when it is current.
    pub roster: Option<Roster>,
    ceremony: Vec<Value>,
    stand_in: Option<Ceremony>,
    timed: Vec<Timed>,
    members: Vec<MemberDoc>,
    bound: BTreeMap<String, Vec<String>>,
    /// This member's sealed shares read so far, by owner.
    shares: Vec<ShareDoc>,
    contract: LoadedContract,
    network: String,
    pub cid: String,
    pub slot: String,
    pub key_id: u32,
}

impl Org {
    /// Read the organization from Platform: its roster (or, before one is published, the cached
    /// key ceremony `ceremony`), its members' identities and their logs (§10.2).
    pub async fn load(
        client: &PlatformClient,
        org_contract: &str,
        record: OrgRecord,
        ceremony: Vec<Value>,
    ) -> Result<Self> {
        let contract = client.fetch_contract(org_contract).await?;
        let identity = client.fetch_identity(&record.org_id).await?;
        let roster = read_roster(client, &contract, &identity).await?;
        let network = client.network().key();
        let mut org = Self {
            record,
            state: RoomState::default(),
            roster,
            ceremony,
            stand_in: None,
            timed: Vec::new(),
            members: Vec::new(),
            bound: BTreeMap::new(),
            shares: Vec::new(),
            contract,
            network,
            cid: String::new(),
            slot: String::new(),
            key_id: 0,
        };
        org.bind_key(&identity)?;
        org.refresh(client).await?;
        Ok(org)
    }

    /// Pick the key the organization signs with: the published roster's (the cached transcript
    /// when it is the same ceremony), else the newest cached ceremony whose key the identity
    /// holds.
    fn bind_key(&mut self, identity: &LoadedIdentity) -> Result<()> {
        let cstate = reduce(&self.ceremony, Some(&self.record.room));
        let auth = self.record.auth_pub.clone();
        if let Some(r) = &self.roster {
            if !r.members.contains(&auth) {
                return Err(OrgError::NotAMember.into());
            }
            let transcript = signing_ceremonies(&cstate).into_iter().find(|c| {
                c.cid == r.cid && Roster::of_ceremony(c, None).is_some_and(|o| o.same_key(r))
            });
            if let Some((c, k)) = transcript.and_then(|c| signing_slot(c).map(|(k, _)| (c, k))) {
                (self.cid, self.slot, self.key_id) = (c.cid.clone(), k.slot.clone(), k.key_id);
                self.stand_in = None;
            } else {
                (self.cid, self.slot, self.key_id) =
                    (r.cid.clone(), transport::ROSTER_SLOT.to_string(), r.key_id);
                self.stand_in = Some(r.ceremony(&self.network, &self.record.label));
            }
            return Ok(());
        }
        let picked = signing_ceremonies(&cstate).into_iter().find_map(|c| {
            let (k, s) = signing_slot(c)?;
            (c.config.index_of(&auth).is_some()
                && holds_group_key(identity, k.key_id, &s.group_public_key))
            .then(|| (c.cid.clone(), k.slot.clone(), k.key_id))
        });
        let (cid, slot, key_id) = picked.ok_or_else(|| {
            Error::Config(format!(
                "{} has not published its roster, and its key ceremony is not on this computer: run `dg org connect {}` again",
                self.record.label, self.record.room
            ))
        })?;
        (self.cid, self.slot, self.key_id) = (cid, slot, key_id);
        self.stand_in = None;
        Ok(())
    }

    /// The organization's identity, with the key picked again (a group that re-ran its
    /// ceremony and published its roster again signs with the new key).
    pub async fn bind(&mut self, client: &PlatformClient) -> Result<LoadedIdentity> {
        let identity = client.fetch_identity(&self.record.org_id).await?;
        self.roster = read_roster(client, &self.contract, &identity).await?;
        self.bind_key(&identity)?;
        self.rebuild();
        Ok(identity)
    }

    /// The forge-org contract id.
    pub fn contract_id(&self) -> String {
        self.contract.id()
    }

    /// Read the members' identities and logs again.
    pub async fn refresh(&mut self, client: &PlatformClient) -> Result<()> {
        let org = crate::platform::decode_identifier(&self.record.org_id)?;
        let mut members = Vec::new();
        self.rebuild();
        for auth in self.member_keys() {
            let key: [u8; 32] = hex::decode(&auth)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| OrgError::Malformed(format!("{auth} is not a member key")))?;
            let docs = client
                .query_documents(
                    &self.contract,
                    transport::DOC_MEMBER,
                    &[
                        QueryFilter::eq("org", FieldValue::identifier(org)),
                        QueryFilter::eq("authPub", FieldValue::Bytes32(key)),
                    ],
                    &[QueryOrder::asc("$createdAt")],
                    MEMBER_DOCS_READ,
                    None,
                )
                .await?;
            members.extend(docs.iter().filter_map(member_doc));
        }
        self.members = members;
        self.rebind();
        let mut docs = Vec::new();
        for owner in self.bound.values().flatten() {
            let owner_id = crate::platform::decode_identifier(owner)?;
            let found = client
                .query_all_documents(
                    &self.contract,
                    transport::DOC_MESSAGE,
                    &[
                        QueryFilter::eq("org", FieldValue::identifier(org)),
                        QueryFilter::eq("$ownerId", FieldValue::identifier(owner_id)),
                    ],
                    &[QueryOrder::asc("$createdAt")],
                )
                .await?;
            docs.extend(found.iter().filter_map(message_doc));
        }
        self.timed = transport::merge(&transport::reassemble(&docs), &self.owner_keys());
        self.rebuild();
        Ok(())
    }

    fn rebind(&mut self) {
        let keys: BTreeSet<String> = self.member_keys();
        self.bound =
            transport::bind_identities(&self.members, &self.network, &self.record.org_id, &keys)
                .into_iter()
                .map(|(k, ds)| (k, ds.into_iter().map(|d| d.owner.clone()).collect()))
                .collect();
    }

    fn owner_keys(&self) -> BTreeMap<String, String> {
        self.bound
            .iter()
            .flat_map(|(k, os)| os.iter().map(move |o| (o.clone(), k.clone())))
            .collect()
    }

    fn rebuild(&mut self) {
        self.state = reduce_with(
            &self.ceremony,
            &self.timed,
            Some(&self.record.room),
            self.stand_in.iter().cloned().collect(),
        );
    }

    /// Whether `owner` (a Forge identity) is bound to the member key `auth_pub`.
    pub fn is_bound(&self, auth_pub: &str, owner: &str) -> bool {
        self.bound
            .get(auth_pub)
            .is_some_and(|os| os.iter().any(|o| o == owner))
    }

    /// Bind the engine's identity to this member (an `orgMember`) and keep its sealed share of
    /// the signing ceremony on Platform (an `orgShare`), each unless it already is (§10.5).
    /// Returns whether it wrote anything.
    pub async fn ensure_member(
        &mut self,
        client: &PlatformClient,
        engine: &WriteEngine<'_>,
        seed: &Seed,
        keys: &MemberKeys,
    ) -> Result<bool> {
        let wrote_member = self.ensure_bound(client, engine, keys).await?;
        let wrote_share = self.ensure_share(client, engine, seed, keys).await?;
        Ok(wrote_member || wrote_share)
    }

    async fn ensure_bound(
        &mut self,
        client: &PlatformClient,
        engine: &WriteEngine<'_>,
        keys: &MemberKeys,
    ) -> Result<bool> {
        let owner = engine.owner_id();
        if self.is_bound(&keys.auth_pub, &owner) {
            return Ok(false);
        }
        if !self.member_keys().contains(&keys.auth_pub) {
            return Err(OrgError::NotAMember.into());
        }
        if self.bound.get(&keys.auth_pub).map_or(0, Vec::len) >= transport::MAX_IDENTITIES_PER_KEY {
            return Err(Error::Config(format!(
                "your organization key is already linked to {} Forge identities in {}: sign in with one of them",
                transport::MAX_IDENTITIES_PER_KEY,
                self.record.label
            )));
        }
        let org = crate::platform::decode_identifier(&self.record.org_id)?;
        let taken = client
            .query_documents(
                &self.contract,
                transport::DOC_MEMBER,
                &[
                    QueryFilter::eq("org", FieldValue::identifier(org)),
                    QueryFilter::eq(
                        "$ownerId",
                        FieldValue::identifier(crate::platform::decode_identifier(&owner)?),
                    ),
                ],
                &[],
                1,
                None,
            )
            .await?;
        if !taken.is_empty() {
            return Err(Error::Config(format!(
                "this Forge identity is already linked to another member of {}: sign in with your own identity",
                self.record.label
            )));
        }
        let auth: [u8; 32] = hex::decode(&keys.auth_pub)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or(OrgError::NotAMember)?;
        let proof = transport::member_proof(keys, &self.network, &self.record.org_id, &owner);
        let props = BTreeMap::from([
            ("org".to_string(), FieldValue::identifier(org)),
            ("room".to_string(), FieldValue::text(&self.record.room)),
            ("authPub".to_string(), FieldValue::Bytes32(auth)),
            ("proof".to_string(), FieldValue::Bytes(proof.to_vec())),
        ]);
        let id = engine
            .create_document(&self.contract, transport::DOC_MEMBER, props)
            .await?;
        self.members.push(MemberDoc {
            id,
            owner,
            created_at: now_ms(),
            org: self.record.org_id.clone(),
            auth_pub: auth.to_vec(),
            proof: proof.to_vec(),
        });
        self.rebind();
        Ok(true)
    }

    /// Write this identity's `orgShare` for the signing ceremony when it has none and the share
    /// can be recovered here.
    async fn ensure_share(
        &mut self,
        client: &PlatformClient,
        engine: &WriteEngine<'_>,
        seed: &Seed,
        keys: &MemberKeys,
    ) -> Result<bool> {
        let owner = engine.owner_id();
        self.read_shares(client, &owner).await?;
        if self
            .shares
            .iter()
            .any(|s| s.owner == owner && s.cid == self.cid)
        {
            return Ok(false);
        }
        let Ok(mine) = self.my_share(seed, keys) else {
            return Ok(false);
        };
        let share = *mine.get(&self.slot).ok_or_else(|| self.no_key())?;
        let sealed = transport::seal_share_random(
            seed,
            &self.network,
            &self.record.org_id,
            &self.cid,
            &share,
        );
        let cid: [u8; 32] = hex::decode(&self.cid)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| self.no_key())?;
        let props = BTreeMap::from([
            (
                "org".to_string(),
                FieldValue::identifier(crate::platform::decode_identifier(&self.record.org_id)?),
            ),
            ("cid".to_string(), FieldValue::Bytes32(cid)),
            ("sealed".to_string(), FieldValue::Bytes(sealed.clone())),
        ]);
        engine
            .create_document(&self.contract, transport::DOC_SHARE, props)
            .await?;
        self.shares.push(ShareDoc {
            owner,
            org: self.record.org_id.clone(),
            cid: self.cid.clone(),
            sealed,
        });
        Ok(true)
    }

    /// Read `owner`'s `orgShare` of the signing ceremony, once.
    async fn read_shares(&mut self, client: &PlatformClient, owner: &str) -> Result<()> {
        if self
            .shares
            .iter()
            .any(|s| s.owner == owner && s.cid == self.cid)
        {
            return Ok(());
        }
        let cid: [u8; 32] = hex::decode(&self.cid)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| self.no_key())?;
        let docs = client
            .query_documents(
                &self.contract,
                transport::DOC_SHARE,
                &[
                    QueryFilter::eq(
                        "org",
                        FieldValue::identifier(crate::platform::decode_identifier(
                            &self.record.org_id,
                        )?),
                    ),
                    QueryFilter::eq(
                        "$ownerId",
                        FieldValue::identifier(crate::platform::decode_identifier(owner)?),
                    ),
                    QueryFilter::eq("cid", FieldValue::Bytes32(cid)),
                ],
                &[],
                1,
                None,
            )
            .await?;
        self.shares.extend(docs.iter().filter_map(share_doc));
        Ok(())
    }

    /// Read the sealed shares of every identity bound to this member's key (to sign from
    /// Platform alone).
    pub async fn load_my_shares(&mut self, client: &PlatformClient, auth_pub: &str) -> Result<()> {
        for owner in self.bound.get(auth_pub).cloned().unwrap_or_default() {
            self.read_shares(client, &owner).await?;
        }
        Ok(())
    }

    /// This member's share of the signing key: from the cached key ceremony, else from the
    /// sealed share on Platform (§10.1).
    pub fn my_share(&self, seed: &Seed, keys: &MemberKeys) -> Result<Shares> {
        let c = self.ceremony().ok_or_else(|| self.no_key())?;
        let index = c
            .config
            .index_of(&keys.auth_pub)
            .ok_or(OrgError::NotAMember)?;
        if c.has_transcript() {
            return Ok(member::recover_shares(seed, keys, &self.state, &self.cid)?);
        }
        let public = c
            .slot(&self.slot)
            .and_then(|(_, k)| k.public_shares.get(&index))
            .ok_or_else(|| self.no_key())?;
        let mine = self.bound.get(&keys.auth_pub);
        let opened = self
            .shares
            .iter()
            .filter(|d| d.cid == self.cid && d.org == self.record.org_id)
            .filter(|d| mine.is_some_and(|os| os.contains(&d.owner)))
            .filter_map(|d| {
                transport::open_share(
                    seed,
                    &self.network,
                    &self.record.org_id,
                    &self.cid,
                    &d.sealed,
                )
            })
            .find(|s| bls::g1_hex(&bls::g1(s)) == *public);
        opened
            .map(|s| Shares::single(&self.cid, index, &self.slot, s))
            .ok_or_else(|| {
                Error::Config(format!(
                    "your share of {}'s key is not on Platform and its key ceremony is not on this computer: run `dg org connect {}` again (wrong recovery phrase or passphrase?)",
                    self.record.label, self.record.room
                ))
            })
    }

    fn no_key(&self) -> Error {
        Error::Config(format!(
            "{} has no key ceremony you are in on this computer",
            self.record.label
        ))
    }

    /// Post one envelope as `orgMessage` documents written by the engine's identity (§10.3).
    async fn post(&mut self, engine: &WriteEngine<'_>, envelope: Value) -> Result<()> {
        let from = envelope["from"].as_str().unwrap_or_default().to_string();
        if !self.is_bound(&from, &engine.owner_id()) {
            return Err(Error::Config(format!(
                "this Forge identity is not linked to your key in {}: run `dg org connect {}` first",
                self.record.label, self.record.room
            )));
        }
        let encoded = transport::encode(&envelope)?;
        let org = crate::platform::decode_identifier(&self.record.org_id)?;
        let parts = encoded.parts.len() as u64;
        for (i, body) in encoded.parts.into_iter().enumerate() {
            let props = BTreeMap::from([
                ("org".to_string(), FieldValue::identifier(org)),
                ("digest".to_string(), FieldValue::Bytes32(encoded.digest)),
                ("part".to_string(), FieldValue::Integer(i as u64)),
                ("parts".to_string(), FieldValue::Integer(parts)),
                (
                    "fmt".to_string(),
                    FieldValue::Integer(u64::from(encoded.fmt)),
                ),
                ("body".to_string(), FieldValue::Bytes(body)),
            ]);
            engine
                .create_document(&self.contract, transport::DOC_MESSAGE, props)
                .await?;
        }
        let id = super::envelope::id(&envelope)?;
        if !self.timed.iter().any(|t| t.id == id) {
            self.timed.push(Timed {
                id,
                envelope,
                at: transport::iso_ms(now_ms()),
            });
        }
        self.rebuild();
        Ok(())
    }

    pub fn expect<'a>(&'a self, network: &'a str, forge: &'a ForgeIds) -> Expect<'a> {
        Expect {
            network,
            org_id: &self.record.org_id,
            key_id: self.key_id,
            cid: &self.cid,
            slot: &self.slot,
            forge,
            roster: self
                .ceremony()
                .and_then(|c| Roster::of_ceremony(c, Some(&self.record.relay))),
        }
    }

    /// `(collected, threshold)` for `req`.
    pub fn progress(&self, req: &Request) -> (usize, usize) {
        (request::collected(&self.state, req).0, self.threshold())
    }

    pub fn threshold(&self) -> usize {
        self.ceremony()
            .map_or(self.record.threshold, |c| c.config.threshold)
    }

    pub fn requests(&self) -> Vec<Request> {
        request::requests(&self.state, &self.cid)
    }

    pub fn find(&self, id: &str) -> Result<Request> {
        let all = self.requests();
        request::find(&all, id).cloned().ok_or_else(|| {
            Error::Config(format!(
                "{} has no request {id}: `dg org requests` lists them",
                self.record.label
            ))
        })
    }

    /// Whether every proposal of `req` writes as this organization (checked offline).
    pub fn writes_as_org(&self, req: &Request) -> bool {
        req.proposals.iter().all(|id| {
            self.decoded(id)
                .is_some_and(|d| d.owner_id == self.record.org_id)
        })
    }

    /// Requests waiting for this member's signature (signatures only, no chain read).
    pub fn waiting(&self) -> Vec<Request> {
        self.requests()
            .into_iter()
            .filter(|r| {
                request::waits_for(&self.state, r, &self.record.auth_pub)
                    && !self.unreachable(r)
                    && self.writes_as_org(r)
                    && !self.record.dismissed.contains(&r.id)
            })
            .collect()
    }

    /// The request's status and sentence (§9, §11.3, §11.6). `review`: the problems a review
    /// found; `chain`: what Platform says.
    pub fn summary(&self, req: &Request, chain: Option<&ChainView>, review: &[String]) -> Summary {
        match self.ceremony() {
            Some(c) => request::status(&self.state, req, c, chain, review),
            None => request::summarize(
                vec!["Forge has no key ceremony for it".into()],
                0,
                self.record.threshold,
                self.record.members.len(),
                &[],
            ),
        }
    }

    /// The nonces per contract that the organization's requests hold: every proposal a member
    /// made that the room accepted and that writes as the organization, whatever its request's
    /// status. A request still collecting that enough members declined, without approving,
    /// holds none. Web holds by the same rule.
    pub fn open_nonces(&self) -> BTreeMap<String, BTreeSet<u64>> {
        let mut out: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
        for r in self.requests() {
            if self.unreachable(&r) {
                continue;
            }
            for id in &r.proposals {
                let Some(p) = self.state.proposals.get(id) else {
                    continue;
                };
                if p.status == ProposalStatus::Invalid || !self.is_member(&p.from) {
                    continue;
                }
                if let Some(d) = self.decoded(id) {
                    if d.owner_id == self.record.org_id {
                        out.entry(d.contract_id.clone())
                            .or_default()
                            .insert(d.nonce);
                    }
                }
            }
        }
        out
    }

    /// The participants' auth keys of the signing key.
    pub fn member_keys(&self) -> BTreeSet<String> {
        self.ceremony()
            .map(|c| {
                c.config
                    .participants
                    .iter()
                    .map(|p| p.auth_pub.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The signing key's threshold and size (N of M).
    pub fn quorum(&self) -> (usize, usize) {
        self.ceremony()
            .map_or((self.record.threshold, self.record.members.len()), |c| {
                (c.config.threshold, c.config.participants.len())
            })
    }

    /// The ceremony the organization signs with (its transcript, or the roster standing in).
    pub fn ceremony(&self) -> Option<&Ceremony> {
        self.state.ceremonies.get(&self.cid)
    }

    fn is_member(&self, auth_pub: &str) -> bool {
        self.ceremony()
            .is_some_and(|c| c.config.index_of(auth_pub).is_some())
    }

    /// Whether `req` has no part with enough signatures and so many members declined it,
    /// without approving, that the rest cannot reach the threshold.
    fn unreachable(&self, req: &Request) -> bool {
        self.ceremony()
            .is_some_and(|c| request::declined_out(&self.state, req, c))
    }

    pub fn decoded(&self, proposal_id: &str) -> Option<DecodedWrite> {
        let p = self.state.proposals.get(proposal_id)?;
        decode_unsigned(&hex::decode(p.unsigned_hex()).ok()?).ok()
    }

    /// Review every proposal of `req` (§9), against Platform's current nonces, and re-run the
    /// member-change checks (§11.4).
    pub async fn review(
        &self,
        client: &PlatformClient,
        forge: &ForgeIds,
        req: &Request,
    ) -> Result<Vec<Reviewed>> {
        let network = client.network().key();
        let expect = self.expect(&network, forge);
        let mut nonces: BTreeMap<String, NonceState> = BTreeMap::new();
        let mut used: BTreeSet<(String, u64)> = BTreeSet::new();
        let mut out = Vec::new();
        for id in &req.proposals {
            let p = &self.state.proposals[id];
            let mut r = review::review_offline(&expect, p);
            if let Some(d) = &r.decoded {
                if !used.insert((d.contract_id.clone(), d.nonce)) {
                    r.problems
                        .push("it uses the same nonce as another part of this request".into());
                }
            }
            if let Some(d) = r.decoded.clone().filter(|_| r.problems.is_empty()) {
                let current = if let Some(n) = nonces.get(&d.contract_id) {
                    *n
                } else {
                    let n = client
                        .proved_contract_nonce(&self.record.org_id, &d.contract_id)
                        .await?;
                    nonces.insert(d.contract_id.clone(), n);
                    n
                };
                if let Some(problem) = review::nonce_problem(&d, current) {
                    if !request::landed(&d.action, &facts(client, &d).await?) {
                        r.nonce = Some(problem);
                    }
                }
                if let Some(problem) = self.member_change_problem(client, &d).await? {
                    r.problems.push(problem);
                }
            }
            out.push(r);
        }
        Ok(out)
    }

    /// §11.4: an organization can't change the members of a repository that has members-only
    /// content or environments (the creation check, re-run when signing and finishing).
    async fn member_change_problem(
        &self,
        client: &PlatformClient,
        d: &DecodedWrite,
    ) -> Result<Option<String>> {
        if !matches!(d.document_type.as_str(), "maintainer" | "writer") {
            return Ok(None);
        }
        let stored = review::stored_target(client, d).await?;
        let src = stored.as_ref().unwrap_or(d);
        let Some(repo_id) = review::referenced_ids(src).0.into_iter().next() else {
            return Ok(None);
        };
        let Ok(repo) = crate::resolve::resolve_id(client, &repo_id).await else {
            return Ok(None);
        };
        if super::actions::keyed(client, &repo).await? {
            let name = format!("{}/{}", self.record.label, repo.name());
            return Ok(Some(format!(
                "{name} now has members-only content or environments, so an organization can't change its members; decline this request"
            )));
        }
        Ok(None)
    }

    /// The problems a review found (the nonce aside, which `chain_view` reports as `expired`).
    pub fn review_problems(reviews: &[Reviewed]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in reviews.iter().flat_map(|r| r.problems.iter()) {
            if !out.contains(p) {
                out.push(p.clone());
            }
        }
        out
    }

    /// What Platform says about the request's parts (§11.6).
    pub async fn chain_view(&self, client: &PlatformClient, req: &Request) -> Result<ChainView> {
        let mut view = ChainView::new();
        for id in &req.proposals {
            let Some(d) = self.decoded(id) else { continue };
            if d.owner_id != self.record.org_id {
                continue;
            }
            let mut f = facts(client, &d).await?;
            if f.nonce_spent && !request::landed(&d.action, &f) {
                f.taken_by_other = self.nonce_landed_elsewhere(client, req, &d).await?;
            }
            view.insert(id.clone(), f);
        }
        Ok(view)
    }

    /// Whether another request's part is known to have landed with `d`'s nonce.
    async fn nonce_landed_elsewhere(
        &self,
        client: &PlatformClient,
        req: &Request,
        d: &DecodedWrite,
    ) -> Result<bool> {
        for other in self.requests() {
            if other.id == req.id {
                continue;
            }
            for id in &other.proposals {
                let Some(o) = self.decoded(id) else { continue };
                if o.owner_id == d.owner_id
                    && o.contract_id == d.contract_id
                    && o.nonce == d.nonce
                    && request::landed(&o.action, &facts(client, &o).await?)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// Names for describing `req`: repositories (those it creates included) and members.
    pub async fn names(&self, client: &PlatformClient, req: &Request) -> Names {
        let decoded: Vec<DecodedWrite> = req
            .proposals
            .iter()
            .filter_map(|id| self.decoded(id))
            .collect();
        self.names_of(client, &decoded).await
    }

    async fn names_of(&self, client: &PlatformClient, decoded: &[DecodedWrite]) -> Names {
        let mut names = Names::default();
        names
            .identities
            .insert(self.record.org_id.clone(), "the organization".into());
        for d in decoded {
            if d.document_type == "repo" {
                if let Some(n) = d.properties.get("name").and_then(|v| v.as_str()) {
                    names
                        .repos
                        .insert(d.document_id.clone(), format!("{}/{n}", self.record.label));
                }
            }
        }
        for d in decoded {
            let stored = review::stored_target(client, d).await.ok().flatten();
            let (mut repos, mut people) = review::referenced_ids(d);
            if let Some(s) = &stored {
                let (r, p) = review::referenced_ids(s);
                repos.extend(r);
                people.extend(p);
            }
            for id in repos {
                if names.repos.contains_key(&id) {
                    continue;
                }
                if let Ok(r) = crate::resolve::resolve_id(client, &id).await {
                    let owner = if r.owner_id() == self.record.org_id {
                        self.record.label.clone()
                    } else {
                        first_name(client, r.owner_id()).await
                    };
                    names.repos.insert(id, format!("{owner}/{}", r.name()));
                }
            }
            for id in people {
                if let std::collections::btree_map::Entry::Vacant(e) = names.identities.entry(id) {
                    let n = first_name(client, e.key()).await;
                    e.insert(n);
                }
            }
        }
        names
    }

    /// Describe each proposal of `req` in words.
    pub async fn describe(&self, client: &PlatformClient, req: &Request) -> Vec<String> {
        let decoded: Vec<Option<DecodedWrite>> =
            req.proposals.iter().map(|id| self.decoded(id)).collect();
        self.describe_all(client, &decoded).await
    }

    /// Describe writes not posted yet, as [`Self::describe`] would once they are.
    pub async fn describe_writes(
        &self,
        client: &PlatformClient,
        writes: &[UnsignedWrite],
    ) -> Vec<String> {
        let decoded: Vec<Option<DecodedWrite>> = writes
            .iter()
            .map(|w| decode_unsigned(&w.unsigned).ok())
            .collect();
        self.describe_all(client, &decoded).await
    }

    async fn describe_all(
        &self,
        client: &PlatformClient,
        decoded: &[Option<DecodedWrite>],
    ) -> Vec<String> {
        let known: Vec<DecodedWrite> = decoded.iter().flatten().cloned().collect();
        let names = self.names_of(client, &known).await;
        let mut out = Vec::new();
        for d in decoded {
            match d {
                Some(d) => {
                    let stored = review::stored_target(client, d).await.ok().flatten();
                    out.push(review::describe(d, stored.as_ref(), &names));
                }
                None => out.push("Unrecognized write".into()),
            }
        }
        out
    }

    /// Post `writes` as one request, then sign it with this member's share (§9 "Creating a
    /// request"). Returns the request.
    pub async fn propose(
        &mut self,
        client: &PlatformClient,
        engine: &WriteEngine<'_>,
        seed: &Seed,
        keys: &MemberKeys,
        title: &str,
        writes: Vec<UnsignedWrite>,
    ) -> Result<Request> {
        self.load_my_shares(client, &keys.auth_pub).await?;
        let shares = self.my_share(seed, keys)?;
        self.ensure_member(client, engine, seed, keys).await?;
        let group = request::new_group_id();
        let of = writes.len();
        let title = request::fit_title(title);
        let network = client.network().key();
        for (seq, w) in writes.into_iter().enumerate() {
            let derived = derived(&w);
            let mut intent = w.intent;
            intent["signer"]["cid"] = json!(self.cid);
            intent["signer"]["slot"] = json!(self.slot);
            let note = Note {
                group: group.clone(),
                seq,
                of,
                title: title.clone(),
            };
            let body = json!({
                "network": network,
                "unsigned": hex::encode(&w.unsigned),
                "signable": hex::encode(&w.signable),
                "requirements": [{ "cid": self.cid, "slot": self.slot }],
                "intent": intent,
                "derived": derived,
                "note": note.to_json(),
            });
            let envelope = seal(keys, &self.record.room, "proposal", body, &now_iso())?;
            self.post(engine, envelope).await?;
        }
        let id = request::request_id(&group, &keys.auth_pub);
        let req = self.find(&id)?;
        self.approve_all(engine, &shares, keys, &req).await?;
        self.find(&id)
    }

    async fn approve_all(
        &mut self,
        engine: &WriteEngine<'_>,
        shares: &Shares,
        keys: &MemberKeys,
        req: &Request,
    ) -> Result<usize> {
        let mut posted = 0;
        for id in &req.proposals {
            if self.state.proposals[id]
                .approvals
                .contains_key(&keys.auth_pub)
            {
                continue;
            }
            let envelope = member::approve(shares, keys, &self.state, id, &now_iso())?;
            self.post(engine, envelope).await?;
            posted += 1;
        }
        Ok(posted)
    }

    /// Review `req` and refuse it when it is not open or Forge won't sign it.
    async fn checked(
        &mut self,
        client: &PlatformClient,
        forge: &ForgeIds,
        req: &Request,
    ) -> Result<Vec<Reviewed>> {
        self.bind(client).await?;
        let reviews = self.review(client, forge, req).await?;
        let problems = Self::review_problems(&reviews);
        let summary = self.summary(req, None, &problems);
        if !summary.problems.is_empty() {
            return Err(refused(&req.id, &summary.problems));
        }
        if !summary.status.is_open() {
            return Err(not_open(&summary));
        }
        Ok(reviews)
    }

    /// Sign `req` after reviewing it; finish it when this signature completes it.
    pub async fn sign(
        &mut self,
        client: &PlatformClient,
        forge: &ForgeIds,
        engine: &WriteEngine<'_>,
        seed: &Seed,
        keys: &MemberKeys,
        req: &Request,
    ) -> Result<Signed> {
        let reviews = self.checked(client, forge, req).await?;
        let overtaken: Vec<String> = reviews.iter().filter_map(|r| r.nonce.clone()).collect();
        if !overtaken.is_empty() {
            return Err(refused(&req.id, &overtaken));
        }
        self.load_my_shares(client, &keys.auth_pub).await?;
        let shares = self.my_share(seed, keys)?;
        self.ensure_member(client, engine, seed, keys).await?;
        let posted = self.approve_all(engine, &shares, keys, req).await?;
        let req = self.find(&req.id)?;
        let ready = req.proposals.iter().all(|id| {
            matches!(
                self.state.proposals[id].status,
                ProposalStatus::Ready | ProposalStatus::Executed
            )
        });
        let finished = if ready {
            Some(self.finish(client, forge, engine, keys, &req).await?)
        } else {
            None
        };
        Ok(Signed { posted, finished })
    }

    /// Decline every proposal of `req` this member has not declined.
    pub async fn decline(
        &mut self,
        client: &PlatformClient,
        engine: &WriteEngine<'_>,
        seed: &Seed,
        keys: &MemberKeys,
        req: &Request,
        reason: &str,
    ) -> Result<usize> {
        self.ensure_member(client, engine, seed, keys).await?;
        let mut posted = 0;
        for id in &req.proposals {
            if self.state.proposals[id]
                .rejections
                .contains_key(&keys.auth_pub)
            {
                continue;
            }
            let envelope = member::reject(keys, &self.record.room, id, reason, &now_iso())?;
            self.post(engine, envelope).await?;
            posted += 1;
        }
        Ok(posted)
    }

    /// Each part's state on Platform now (§11.6), with its decoded write.
    async fn part_states(
        &self,
        client: &PlatformClient,
        req: &Request,
        reviews: &[Reviewed],
    ) -> Result<Vec<(DecodedWrite, PartState)>> {
        let mut used: BTreeSet<(String, u64)> = BTreeSet::new();
        let mut out = Vec::new();
        for (id, r) in req.proposals.iter().zip(reviews) {
            let d = r
                .decoded
                .clone()
                .ok_or_else(|| refused(&req.id, &["one of its parts can't be read".to_string()]))?;
            if !used.insert((d.contract_id.clone(), d.nonce)) {
                return Err(refused(
                    &req.id,
                    &["two of its parts use the same nonce".to_string()],
                ));
            }
            let p = &self.state.proposals[id];
            let ready = matches!(p.status, ProposalStatus::Ready | ProposalStatus::Executed);
            let mut f = facts(client, &d).await?;
            if f.nonce_spent && !request::landed(&d.action, &f) {
                f.taken_by_other = self.nonce_landed_elsewhere(client, req, &d).await?;
            }
            let state = request::part_state(
                &d.action,
                ready,
                p.status == ProposalStatus::Executed,
                Some(&f),
            );
            out.push((d, state));
        }
        Ok(out)
    }

    /// Combine, broadcast and confirm each ready part of `req` in order (§9 "Finishing"). Nothing
    /// is broadcast unless every part still to land can be: a ready delete never lands while the
    /// create that replaces it is short of signatures or overtaken.
    pub async fn finish(
        &mut self,
        client: &PlatformClient,
        forge: &ForgeIds,
        engine: &WriteEngine<'_>,
        keys: &MemberKeys,
        req: &Request,
    ) -> Result<Finished> {
        let reviews = self.checked(client, forge, req).await?;
        let parts = self.part_states(client, req, &reviews).await?;
        if parts.iter().any(|(_, s)| *s == PartState::Expired) {
            return Err(refused(
                &req.id,
                &["it was overtaken: another write used its nonce".to_string()],
            ));
        }
        if parts.iter().any(|(_, s)| *s == PartState::Collecting) {
            return Ok(Finished {
                broadcast: 0,
                done: false,
            });
        }
        let mut broadcast = 0;
        for (id, (d, state)) in req.proposals.clone().iter().zip(parts) {
            let claimed = self.state.proposals[id].status == ProposalStatus::Executed;
            if state.finished() {
                if !claimed {
                    self.report(engine, keys, id, json!({ "ok": true, "confirmed": true }))
                        .await?;
                }
                continue;
            }
            let current = client
                .proved_contract_nonce(&self.record.org_id, &d.contract_id)
                .await?;
            if let Some(problem) = review::nonce_problem(&d, current) {
                return Err(refused(&req.id, &[problem]));
            }
            let combined = member::combine(&self.state, id)?;
            let sig = combined
                .values()
                .next()
                .ok_or(OrgError::NotReady)?
                .signature;
            let unsigned = hex::decode(self.state.proposals[id].unsigned_hex()).unwrap_or_default();
            let signed = attach_signature(&unsigned, &sig)?;
            let outcome = client.broadcast_signed(&d.document_type, &signed).await;
            let ok = match outcome {
                Ok(BroadcastOutcome::Applied | BroadcastOutcome::AlreadyExists) => Ok(()),
                Ok(BroadcastOutcome::NonceConsumed) => {
                    if request::landed(&d.action, &facts(client, &d).await?) {
                        Ok(())
                    } else {
                        Err(Error::Config(
                            "another write by the organization used this request's nonce".into(),
                        ))
                    }
                }
                Err(e) => Err(e),
            };
            if let Err(e) = ok {
                self.report(
                    engine,
                    keys,
                    id,
                    json!({ "ok": false, "error": e.to_string() }),
                )
                .await?;
                return Err(e);
            }
            let confirmed = confirm(client, &d).await;
            self.report(
                engine,
                keys,
                id,
                json!({ "ok": true, "confirmed": confirmed }),
            )
            .await?;
            broadcast += 1;
        }
        Ok(Finished {
            broadcast,
            done: true,
        })
    }

    async fn report(
        &mut self,
        engine: &WriteEngine<'_>,
        keys: &MemberKeys,
        proposal_id: &str,
        result: Value,
    ) -> Result<()> {
        let envelope =
            member::record_broadcast(keys, &self.record.room, proposal_id, result, &now_iso())?;
        self.post(engine, envelope).await
    }

    /// The envelopes this member made in the relay room's open requests, to copy to Platform
    /// (§10.6): their proposals, approvals, declines and broadcast records. Never anyone
    /// else's, so nobody can drop or re-time another member's messages.
    pub fn migratable(
        relay_messages: &[Value],
        room: &str,
        cid: &str,
        auth_pub: &str,
    ) -> Vec<Value> {
        let state = reduce(relay_messages, Some(room));
        let open: BTreeSet<String> = request::requests(&state, cid)
            .into_iter()
            .filter(|r| {
                r.proposals.iter().any(|id| {
                    state
                        .proposals
                        .get(id)
                        .is_some_and(|p| p.status != ProposalStatus::Executed)
                })
            })
            .flat_map(|r| r.proposals)
            .collect();
        relay_messages
            .iter()
            .filter(|m| {
                let kind = m["type"].as_str().unwrap_or_default();
                if m["from"].as_str() != Some(auth_pub) || !super::envelope::verify(m) {
                    return false;
                }
                match kind {
                    "proposal" => super::envelope::id(m).is_ok_and(|id| open.contains(&id)),
                    "approve" | "reject" | "broadcast" => m["body"]["proposalId"]
                        .as_str()
                        .is_some_and(|id| open.contains(id)),
                    _ => false,
                }
            })
            .cloned()
            .collect()
    }

    /// Copy `envelopes` (this member's own, from the relay) to Platform; those already there
    /// are skipped. Returns how many were posted.
    pub async fn migrate(
        &mut self,
        client: &PlatformClient,
        engine: &WriteEngine<'_>,
        seed: &Seed,
        keys: &MemberKeys,
        envelopes: Vec<Value>,
    ) -> Result<usize> {
        self.ensure_member(client, engine, seed, keys).await?;
        let mut posted = 0;
        for e in envelopes {
            if e["from"].as_str() != Some(keys.auth_pub.as_str()) {
                continue;
            }
            let id = super::envelope::id(&e)?;
            if self.timed.iter().any(|t| t.id == id) {
                continue;
            }
            self.post(engine, e).await?;
            posted += 1;
        }
        Ok(posted)
    }
}

/// What signing did.
#[derive(Debug, Clone, Copy)]
pub struct Signed {
    pub posted: usize,
    pub finished: Option<Finished>,
}

/// What finishing did: parts broadcast now, and whether the whole request is on Platform.
#[derive(Debug, Clone, Copy)]
pub struct Finished {
    pub broadcast: usize,
    pub done: bool,
}

pub async fn first_name(client: &PlatformClient, id: &str) -> String {
    client
        .dpns_names_of(id)
        .await
        .ok()
        .and_then(|n| n.into_iter().next())
        .unwrap_or_else(|| id.to_string())
}

/// A proposal's `derived`: the document id, and a replace's new revision (as `dti` expects it).
pub(crate) fn derived(w: &UnsignedWrite) -> Value {
    let mut d = json!({ "documentId": w.document_id });
    if let Ok(decoded) = decode_unsigned(&w.unsigned) {
        if let (Some(r), "replace") = (decoded.revision, decoded.action.as_str()) {
            d["newRevision"] = json!(r.to_string());
        }
    }
    d
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// What Platform shows of `d`'s document and nonce.
async fn facts(client: &PlatformClient, d: &DecodedWrite) -> Result<PartFacts> {
    let contract = client.fetch_contract(&d.contract_id).await?;
    let doc = client
        .fetch_document(&contract, &d.document_type, &d.document_id)
        .await?;
    let nonce_spent = client
        .proved_contract_nonce(&d.owner_id, &d.contract_id)
        .await?
        .spent(d.nonce);
    let doc = match (d.action.as_str(), doc) {
        ("replace", Some(x)) if x.revision == d.revision => {
            if review::same_fields(&x.fields, &d.properties) {
                DocState::Same
            } else {
                DocState::Different
            }
        }
        ("replace", Some(x)) if x.revision > d.revision => DocState::Later,
        ("replace", _) => DocState::Different,
        (_, Some(_)) => DocState::Present,
        (_, None) => DocState::Absent,
    };
    Ok(PartFacts {
        nonce_spent,
        doc,
        taken_by_other: false,
    })
}

async fn confirm(client: &PlatformClient, d: &DecodedWrite) -> bool {
    for attempt in 1..=CONFIRM_ATTEMPTS {
        if facts(client, d)
            .await
            .is_ok_and(|f| request::landed(&d.action, &f))
        {
            return true;
        }
        if attempt < CONFIRM_ATTEMPTS {
            tokio::time::sleep(CONFIRM_DELAY).await;
        }
    }
    false
}
