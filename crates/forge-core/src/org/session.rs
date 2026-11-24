//! A connected organization: its group's log read from the relay, and the request flows
//! (§4, §9): create, sign, decline and finish.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::network::ForgeIds;
use crate::platform::org::{
    attach_signature, decode_unsigned, holds_group_key, DecodedWrite, NonceState, UnsignedWrite,
};
use crate::platform::{BroadcastOutcome, LoadedIdentity, PlatformClient};

use super::derive::{MemberKeys, Seed};
use super::envelope::{now_iso, seal};
use super::request::{self, ChainView, Note, Request, RequestStatus};
use super::review::{self, Expect, Names, Reviewed};
use super::state::{reduce, Ceremony, Proposal, ProposalStatus, RoomState};
use super::{member, signing_ceremonies, signing_slot, MemberRecord, OrgError, OrgRecord, Relay};

const CONFIRM_ATTEMPTS: usize = 8;
const CONFIRM_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

fn refused(what: &str, problems: &[String]) -> Error {
    Error::Config(format!(
        "Forge won't {what}: {}",
        super::one_line(&problems.join("; "))
    ))
}

/// The organization a member's group controls, as a local record (§9 "Which identity a group
/// controls"): the newest completed ceremony this member is in whose HIGH group key is an enabled
/// key of an identity on this network.
pub async fn connect(
    client: &PlatformClient,
    relay_url: &str,
    room: &str,
    keys: &MemberKeys,
) -> Result<(OrgRecord, LoadedIdentity)> {
    let relay = Relay::new(relay_url)?;
    let messages = relay.messages(room).await?;
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
        };
        return Ok((record, identity));
    }
    Err(Error::Config(format!(
        "no identity on {network} holds this group's key yet: create the organization's identity in multisig.dashhq.org first"
    )))
}

/// A connected organization with its group's current log.
pub struct Org {
    pub record: OrgRecord,
    pub state: RoomState,
    messages: Vec<Value>,
    relay: Relay,
    pub cid: String,
    pub slot: String,
    pub key_id: u32,
}

impl Org {
    /// Read the group's log; sign with the newest finished ceremony this member is in.
    pub async fn load(record: OrgRecord) -> Result<Self> {
        let relay = Relay::new(&record.relay)?;
        let messages = relay.messages(&record.room).await?;
        let mut org = Self {
            record,
            state: RoomState::default(),
            messages,
            relay,
            cid: String::new(),
            slot: String::new(),
            key_id: 0,
        };
        org.rebuild();
        let auth = org.record.auth_pub.clone();
        let picked = signing_ceremonies(&org.state)
            .into_iter()
            .find(|c| c.config.index_of(&auth).is_some())
            .and_then(|c| signing_slot(c).map(|(k, _)| (c.cid.clone(), k.slot.clone(), k.key_id)));
        let Some((cid, slot, key_id)) = picked else {
            return Err(Error::Config(format!(
                "the group of {} has no finished key ceremony you are in",
                org.record.label
            )));
        };
        (org.cid, org.slot, org.key_id) = (cid, slot, key_id);
        Ok(org)
    }

    fn rebuild(&mut self) {
        self.state = reduce(&self.messages, Some(&self.record.room));
    }

    pub async fn refresh(&mut self) -> Result<()> {
        self.messages = self.relay.messages(&self.record.room).await?;
        self.rebuild();
        Ok(())
    }

    async fn post(&mut self, envelope: Value) -> Result<()> {
        self.relay.post(&self.record.room, &envelope).await?;
        self.messages.push(envelope);
        self.rebuild();
        Ok(())
    }

    /// The organization's identity, and the ceremony whose key it holds (picked again: a group
    /// that re-ran its ceremony signs with the one on Platform).
    pub async fn bind(&mut self, client: &PlatformClient) -> Result<LoadedIdentity> {
        let identity = client.fetch_identity(&self.record.org_id).await?;
        let auth = self.record.auth_pub.clone();
        let picked = signing_ceremonies(&self.state).into_iter().find_map(|c| {
            let (k, s) = signing_slot(c)?;
            (c.config.index_of(&auth).is_some()
                && holds_group_key(&identity, k.key_id, &s.group_public_key))
            .then(|| (c.cid.clone(), k.slot.clone(), k.key_id))
        });
        let (cid, slot, key_id) = picked.ok_or_else(|| {
            Error::Config(format!(
                "{} no longer holds a key from a ceremony you are in",
                self.record.label
            ))
        })?;
        (self.cid, self.slot, self.key_id) = (cid, slot, key_id);
        Ok(identity)
    }

    pub fn expect<'a>(&'a self, network: &'a str, forge: &'a ForgeIds) -> Expect<'a> {
        Expect {
            network,
            org_id: &self.record.org_id,
            key_id: self.key_id,
            cid: &self.cid,
            slot: &self.slot,
            forge,
        }
    }

    /// `(collected, threshold)` for `req`.
    pub fn progress(&self, req: &Request) -> (usize, usize) {
        (request::collected(&self.state, req).0, self.threshold())
    }

    pub fn threshold(&self) -> usize {
        self.state
            .ceremonies
            .get(&self.cid)
            .map_or(self.record.threshold, |c| c.config.threshold)
    }

    pub fn requests(&self) -> Vec<Request> {
        request::requests(&self.state, &self.cid, &self.members())
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

    /// Refuse a request whose parts do not form a whole one, or that is no longer open.
    fn require_open(&self, req: &Request, what: &str) -> Result<()> {
        if let Some(problem) = &req.problem {
            return Err(refused(what, std::slice::from_ref(problem)));
        }
        let status = request::status(&self.state, req, None);
        if status.is_open() {
            Ok(())
        } else {
            Err(refused(what, &[format!("it is {}", status.label())]))
        }
    }

    /// Whether every proposal of `req` writes as this organization (checked offline).
    pub fn writes_as_org(&self, req: &Request) -> bool {
        req.proposals.iter().all(|id| {
            self.decoded(id)
                .is_some_and(|d| d.owner_id == self.record.org_id)
        })
    }

    /// Requests waiting for this member's signature (no Platform read).
    pub fn waiting(&self) -> Vec<Request> {
        self.requests()
            .into_iter()
            .filter(|r| {
                request::waits_for(&self.state, r, &self.record.auth_pub) && self.writes_as_org(r)
            })
            .collect()
    }

    /// The nonces per contract that the organization's requests hold: every proposal a member
    /// made that the room accepted and that writes as the organization, whatever its request's
    /// status: a landed nonce is at or below the tip, below anything handed out, and a later
    /// part of an overtaken request keeps its nonce until the tip passes it (it can no longer be
    /// finished through Forge, so that nonce is simply skipped).
    /// A request still collecting that enough members declined, without approving, holds none.
    /// Web holds by the same rule.
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

    /// The participants of the ceremony this member signs with.
    fn members(&self) -> BTreeSet<String> {
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

    /// The signing ceremony's threshold and size (N of M).
    pub fn quorum(&self) -> (usize, usize) {
        self.ceremony()
            .map_or((self.record.threshold, self.record.members.len()), |c| {
                (c.config.threshold, c.config.participants.len())
            })
    }

    fn ceremony(&self) -> Option<&Ceremony> {
        self.state.ceremonies.get(&self.cid)
    }

    fn is_member(&self, auth_pub: &str) -> bool {
        self.ceremony()
            .is_some_and(|c| c.config.index_of(auth_pub).is_some())
    }

    /// Whether `req` is still collecting and so many members declined it, without approving,
    /// that the rest cannot reach the threshold.
    fn unreachable(&self, req: &Request) -> bool {
        let ps: Vec<&Proposal> = req
            .proposals
            .iter()
            .filter_map(|id| self.state.proposals.get(id))
            .collect();
        if ps
            .iter()
            .any(|p| matches!(p.status, ProposalStatus::Ready | ProposalStatus::Executed))
        {
            return false;
        }
        let approved: BTreeSet<&str> = ps
            .iter()
            .flat_map(|p| p.approvals.keys().map(String::as_str))
            .collect();
        let declined = ps
            .iter()
            .flat_map(|p| p.rejections.keys().map(String::as_str))
            .filter(|k| self.is_member(k) && !approved.contains(k))
            .collect::<BTreeSet<_>>()
            .len();
        let (size, threshold) = self.ceremony().map_or((0, 0), |c| {
            (c.config.participants.len(), c.config.threshold)
        });
        declined > size.saturating_sub(threshold)
    }

    pub fn decoded(&self, proposal_id: &str) -> Option<DecodedWrite> {
        let p = self.state.proposals.get(proposal_id)?;
        decode_unsigned(&hex::decode(p.unsigned_hex()).ok()?).ok()
    }

    /// Review every proposal of `req` (§9), against Platform's current nonces.
    pub async fn review(
        &self,
        client: &PlatformClient,
        forge: &ForgeIds,
        req: &Request,
    ) -> Result<Vec<Reviewed>> {
        let network = client.network().key();
        let expect = self.expect(&network, forge);
        let mut nonces: BTreeMap<String, NonceState> = BTreeMap::new();
        let mut out = Vec::new();
        for id in &req.proposals {
            let p = &self.state.proposals[id];
            let mut r = review::review_offline(&expect, p);
            if let Some(d) = r.decoded.as_ref().filter(|_| r.problems.is_empty()) {
                let current = if let Some(n) = nonces.get(&d.contract_id) {
                    *n
                } else {
                    let n = client
                        .proved_contract_nonce(&self.record.org_id, &d.contract_id)
                        .await?;
                    nonces.insert(d.contract_id.clone(), n);
                    n
                };
                if p.status != ProposalStatus::Executed {
                    if let Some(problem) = review::nonce_problem(d, current) {
                        if !landed(client, d).await.unwrap_or(false) {
                            r.problems.push(problem);
                        }
                    }
                }
            }
            out.push(r);
        }
        Ok(out)
    }

    /// What Platform says about the request's proposals (§9 `done` and `expired`).
    pub async fn chain_view(&self, client: &PlatformClient, req: &Request) -> Result<ChainView> {
        let mut view = ChainView::default();
        for id in &req.proposals {
            let Some(d) = self.decoded(id) else { continue };
            if d.owner_id != self.record.org_id {
                continue;
            }
            if self.state.proposals[id].status == ProposalStatus::Executed {
                if self.executed_unproven(client, id).await? {
                    view.unproven.insert(id.clone());
                }
                continue;
            }
            let current = client
                .proved_contract_nonce(&self.record.org_id, &d.contract_id)
                .await?;
            if current.spent(d.nonce) {
                view.spent.insert(id.clone());
                if landed(client, &d).await? {
                    view.landed.insert(id.clone());
                }
            }
        }
        Ok(view)
    }

    /// Whether a proposal a member reported executed cannot have landed: its nonce is still
    /// free. A member's report is a claim, and a write that lands spends its nonce.
    async fn executed_unproven(&self, client: &PlatformClient, id: &str) -> Result<bool> {
        let Some(d) = self.decoded(id) else {
            return Ok(false);
        };
        Ok(!client
            .proved_contract_nonce(&self.record.org_id, &d.contract_id)
            .await?
            .spent(d.nonce))
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
        seed: &Seed,
        keys: &MemberKeys,
        title: &str,
        writes: Vec<UnsignedWrite>,
    ) -> Result<Request> {
        member::recover_shares(seed, keys, &self.state, &self.cid)?;
        let group = request::new_group_id();
        let of = writes.len();
        let title = request::fit_title(title);
        let network = client.network().key();
        for (seq, w) in writes.into_iter().enumerate() {
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
                "derived": { "documentId": w.document_id },
                "note": note.to_json(),
            });
            let envelope = seal(keys, &self.record.room, "proposal", body, &now_iso())?;
            self.post(envelope).await?;
        }
        let req = self.find(&group)?;
        self.approve_all(seed, keys, &req).await?;
        self.find(&group)
    }

    async fn approve_all(
        &mut self,
        seed: &Seed,
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
            let envelope = member::approve(seed, keys, &self.state, id, &now_iso())?;
            self.post(envelope).await?;
            posted += 1;
        }
        Ok(posted)
    }

    /// Sign `req` after reviewing it; finish it when this signature completes it.
    pub async fn sign(
        &mut self,
        client: &PlatformClient,
        forge: &ForgeIds,
        seed: &Seed,
        keys: &MemberKeys,
        req: &Request,
    ) -> Result<Signed> {
        self.require_open(req, "sign this request")?;
        self.bind(client).await?;
        let problems: Vec<String> = self
            .review(client, forge, req)
            .await?
            .into_iter()
            .flat_map(|r| r.problems)
            .collect();
        if !problems.is_empty() {
            return Err(refused("sign this request", &problems));
        }
        member::recover_shares(seed, keys, &self.state, &self.cid)?;
        let posted = self.approve_all(seed, keys, req).await?;
        let req = self.find(&req.id)?;
        let finished = if request::status(&self.state, &req, None) == RequestStatus::Ready {
            Some(self.finish(client, forge, keys, &req).await?)
        } else {
            None
        };
        Ok(Signed { posted, finished })
    }

    /// Decline every proposal of `req` this member has not declined.
    pub async fn decline(
        &mut self,
        keys: &MemberKeys,
        req: &Request,
        reason: &str,
    ) -> Result<usize> {
        let mut posted = 0;
        for id in &req.proposals {
            if self.state.proposals[id]
                .rejections
                .contains_key(&keys.auth_pub)
            {
                continue;
            }
            let envelope = member::reject(keys, &self.record.room, id, reason, &now_iso())?;
            self.post(envelope).await?;
            posted += 1;
        }
        Ok(posted)
    }

    /// Whether every part of `req` still to land can be broadcast now: nothing is, otherwise, so
    /// a ready delete never lands while the create that replaces it is short of signatures or
    /// overtaken.
    async fn can_finish(
        &self,
        client: &PlatformClient,
        forge: &ForgeIds,
        network: &str,
        req: &Request,
    ) -> Result<bool> {
        for id in &req.proposals {
            let p = &self.state.proposals[id];
            if p.status == ProposalStatus::Executed && !self.executed_unproven(client, id).await? {
                continue;
            }
            let reviewed = review::review_offline(&self.expect(network, forge), p);
            let Some(d) = reviewed.decoded.as_ref().filter(|_| reviewed.ok()) else {
                return Err(refused("broadcast this request", &reviewed.problems));
            };
            if landed(client, d).await? {
                continue;
            }
            if matches!(p.status, ProposalStatus::Ready | ProposalStatus::Executed) {
                let current = client
                    .proved_contract_nonce(&self.record.org_id, &d.contract_id)
                    .await?;
                match review::nonce_problem(d, current) {
                    None => continue,
                    Some(problem) => return Err(refused("broadcast this request", &[problem])),
                }
            }
            return Ok(false);
        }
        Ok(true)
    }

    /// Combine, broadcast and confirm each ready proposal of `req` in order (§9 "Finishing").
    pub async fn finish(
        &mut self,
        client: &PlatformClient,
        forge: &ForgeIds,
        keys: &MemberKeys,
        req: &Request,
    ) -> Result<Finished> {
        if let Some(problem) = &req.problem {
            return Err(refused(
                "broadcast this request",
                std::slice::from_ref(problem),
            ));
        }
        self.bind(client).await?;
        let network = client.network().key();
        if !self.can_finish(client, forge, &network, req).await? {
            return Ok(Finished {
                broadcast: 0,
                done: false,
            });
        }
        let mut broadcast = 0;
        for id in &req.proposals {
            let p = &self.state.proposals[id];
            if p.status == ProposalStatus::Executed && !self.executed_unproven(client, id).await? {
                continue;
            }
            let reviewed = review::review_offline(&self.expect(&network, forge), p);
            if !reviewed.ok() {
                return Err(refused("broadcast this request", &reviewed.problems));
            }
            let d = reviewed.decoded.expect("reviewed");
            if landed(client, &d).await? {
                self.report(keys, id, json!({ "ok": true, "confirmed": true }))
                    .await?;
                continue;
            }
            if !matches!(p.status, ProposalStatus::Ready | ProposalStatus::Executed) {
                return Ok(Finished {
                    broadcast,
                    done: false,
                });
            }
            let current = client
                .proved_contract_nonce(&self.record.org_id, &d.contract_id)
                .await?;
            if let Some(problem) = review::nonce_problem(&d, current) {
                if landed(client, &d).await? {
                    self.report(keys, id, json!({ "ok": true, "confirmed": true }))
                        .await?;
                    continue;
                }
                return Err(refused("broadcast this request", &[problem]));
            }
            let combined = member::combine(&self.state, id)?;
            let sig = combined
                .values()
                .next()
                .ok_or(OrgError::NotReady)?
                .signature;
            let signed =
                attach_signature(&hex::decode(p.unsigned_hex()).unwrap_or_default(), &sig)?;
            let outcome = client.broadcast_signed(&d.document_type, &signed).await;
            let ok = match outcome {
                Ok(BroadcastOutcome::Applied | BroadcastOutcome::AlreadyExists) => Ok(()),
                Ok(BroadcastOutcome::NonceConsumed) => {
                    if landed(client, &d).await? {
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
                self.report(keys, id, json!({ "ok": false, "error": e.to_string() }))
                    .await?;
                return Err(e);
            }
            let confirmed = confirm(client, &d).await;
            self.report(keys, id, json!({ "ok": true, "confirmed": confirmed }))
                .await?;
            broadcast += 1;
        }
        Ok(Finished {
            broadcast,
            done: true,
        })
    }

    async fn report(&mut self, keys: &MemberKeys, proposal_id: &str, result: Value) -> Result<()> {
        let envelope =
            member::record_broadcast(keys, &self.record.room, proposal_id, result, &now_iso())?;
        self.post(envelope).await
    }
}

/// What signing did.
#[derive(Debug, Clone, Copy)]
pub struct Signed {
    pub posted: usize,
    pub finished: Option<Finished>,
}

/// What finishing did: proposals broadcast now, and whether the whole request is on Platform.
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

/// Whether the write `d` is visible on Platform: a create's or replace's document exists (at its
/// revision), a delete's is gone and its nonce is spent.
async fn landed(client: &PlatformClient, d: &DecodedWrite) -> Result<bool> {
    let contract = client.fetch_contract(&d.contract_id).await?;
    let doc = client
        .fetch_document(&contract, &d.document_type, &d.document_id)
        .await?;
    Ok(match d.action.as_str() {
        "create" => doc.is_some(),
        "replace" => match doc {
            Some(x) if x.revision == d.revision => review::same_fields(&x.fields, &d.properties),
            Some(x) if x.revision > d.revision => client
                .proved_contract_nonce(&d.owner_id, &d.contract_id)
                .await?
                .spent(d.nonce),
            _ => false,
        },
        "delete" => {
            doc.is_none()
                && client
                    .proved_contract_nonce(&d.owner_id, &d.contract_id)
                    .await?
                    .spent(d.nonce)
        }
        _ => false,
    })
}

async fn confirm(client: &PlatformClient, d: &DecodedWrite) -> bool {
    for attempt in 1..=CONFIRM_ATTEMPTS {
        if landed(client, d).await.unwrap_or(false) {
            return true;
        }
        if attempt < CONFIRM_ATTEMPTS {
            tokio::time::sleep(CONFIRM_DELAY).await;
        }
    }
    false
}
