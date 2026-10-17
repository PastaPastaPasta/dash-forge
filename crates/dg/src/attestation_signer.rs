//! Who signed a GitHub build attestation: the identity in its Sigstore certificate.
//!
//! `dg verify-app` looks up the attestations GitHub holds for a build manifest's SHA-256. That
//! the list is not empty is not enough: the manifest must have been attested by the workflow
//! that deploys the site, on `master`. Sigstore's Fulcio puts that identity into the signing
//! certificate as extensions under `1.3.6.1.4.1.57264.1` (the same fields `gh attestation
//! verify --signer-workflow` compares). This module reads those extensions out of the bundle's
//! certificate and compares them with the expected signer.
//!
//! It does not verify the certificate chain or the signature: that is `gh attestation verify`'s
//! job (the output names the command), and needs Sigstore's trust root. It does make sure the
//! attestation that vouches for a build is the one the official workflow made.

use base64::Engine as _;

/// The signing workflow `dg verify-app` expects by default, in `gh`'s `--signer-workflow`
/// form: `<owner>/<repo>/<path of the workflow file>`.
pub const DEFAULT_SIGNER_WORKFLOW: &str = "PastaPastaPasta/dash-forge/.github/workflows/pages.yml";

/// The only ref the deploy workflow's attestations count from.
pub const SIGNER_REF: &str = "refs/heads/master";

/// The OIDC issuer of GitHub Actions tokens.
const ACTIONS_ISSUER: &str = "https://token.actions.githubusercontent.com";

/// The signer a build's attestation must name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedSigner {
    /// `<owner>/<repo>`: the repository that ran the workflow.
    pub repo: String,
    /// The workflow file's path in that repository, e.g. `.github/workflows/pages.yml`.
    pub workflow: String,
}

impl ExpectedSigner {
    /// Parse a `--signer-workflow` value: `<owner>/<repo>/.github/workflows/<file>.yml`.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let mut parts = spec.splitn(3, '/');
        let (Some(owner), Some(repo), Some(workflow)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(format!(
                "{spec} is not <owner>/<repo>/.github/workflows/<file>.yml"
            ));
        };
        let name_ok = |s: &str| {
            !s.is_empty()
                && !s.starts_with('.')
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        let file = workflow.strip_prefix(".github/workflows/");
        let workflow_ok = file.is_some_and(|f| {
            name_ok(f)
                && std::path::Path::new(f).extension().is_some_and(|e| {
                    e.eq_ignore_ascii_case("yml") || e.eq_ignore_ascii_case("yaml")
                })
        });
        if !name_ok(owner) || !name_ok(repo) || !workflow_ok {
            return Err(format!(
                "{spec} is not <owner>/<repo>/.github/workflows/<file>.yml"
            ));
        }
        Ok(Self {
            repo: format!("{owner}/{repo}"),
            workflow: workflow.to_string(),
        })
    }

    /// The certificate's Build Signer URI for this workflow at [`SIGNER_REF`].
    fn build_signer_uri(&self) -> String {
        format!(
            "https://github.com/{}/{}@{SIGNER_REF}",
            self.repo, self.workflow
        )
    }

    /// The `--signer-workflow` form, for messages.
    pub fn spec(&self) -> String {
        format!("{}/{}", self.repo, self.workflow)
    }
}

/// The identity fields of a Sigstore signing certificate (GitHub Actions' ones).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SignerIdentity {
    /// `1.3.6.1.4.1.57264.1.8`: the OIDC issuer.
    pub issuer: Option<String>,
    /// `.1.9`: the workflow that signed, with its ref (`…/pages.yml@refs/heads/master`).
    pub build_signer: Option<String>,
    /// `.1.12`: the repository the workflow ran in.
    pub source_repo: Option<String>,
    /// `.1.14`: the ref it ran on.
    pub source_ref: Option<String>,
}

impl SignerIdentity {
    /// Whether this is `expected`'s signature: the issuer is GitHub Actions, the workflow is the
    /// expected file at [`SIGNER_REF`], and it ran in the expected repository on that ref. A
    /// field the certificate lacks fails.
    pub fn check(&self, expected: &ExpectedSigner) -> Result<(), String> {
        let want_signer = expected.build_signer_uri();
        let want_repo = format!("https://github.com/{}", expected.repo);
        let field = |name: &str, got: &Option<String>, want: &str| match got.as_deref() {
            Some(g) if g == want => Ok(()),
            Some(g) => Err(format!("{name} is {g}, not {want}")),
            None => Err(format!("it has no {name}")),
        };
        field("issuer", &self.issuer, ACTIONS_ISSUER)?;
        field("signing workflow", &self.build_signer, &want_signer)?;
        field("source repository", &self.source_repo, &want_repo)?;
        field("source ref", &self.source_ref, SIGNER_REF)
    }
}

/// `1.3.6.1.4.1.57264.1` as DER content bytes; the extension number follows.
const FULCIO_ARC: [u8; 9] = [0x2B, 0x06, 0x01, 0x04, 0x01, 0x83, 0xBF, 0x30, 0x01];

/// One DER element: `(tag, content, rest after it)`. Lengths over 4 bytes are refused.
fn tlv(buf: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = buf.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let n = usize::from(first & 0x7F);
        if n == 0 || n > 4 || rest.len() < n {
            return None;
        }
        let len = rest[..n]
            .iter()
            .fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
        (len, &rest[n..])
    };
    if rest.len() < len {
        return None;
    }
    Some((tag, &rest[..len], &rest[len..]))
}

/// A Fulcio string extension's value. Numbers 8 and up wrap a DER UTF8String; 1 to 7 (the
/// deprecated ones) are the raw text.
fn fulcio_string(number: u8, value: &[u8]) -> Option<String> {
    let text = if number >= 8 {
        let (tag, content, rest) = tlv(value)?;
        if tag != 0x0C || !rest.is_empty() {
            return None;
        }
        content
    } else {
        value
    };
    String::from_utf8(text.to_vec()).ok()
}

/// Read the signer identity out of a DER X.509 certificate. `None` when it is not a
/// well-formed certificate.
pub fn identity_from_der(cert: &[u8]) -> Option<SignerIdentity> {
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { … [3] extensions }, … }
    let (tag, cert_body, _) = tlv(cert)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, mut tbs, _) = tlv(cert_body)?;
    if tag != 0x30 {
        return None;
    }
    let mut extensions = None;
    while !tbs.is_empty() {
        let (tag, content, rest) = tlv(tbs)?;
        if tag == 0xA3 {
            extensions = Some(content);
        }
        tbs = rest;
    }
    let (tag, mut list, _) = tlv(extensions?)?;
    if tag != 0x30 {
        return None;
    }
    let mut id = SignerIdentity::default();
    while !list.is_empty() {
        let (tag, ext, rest) = tlv(list)?;
        list = rest;
        if tag != 0x30 {
            return None;
        }
        // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
        let (tag, oid, mut after) = tlv(ext)?;
        if tag != 0x06 {
            return None;
        }
        let (mut tag, mut value, mut next) = tlv(after)?;
        if tag == 0x01 {
            after = next;
            (tag, value, next) = tlv(after)?;
        }
        if tag != 0x04 || !next.is_empty() {
            return None;
        }
        let Some(number) = oid
            .strip_prefix(&FULCIO_ARC[..])
            .and_then(|n| <[u8; 1]>::try_from(n).ok())
            .map(|[n]| n)
        else {
            continue;
        };
        let slot = match number {
            8 => &mut id.issuer,
            9 => &mut id.build_signer,
            12 => &mut id.source_repo,
            14 => &mut id.source_ref,
            _ => continue,
        };
        *slot = fulcio_string(number, value);
    }
    Some(id)
}

/// The DER certificate in a Sigstore bundle as GitHub's attestations API returns it:
/// `verificationMaterial.certificate.rawBytes` (bundle v0.3), or the first of
/// `verificationMaterial.x509CertificateChain.certificates` (v0.1/0.2).
fn bundle_certificate(attestation: &serde_json::Value) -> Option<Vec<u8>> {
    let material = attestation.pointer("/bundle/verificationMaterial")?;
    let raw = material
        .pointer("/certificate/rawBytes")
        .or_else(|| material.pointer("/x509CertificateChain/certificates/0/rawBytes"))?
        .as_str()?;
    base64::engine::general_purpose::STANDARD.decode(raw).ok()
}

/// The outcome of checking a list of attestations (as GitHub's API returns them) against the
/// expected signer.
#[derive(Debug, PartialEq, Eq)]
pub enum SignerCheck {
    /// At least one attestation was made by the expected signer.
    Signed,
    /// None was; one reason per attestation, in order.
    NotSigned(Vec<String>),
}

/// Whether any of `attestations` was signed by `expected`. Attestations by another workflow,
/// ref or repository, or without a readable certificate, do not count.
pub fn check_attestations(
    attestations: &[serde_json::Value],
    expected: &ExpectedSigner,
) -> SignerCheck {
    let mut reasons = Vec::new();
    for a in attestations {
        let verdict = bundle_certificate(a)
            .and_then(|der| identity_from_der(&der))
            .ok_or_else(|| "its certificate could not be read".to_string())
            .and_then(|id| id.check(expected));
        match verdict {
            Ok(()) => return SignerCheck::Signed,
            Err(why) => reasons.push(why),
        }
    }
    SignerCheck::NotSigned(reasons)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A real signing certificate of this repository's Pages deploy on master (public data).
    const REAL_CERT: &str = include_str!("testdata/pages-attestation-cert.b64");

    fn official() -> ExpectedSigner {
        ExpectedSigner::parse(DEFAULT_SIGNER_WORKFLOW).unwrap()
    }

    fn encode(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let n = u16::try_from(content.len()).unwrap();
        match n {
            0..=0x7F => out.push(u8::try_from(n).unwrap()),
            0x80..=0xFF => out.extend([0x81, u8::try_from(n).unwrap()]),
            _ => out.extend([
                0x82,
                u8::try_from(n >> 8).unwrap(),
                u8::try_from(n & 0xFF).unwrap(),
            ]),
        }
        out.extend_from_slice(content);
        out
    }

    fn extension(number: u8, text: &str) -> Vec<u8> {
        let mut oid = FULCIO_ARC.to_vec();
        oid.push(number);
        let value = if number >= 8 {
            encode(0x0C, text.as_bytes())
        } else {
            text.as_bytes().to_vec()
        };
        let mut body = encode(0x06, &oid);
        body.extend(encode(0x04, &value));
        encode(0x30, &body)
    }

    /// A minimal certificate carrying the Fulcio extensions given (everything the reader skips
    /// is left out).
    fn cert(issuer: &str, signer: &str, repo: &str, git_ref: &str) -> Vec<u8> {
        let mut exts = extension(8, issuer);
        exts.extend(extension(9, signer));
        exts.extend(extension(12, repo));
        exts.extend(extension(14, git_ref));
        let mut tbs = encode(0x02, &[1]);
        tbs.extend(encode(0xA3, &encode(0x30, &exts)));
        let mut body = encode(0x30, &tbs);
        body.extend(encode(0x03, &[0]));
        encode(0x30, &body)
    }

    fn attestation(der: &[u8]) -> serde_json::Value {
        json!({"bundle": {"verificationMaterial": {"certificate": {
            "rawBytes": base64::engine::general_purpose::STANDARD.encode(der)
        }}}})
    }

    const ISSUER: &str = "https://token.actions.githubusercontent.com";
    const SIGNER: &str =
        "https://github.com/PastaPastaPasta/dash-forge/.github/workflows/pages.yml@refs/heads/master";
    const REPO: &str = "https://github.com/PastaPastaPasta/dash-forge";

    #[test]
    fn reads_the_identity_of_a_real_certificate() {
        let der = base64::engine::general_purpose::STANDARD
            .decode(REAL_CERT.trim())
            .unwrap();
        let id = identity_from_der(&der).unwrap();
        assert_eq!(id.issuer.as_deref(), Some(ISSUER));
        assert_eq!(id.build_signer.as_deref(), Some(SIGNER));
        assert_eq!(id.source_repo.as_deref(), Some(REPO));
        assert_eq!(id.source_ref.as_deref(), Some("refs/heads/master"));
        id.check(&official()).unwrap();
        assert_eq!(
            check_attestations(&[attestation(&der)], &official()),
            SignerCheck::Signed
        );
    }

    #[test]
    fn the_official_workflow_on_master_passes() {
        let der = cert(ISSUER, SIGNER, REPO, "refs/heads/master");
        assert_eq!(
            check_attestations(&[attestation(&der)], &official()),
            SignerCheck::Signed
        );
    }

    #[test]
    fn only_the_signer_differs_and_each_difference_fails() {
        let master = "refs/heads/master";
        let cases = [
            // another workflow of this repository
            (
                cert(
                    ISSUER,
                    "https://github.com/PastaPastaPasta/dash-forge/.github/workflows/release.yml@refs/heads/master",
                    REPO,
                    master,
                ),
                "signing workflow",
            ),
            // the official workflow on another ref
            (
                cert(
                    ISSUER,
                    "https://github.com/PastaPastaPasta/dash-forge/.github/workflows/pages.yml@refs/heads/evil",
                    REPO,
                    "refs/heads/evil",
                ),
                "signing workflow",
            ),
            // the same file name in a fork
            (
                cert(
                    ISSUER,
                    "https://github.com/someone/dash-forge/.github/workflows/pages.yml@refs/heads/master",
                    "https://github.com/someone/dash-forge",
                    master,
                ),
                "signing workflow",
            ),
            // a workflow that claims the right signer but ran elsewhere
            (
                cert(ISSUER, SIGNER, "https://github.com/someone/dash-forge", master),
                "source repository",
            ),
            (cert(ISSUER, SIGNER, REPO, "refs/heads/evil"), "source ref"),
            // not a GitHub Actions token
            (
                cert("https://accounts.google.com", SIGNER, REPO, master),
                "issuer",
            ),
        ];
        for (der, what) in cases {
            match check_attestations(&[attestation(&der)], &official()) {
                SignerCheck::NotSigned(why) => {
                    assert_eq!(why.len(), 1);
                    assert!(why[0].starts_with(what), "{} vs {what}", why[0]);
                }
                SignerCheck::Signed => panic!("{what} should have failed"),
            }
        }
    }

    #[test]
    fn one_good_attestation_among_others_is_enough() {
        let bad = cert(ISSUER, SIGNER, REPO, "refs/heads/evil");
        let good = cert(ISSUER, SIGNER, REPO, "refs/heads/master");
        assert_eq!(
            check_attestations(&[attestation(&bad), attestation(&good)], &official()),
            SignerCheck::Signed
        );
        assert_eq!(
            check_attestations(&[], &official()),
            SignerCheck::NotSigned(vec![])
        );
    }

    #[test]
    fn a_certificate_that_is_unreadable_or_missing_fields_fails() {
        // Garbage bytes, a missing bundle and a certificate without the extensions.
        let junk = attestation(b"not a certificate");
        let no_bundle = json!({"repository_id": 1});
        let bare = attestation(&encode(0x30, &encode(0x30, &encode(0x02, &[1]))));
        for a in [junk, no_bundle, bare] {
            assert!(matches!(
                check_attestations(&[a], &official()),
                SignerCheck::NotSigned(_)
            ));
        }
        // Truncated real certificate.
        let der = base64::engine::general_purpose::STANDARD
            .decode(REAL_CERT.trim())
            .unwrap();
        assert!(identity_from_der(&der[..der.len() / 2]).is_none());
    }

    #[test]
    fn the_v01_certificate_chain_form_is_read_too() {
        let der = cert(ISSUER, SIGNER, REPO, "refs/heads/master");
        let a = json!({"bundle": {"verificationMaterial": {"x509CertificateChain": {
            "certificates": [{"rawBytes": base64::engine::general_purpose::STANDARD.encode(&der)}]
        }}}});
        assert_eq!(check_attestations(&[a], &official()), SignerCheck::Signed);
    }

    #[test]
    fn a_custom_signer_workflow_is_matched_exactly() {
        let custom = ExpectedSigner::parse("someone/fork/.github/workflows/site.yaml").unwrap();
        assert_eq!(custom.repo, "someone/fork");
        let der = cert(
            ISSUER,
            "https://github.com/someone/fork/.github/workflows/site.yaml@refs/heads/master",
            "https://github.com/someone/fork",
            "refs/heads/master",
        );
        assert_eq!(
            check_attestations(&[attestation(&der)], &custom),
            SignerCheck::Signed
        );
        // …and the official certificate is not that signer.
        let real = cert(ISSUER, SIGNER, REPO, "refs/heads/master");
        assert!(matches!(
            check_attestations(&[attestation(&real)], &custom),
            SignerCheck::NotSigned(_)
        ));
    }

    #[test]
    fn signer_workflow_values_are_validated() {
        for ok in [
            DEFAULT_SIGNER_WORKFLOW,
            "a/b/.github/workflows/c.yaml",
            "a-b/c_d/.github/workflows/e-f.yml",
        ] {
            assert!(ExpectedSigner::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "pages.yml",
            "owner/repo",
            "owner/repo/pages.yml",
            "owner/repo/.github/workflows/",
            "owner/repo/.github/workflows/pages.txt",
            "owner/repo/.github/workflows/../x.yml",
            "owner/repo/.github/workflows/a/b.yml",
            "owner/repo/.github/workflows/pages.yml@refs/heads/master",
            "o wner/repo/.github/workflows/pages.yml",
            "/repo/.github/workflows/pages.yml",
        ] {
            assert!(ExpectedSigner::parse(bad).is_err(), "{bad}");
        }
    }
}
