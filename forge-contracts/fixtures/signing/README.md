# Signing-key fixtures (P1-7)

Public halves of throwaway keys made for the `pubkey_entry__*`, `commit_signature__*` and `tag_signature__*` vectors.
Their private keys were deleted after signing the vector commits. The keys sign nothing else.

| File | Key |
|---|---|
| `gpg-a.asc` | OpenPGP Ed25519 primary key that can sign (`059E65EA…73261B84`) |
| `gpg-b.asc` | OpenPGP Ed25519 certify-only primary key with an Ed25519 signing subkey (`4F8E2782…BAF14469`) |
| `gpg-c.asc` | OpenPGP RSA 2048 key: too large for a profile entry |
| `e.pub` | OpenSSH Ed25519 key (`SHA256:M6aRFdNb/ydXJCTG0evONUHI5tGSKVbn+YR/GofPUtM`) |
| `t.pub` | OpenSSH Ed25519 key that signed the `tag_signature__*` tag (`SHA256:LVgRnBSfhpFylNm+hd4TwceUiVTV/qOMTSYbUMxFi2A`) |

Both clients build entries from these files and must reach the vectors' entries:
`forge-web/lib/repo/signing-keys.test.ts` and `forge_core::signing_keys` tests.
