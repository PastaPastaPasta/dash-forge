//! The last-writer-wins slot document (`identity-synced-state.md` §4): `{"format":
//! "forge-user/<slot>", "version": 1, "entries": {key: {"at": ms, "v": value | null}}}`.
//! Entries and top-level fields this client does not understand are kept and written back.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// The version this client writes.
pub const DOC_VERSION: u64 = 1;

/// One entry: when it was written (ms) and its value, `None` for a tombstone.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// When it was written, in ms.
    pub at: u64,
    /// The value; `None` (JSON `null`) is a tombstone.
    #[serde(default)]
    pub v: Option<Value>,
    /// Fields of an entry this client does not know.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entry")
            .field("at", &self.at)
            .field("live", &self.v.is_some())
            .finish_non_exhaustive()
    }
}

impl Entry {
    /// A live entry.
    pub fn live(at: u64, v: Value) -> Self {
        Self {
            at,
            v: Some(v),
            extra: Map::new(),
        }
    }

    /// A tombstone.
    pub fn tombstone(at: u64) -> Self {
        Self {
            at,
            v: None,
            extra: Map::new(),
        }
    }

    /// Whether `self` wins over `other`: the later `at`; on a tie, the larger canonical JSON
    /// (so every client picks the same one).
    fn beats(&self, other: &Entry) -> bool {
        match self.at.cmp(&other.at) {
            std::cmp::Ordering::Greater => true,
            std::cmp::Ordering::Less => false,
            std::cmp::Ordering::Equal => {
                serde_json::to_string(self).unwrap_or_default()
                    > serde_json::to_string(other).unwrap_or_default()
            }
        }
    }
}

/// A slot's plaintext.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct SlotDoc {
    /// `forge-user/<slot>`.
    pub format: String,
    /// The format version.
    pub version: u64,
    /// The entries, by key.
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
    /// Top-level fields this client does not know.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl std::fmt::Debug for SlotDoc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlotDoc")
            .field("format", &self.format)
            .field("version", &self.version)
            .field("keys", &self.entries.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl SlotDoc {
    /// An empty document for `slot`.
    pub fn new(slot: &str) -> Self {
        Self {
            format: format!("forge-user/{slot}"),
            version: DOC_VERSION,
            entries: BTreeMap::new(),
            extra: Map::new(),
        }
    }

    /// Parse a decrypted slot, refusing one that is not `forge-user/<slot>`.
    pub fn parse(slot: &str, json: &[u8]) -> Result<Self> {
        let doc: SlotDoc = serde_json::from_slice(json)
            .map_err(|_| Error::InvalidInput(format!("the synced {slot} settings do not parse")))?;
        if doc.format != format!("forge-user/{slot}") || doc.version == 0 {
            return Err(Error::InvalidInput(format!(
                "the synced {slot} settings are in another format ({})",
                doc.format
            )));
        }
        Ok(doc)
    }

    /// The canonical JSON bytes (sorted keys, no spaces).
    pub fn to_json(&self) -> Result<Vec<u8>> {
        let v = serde_json::to_value(self)
            .map_err(|e| Error::InvalidInput(format!("serializing synced settings: {e}")))?;
        Ok(canonical_json(&v))
    }

    /// The live value of `key`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.get(key).and_then(|e| e.v.as_ref())
    }

    /// Set `key` to `v` at `at`, unless a later write is already there. Returns whether it changed.
    pub fn set(&mut self, key: &str, at: u64, v: Value) -> bool {
        self.put(key, Entry::live(at, v))
    }

    /// Tombstone `key` at `at`, unless a later write is already there.
    pub fn remove(&mut self, key: &str, at: u64) -> bool {
        self.put(key, Entry::tombstone(at))
    }

    fn put(&mut self, key: &str, entry: Entry) -> bool {
        match self.entries.get(key) {
            Some(old) if !entry.beats(old) => false,
            _ => {
                self.entries.insert(key.to_string(), entry);
                true
            }
        }
    }

    /// Merge `other` into `self`, entry by entry (last writer wins). Unknown top-level fields of
    /// either are kept; the higher version is kept.
    pub fn merge(&mut self, other: &SlotDoc) {
        for (k, e) in &other.entries {
            self.put(k, e.clone());
        }
        for (k, v) in &other.extra {
            self.extra.entry(k.clone()).or_insert_with(|| v.clone());
        }
        self.version = self.version.max(other.version);
    }

    /// The highest `at` in the document (0 when empty).
    pub fn latest(&self) -> u64 {
        self.entries.values().map(|e| e.at).max().unwrap_or(0)
    }
}

/// `value` as canonical JSON: object keys sorted, no whitespace (what gen.py writes).
pub fn canonical_json(value: &Value) -> Vec<u8> {
    fn sort(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let sorted: BTreeMap<&String, Value> =
                    m.iter().map(|(k, v)| (k, sort(v))).collect();
                Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
            }
            Value::Array(a) => Value::Array(a.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_vec(&sort(value)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(entries: Value) -> SlotDoc {
        serde_json::from_value(
            json!({"format": "forge-user/storage", "version": 1, "entries": entries}),
        )
        .unwrap()
    }

    #[test]
    fn later_writes_win_and_tombstones_hide() {
        let mut a =
            doc(json!({"profile:a": {"at": 5, "v": {"x": 1}}, "profile:b": {"at": 1, "v": 1}}));
        let b =
            doc(json!({"profile:a": {"at": 4, "v": {"x": 2}}, "profile:b": {"at": 2, "v": null}}));
        a.merge(&b);
        assert_eq!(a.get("profile:a"), Some(&json!({"x": 1})));
        assert_eq!(a.get("profile:b"), None);
        assert!(a.entries.contains_key("profile:b"));
        assert!(!a.set("profile:a", 3, json!(0)));
        assert!(a.set("profile:a", 6, json!(0)));
    }

    #[test]
    fn merge_is_symmetric_on_ties() {
        let x = doc(json!({"k": {"at": 1, "v": "a"}}));
        let y = doc(json!({"k": {"at": 1, "v": "b"}}));
        let mut xy = x.clone();
        xy.merge(&y);
        let mut yx = y.clone();
        yx.merge(&x);
        assert_eq!(xy.to_json().unwrap(), yx.to_json().unwrap());
    }

    #[test]
    fn unknown_entries_and_fields_round_trip() {
        let raw = json!({
            "format": "forge-user/storage", "version": 2, "future": {"a": 1},
            "entries": {"newkind:x": {"at": 9, "v": {"q": true}, "by": "web"}}
        });
        let mut d = SlotDoc::parse("storage", &serde_json::to_vec(&raw).unwrap()).unwrap();
        d.set("profile:mine", 10, json!({"settings": {}}));
        let back: Value = serde_json::from_slice(&d.to_json().unwrap()).unwrap();
        assert_eq!(back["future"], json!({"a": 1}));
        assert_eq!(back["version"], json!(2));
        assert_eq!(
            back["entries"]["newkind:x"],
            json!({"at": 9, "v": {"q": true}, "by": "web"})
        );
        assert!(SlotDoc::parse("prefs", &serde_json::to_vec(&raw).unwrap()).is_err());
    }

    #[test]
    fn canonical_json_matches_python_sort_keys() {
        let v = json!({"b": 1, "a": {"d": [ {"z": 1, "y": 2} ], "c": null}});
        assert_eq!(
            String::from_utf8(canonical_json(&v)).unwrap(),
            r#"{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}"#
        );
    }
}
