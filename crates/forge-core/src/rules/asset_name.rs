//! Release asset file names (TypeScript `forge-web/lib/rules/asset-name.ts`): which recorded
//! asset names a download saves under as they are, and which a publish refuses to record.
//!
//! A recorded name is the publisher's data. `dg release download` saves under it only when it is
//! one plain file name that every common system saves as itself: never a path, a drive, a
//! stream, a Windows device, a hidden dotfile (`.git`, `.npmrc`, `.envrc`), a name that reads as
//! a command-line option, or one that hides what it says. `dg release create` and the web publish
//! form refuse to record what a download would refuse, and two assets of one release must not
//! save as one file on a case-insensitive file system. Vectors:
//! `forge-contracts/vectors/asset_file_name__*`.

/// The longest asset name, in UTF-8 bytes: most file systems' limit for one name.
pub const MAX_ASSET_NAME_BYTES: usize = 255;

/// Why a name is not saved as itself. [`Self::code`] is the stable name both ports agree on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetNameProblem {
    /// Empty, `.` or `..`.
    NotAName,
    /// Over [`MAX_ASSET_NAME_BYTES`].
    TooLong,
    /// Holds `/` or `\`, or a character that looks like one.
    Path,
    /// Holds a character Windows refuses in a name (`:` is a drive or a stream there), or one
    /// that looks like `:`.
    ReservedChar,
    /// Holds a control, line-separator or text-direction character.
    Control,
    /// Starts with `.`: a hidden file, read as configuration by git, shells and tools.
    Dotfile,
    /// Starts with `-`: read as an option by the commands it is passed to.
    LeadingDash,
    /// Ends in `.` or a space, which Windows drops.
    TrailingDotOrSpace,
    /// A Windows device name, with or without an extension (`nul.txt` is the device too).
    Device,
}

impl AssetNameProblem {
    /// The vectors' name for it.
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAName => "notAName",
            Self::TooLong => "tooLong",
            Self::Path => "path",
            Self::ReservedChar => "reservedChar",
            Self::Control => "control",
            Self::Dotfile => "dotfile",
            Self::LeadingDash => "leadingDash",
            Self::TrailingDotOrSpace => "trailingDotOrSpace",
            Self::Device => "device",
        }
    }

    /// Why, for an error message.
    #[must_use]
    pub fn why(self) -> &'static str {
        match self {
            Self::NotAName => "it is not a file name",
            Self::TooLong => "it is over 255 bytes",
            Self::Path => "it is a path",
            Self::ReservedChar => "it holds a character Windows refuses: : < > \" | ? *",
            Self::Control => "it holds control or text-direction characters",
            Self::Dotfile => "it starts with a dot (a hidden file)",
            Self::LeadingDash => "it starts with a dash (read as an option)",
            Self::TrailingDotOrSpace => "it ends in a dot or a space, which Windows drops",
            Self::Device => "it is a device name on Windows",
        }
    }
}

/// `/`, `\` and characters that look like them.
const SEPARATORS: &[char] = &[
    '/', '\\', '\u{2044}', '\u{2215}', '\u{29f5}', '\u{29f8}', '\u{29f9}', '\u{ff0f}', '\u{ff3c}',
];

/// What Windows refuses in a name, and characters that look like `:`.
const RESERVED: &[char] = &[':', '<', '>', '"', '|', '?', '*', '\u{a789}', '\u{ff1a}'];

/// A control character (C0, DEL, C1), a line or paragraph separator, or a bidi embedding,
/// override or isolate, LRM, RLM or ALM: they disguise a name.
fn disguising(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{2028}' | '\u{2029}' | '\u{200e}' | '\u{200f}' | '\u{61c}'
        )
        || ('\u{202a}'..='\u{202e}').contains(&c)
        || ('\u{2066}'..='\u{2069}').contains(&c)
}

/// Whether `name` is a Windows device: its part before the first dot, trailing spaces dropped,
/// is `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, or `COM`/`LPT` and one digit (`0`-`9`,
/// `¹`, `²`, `³`), in any ASCII case.
fn is_device(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|p| {
            stem.strip_prefix(p).is_some_and(|n| {
                (n.len() == 1 && n.as_bytes()[0].is_ascii_digit())
                    || matches!(n, "\u{b9}" | "\u{b2}" | "\u{b3}")
            })
        })
}

/// Why `name` is not one plain file name that saves as itself on every common system, or None.
/// The first problem in [`AssetNameProblem`]'s order is the one named.
#[must_use]
pub fn asset_name_problem(name: &str) -> Option<AssetNameProblem> {
    use AssetNameProblem as P;
    Some(if name.is_empty() || name == "." || name == ".." {
        P::NotAName
    } else if name.len() > MAX_ASSET_NAME_BYTES {
        P::TooLong
    } else if name.contains(SEPARATORS) {
        P::Path
    } else if name.contains(RESERVED) {
        P::ReservedChar
    } else if name.chars().any(disguising) {
        P::Control
    } else if name.starts_with('.') {
        P::Dotfile
    } else if name.starts_with('-') {
        P::LeadingDash
    } else if name.ends_with(['.', ' ']) {
        P::TrailingDotOrSpace
    } else if is_device(name) {
        P::Device
    } else {
        return None;
    })
}

/// What two names that save as one file on a case-insensitive file system share: the name
/// upper-cased, then lower-cased, so that every case form of a letter meets (`ς` and `σ`, `ß`
/// and `SS`).
#[must_use]
pub fn same_file_key(name: &str) -> String {
    name.to_uppercase().to_lowercase()
}

/// Why one release's assets `names` (in order) cannot all be saved as themselves, or None: the
/// first name with a problem, or the first that saves as the same file as an earlier one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetNamesProblem<'a> {
    /// `name` is not saved as itself.
    Name(&'a str, AssetNameProblem),
    /// `name` saves as the same file as the earlier `first`.
    SameFile { name: &'a str, first: &'a str },
}

/// [`AssetNamesProblem`] for `names`, in order.
#[must_use]
pub fn asset_names_problem<'a>(
    names: impl IntoIterator<Item = &'a str>,
) -> Option<AssetNamesProblem<'a>> {
    let mut seen = std::collections::HashMap::new();
    for name in names {
        if let Some(p) = asset_name_problem(name) {
            return Some(AssetNamesProblem::Name(name, p));
        }
        if let Some(first) = seen.insert(same_file_key(name), name) {
            return Some(AssetNamesProblem::SameFile { name, first });
        }
    }
    None
}

/// A name for an asset recorded from free text (a GitLab release link's label): `label` when it
/// is a plain file name, else the last segment of `url`'s path when that is one, else `label`
/// with every refused character replaced by `_` and its leading dots and dashes and trailing dots
/// and spaces dropped (a device name gets a leading `_`, and `asset` stands for nothing left),
/// within [`MAX_ASSET_NAME_BYTES`].
#[must_use]
pub fn derived_asset_name(label: &str, url: &str) -> String {
    if asset_name_problem(label).is_none() {
        return label.to_string();
    }
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let path = path.split_once("://").map_or(path, |(_, rest)| rest);
    let last = path
        .split_once('/')
        .map_or("", |(_, p)| p.rsplit('/').next().unwrap_or_default());
    if asset_name_problem(last).is_none() {
        return last.to_string();
    }
    let mut out = String::new();
    for c in label.chars() {
        let c = if SEPARATORS.contains(&c) || RESERVED.contains(&c) || disguising(c) {
            '_'
        } else {
            c
        };
        // One byte is left for a device name's `_`.
        if out.len() + c.len_utf8() >= MAX_ASSET_NAME_BYTES {
            break;
        }
        out.push(c);
    }
    let out = out
        .trim_start_matches(['.', '-'])
        .trim_end_matches(['.', ' ']);
    match asset_name_problem(out) {
        None => out.to_string(),
        // A device name: kept readable, no longer the device.
        Some(AssetNameProblem::Device) => format!("_{out}"),
        Some(_) => "asset".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_text_label_becomes_a_plain_file_name() {
        let url = "https://gitlab.example/g/p/-/package_files/7/download";
        assert_eq!(derived_asset_name("app.tar.gz", url), "app.tar.gz");
        // The URL's last segment, when the label is not a file name.
        assert_eq!(
            derived_asset_name("Linux: x86_64", "https://h.example/d/app-linux.tar.gz?x=1"),
            "app-linux.tar.gz"
        );
        assert_eq!(derived_asset_name("Linux: x86_64", url), "download");
        for (label, want) in [
            ("../../.bashrc", "_.._.bashrc"),
            (".npmrc", "npmrc"),
            ("--upload-pack=x", "upload-pack=x"),
            ("CON", "_CON"),
            ("notes.", "notes"),
            ("a\u{202e}b", "a_b"),
            ("...", "asset"),
        ] {
            assert_eq!(
                derived_asset_name(label, "https://h.example/"),
                want,
                "{label:?}"
            );
        }
        let long = derived_asset_name(&"é".repeat(200), "https://h.example/");
        assert!(long.len() <= MAX_ASSET_NAME_BYTES && asset_name_problem(&long).is_none());
        for label in ["", ".", "a/b", ".git", "x ", "a\nb", "nul.txt", "-"] {
            let got = derived_asset_name(label, "");
            assert_eq!(asset_name_problem(&got), None, "{label:?} -> {got:?}");
        }
    }
}
