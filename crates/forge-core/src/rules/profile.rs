//! The profile rules both clients share (`docs/contracts/forge-v2.md` §2, forge-community
//! `profile`): what a profile edit may hold, how it is normalized before it is signed, and how a
//! reader interprets `avatarConfig`. The TypeScript half is `forge-web/lib/rules/profile.ts`; the
//! `profile_input` and `avatar_config` vectors in `forge-contracts/vectors/` hold them equal.
//!
//! The contract bounds each field (characters and UTF-8 bytes) and pins `links` to https. The
//! client rules here add: surrounding whitespace is trimmed and an empty field is absent; no
//! control characters (a bio may hold line breaks and tabs); links are deduplicated, and a link
//! holds no whitespace at all (the contract's `[:space:]` is ASCII only); `avatarConfig` is one
//! of the conventions [`avatar_spec`] reads.

use serde::{Deserialize, Serialize};

/// The profile's text fields a person edits, in the order every report lists them.
pub const PROFILE_FIELDS: [&str; 6] = [
    "displayName",
    "bio",
    "avatarConfig",
    "links",
    "location",
    "company",
];

/// At most this many links (`links.maxItems`).
pub const MAX_LINKS: usize = 4;

/// The contract's bound on one field: characters (Unicode scalar values) and UTF-8 bytes.
#[derive(Debug, Clone, Copy)]
pub struct Limit {
    pub chars: usize,
    pub bytes: usize,
}

/// The bound on `field` (`link` for one entry of `links`).
pub fn limit(field: &str) -> Limit {
    match field {
        "displayName" | "location" | "company" => Limit {
            chars: 60,
            bytes: 240,
        },
        "bio" => Limit {
            chars: 500,
            bytes: 1000,
        },
        "avatarConfig" => Limit {
            chars: 200,
            bytes: 200,
        },
        _ => Limit {
            chars: 200,
            bytes: 800,
        },
    }
}

/// What a profile edit sets; an absent or blank field is not set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub avatar_config: Option<String>,
    #[serde(default)]
    pub links: Option<Vec<String>>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub company: Option<String>,
}

/// A normalized profile: only the fields that are set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFields {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub avatar_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub links: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub company: Option<String>,
}

/// The result the `profile_input` vectors pin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileCheck {
    pub valid: bool,
    /// The fields that break a rule, in [`PROFILE_FIELDS`] order.
    pub invalid: Vec<String>,
    /// The fields to store when valid.
    pub normalized: Option<ProfileFields>,
}

/// How a reader draws an identity's avatar from `profile.avatarConfig`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AvatarSpec {
    /// No `avatarConfig`: the identicon of the identity id.
    Default,
    /// `identicon` or `identicon:<seed>`: a pattern drawn from the seed (the identity id by
    /// default).
    Identicon { seed: String },
    /// An https image URL: loaded only when the viewer asks.
    Url { url: String },
    /// Anything else: drawn as the default, and refused by every writer.
    Invalid,
}

fn char_count(s: &str) -> usize {
    s.chars().count()
}

fn fits(s: &str, l: Limit) -> bool {
    char_count(s) <= l.chars && s.len() <= l.bytes
}

/// Whether `s` is a link a profile may hold: `https://`, a host part (up to the first `/`, `?`
/// or `#`) that is not empty and holds no `@`, no whitespace anywhere, no control characters,
/// at most 200 characters. The contract's pattern
/// `^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$` accepts every link this accepts.
pub fn is_profile_link(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("https://") else {
        return false;
    };
    if !fits(s, limit("link")) || s.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.contains('@')
}

fn is_seed(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The [`AvatarSpec`] `config` (a stored `avatarConfig`, or none) names for `identity_id`.
pub fn avatar_spec(config: Option<&str>, identity_id: &str) -> AvatarSpec {
    let Some(config) = config.filter(|c| !c.is_empty()) else {
        return AvatarSpec::Default;
    };
    if !fits(config, limit("avatarConfig")) {
        return AvatarSpec::Invalid;
    }
    if config == "identicon" {
        return AvatarSpec::Identicon {
            seed: identity_id.to_string(),
        };
    }
    if let Some(seed) = config.strip_prefix("identicon:") {
        return if is_seed(seed) {
            AvatarSpec::Identicon {
                seed: seed.to_string(),
            }
        } else {
            AvatarSpec::Invalid
        };
    }
    if is_profile_link(config) {
        return AvatarSpec::Url {
            url: config.to_string(),
        };
    }
    AvatarSpec::Invalid
}

/// A text field's value after trimming, or `None` when it is blank.
fn text(v: Option<&str>, multiline: bool) -> Option<String> {
    let v = v?;
    let t = if multiline {
        v.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        v.to_string()
    };
    let t = t.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Why a text field's (trimmed, non-blank) value is refused.
fn text_problem(field: &str, value: &str) -> Option<String> {
    let l = limit(field);
    let multiline = field == "bio";
    if value
        .chars()
        .any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\t')))
    {
        return Some(if multiline {
            "holds a control character (line breaks and tabs are fine)".into()
        } else {
            "holds a line break or another control character".into()
        });
    }
    if char_count(value) > l.chars {
        return Some(format!("is longer than {} characters", l.chars));
    }
    if value.len() > l.bytes {
        return Some(format!("is longer than {} bytes (UTF-8)", l.bytes));
    }
    None
}

/// The trimmed, non-blank, deduplicated links of `links`, in order.
fn link_list(links: Option<&[String]>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in links.unwrap_or_default() {
        let t = l.trim();
        if !t.is_empty() && !out.iter().any(|o| o == t) {
            out.push(t.to_string());
        }
    }
    out
}

impl ProfileInput {
    fn field(&self, f: &str) -> Option<&str> {
        match f {
            "displayName" => self.display_name.as_deref(),
            "bio" => self.bio.as_deref(),
            "avatarConfig" => self.avatar_config.as_deref(),
            "location" => self.location.as_deref(),
            "company" => self.company.as_deref(),
            _ => None,
        }
    }
}

/// Why each field of `input` is refused (a sentence fragment after the field's name), in
/// [`PROFILE_FIELDS`] order.
pub fn profile_problems(input: &ProfileInput) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    for f in PROFILE_FIELDS {
        let problem = match f {
            "links" => {
                let links = link_list(input.links.as_deref());
                if links.len() > MAX_LINKS {
                    Some(format!("are more than {MAX_LINKS}"))
                } else {
                    links.iter().find(|l| !is_profile_link(l)).map(|bad| {
                        format!("include {bad:?}, which is not an https:// link of at most 200 characters with no spaces")
                    })
                }
            }
            "avatarConfig" => text(input.field(f), false)
                .filter(|v| avatar_spec(Some(v), "") == AvatarSpec::Invalid)
                .map(|_| {
                    "is not `identicon`, `identicon:<seed>` (1-64 of A-Z, a-z, 0-9, ., _, -) or an https image link of at most 200 characters".to_string()
                }),
            _ => text(input.field(f), f == "bio").and_then(|v| text_problem(f, &v)),
        };
        if let Some(p) = problem {
            out.push((f, p));
        }
    }
    out
}

/// Check and normalize a profile edit: what the `profile_input` vectors pin.
pub fn check_profile(input: &ProfileInput) -> ProfileCheck {
    let invalid: Vec<String> = profile_problems(input)
        .into_iter()
        .map(|(f, _)| f.to_string())
        .collect();
    if !invalid.is_empty() {
        return ProfileCheck {
            valid: false,
            invalid,
            normalized: None,
        };
    }
    let links = link_list(input.links.as_deref());
    ProfileCheck {
        valid: true,
        invalid,
        normalized: Some(ProfileFields {
            display_name: text(input.display_name.as_deref(), false),
            bio: text(input.bio.as_deref(), true),
            avatar_config: text(input.avatar_config.as_deref(), false),
            links: (!links.is_empty()).then_some(links),
            location: text(input.location.as_deref(), false),
            company: text(input.company.as_deref(), false),
        }),
    }
}

/// A profile's `bot` claim (UPDATE-1 `profile.bot`): on a bot's profile, the identity that
/// operates it (`operator`); on an operator's, the bots it operates (`operates`, at most 8).
/// Identity ids, base58.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotClaim {
    /// The identity that operates this one, when this one is a bot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    /// The bots this identity operates.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operates: Vec<String>,
}

/// The most bots one profile lists (`bot.operates` maxItems).
pub const MAX_OPERATED_BOTS: usize = 8;

/// The operator of `bot_id` when both sides agree: the bot's profile names an operator
/// (`bot.operator`), that is another identity, and the operator's profile lists the bot
/// (`operator.operates`). `None` otherwise: a one-sided claim earns no badge, so nobody can
/// label someone else a bot, and no bot can claim an operator who does not vouch for it.
#[must_use]
pub fn bot_operator(
    bot_id: &str,
    bot: Option<&BotClaim>,
    operator: Option<&BotClaim>,
) -> Option<String> {
    let claimed = bot?.operator.as_deref().filter(|o| *o != bot_id)?;
    operator?
        .operates
        .iter()
        .any(|b| b == bot_id)
        .then(|| claimed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_follow_the_contract_pattern() {
        assert!(is_profile_link("https://example.com"));
        assert!(is_profile_link("https://example.com/a?b#c"));
        assert!(!is_profile_link("http://example.com"));
        assert!(!is_profile_link("https://"));
        assert!(!is_profile_link("https://user@example.com"));
        assert!(is_profile_link("https://example.com/@user"));
        assert!(!is_profile_link("https://exa mple.com"));
        assert!(!is_profile_link("https://example.com/\u{a0}"));
    }

    #[test]
    fn avatar_conventions() {
        assert_eq!(avatar_spec(None, "id"), AvatarSpec::Default);
        assert_eq!(
            avatar_spec(Some("identicon"), "id"),
            AvatarSpec::Identicon { seed: "id".into() }
        );
        assert_eq!(avatar_spec(Some("identicon:"), "id"), AvatarSpec::Invalid);
        assert_eq!(avatar_spec(Some("gravatar:x"), "id"), AvatarSpec::Invalid);
    }
}
