# Signed requests to optional Forge services

Dash Forge's optional services, starting with `forge-notify`, need to know that a request comes from whoever controls a Forge identity. They must do this without an account, a password or a session. This page specifies the format. It is an **off-chain convention of Dash Forge's services, not a Platform protocol feature**: nothing here is a state transition, and Platform never sees these requests.

Implementations:

- the service side: `services/forge-notify/src/auth.rs`
- the browser side: `forge-web/lib/notify/client.ts`
- a command-line client that signs from an identity file: `services/forge-notify/examples/request.rs`

## The envelope

The client POSTs JSON with exactly two fields:

```json
{"request": "<the request JSON, as text>", "signature": "<base64>"}
```

`request` is signed **exactly as sent**. The service parses it only after the signature checks out, so neither side canonicalises anything.

## The request

```json
{"v":1,"service":"notify.example.org","action":"email.set","identity":"<base58 identity id>",
 "key":3,"nonce":"<16 to 64 base64url characters>","time":1791130000,"payload":{"email":"…"}}
```

| Field | Meaning |
|---|---|
| `v` | Format version, `1`. |
| `service` | The operator name of the service this request is for (`FORGE_NOTIFY_OPERATOR`, by default the host of its public URL). A request for one operator is refused by every other. |
| `action` | What to do. `forge-notify` accepts `account.get`, `email.set`, `email.remove`, `prefs.set`, `push.add`, `push.remove`, `test.send`, `data.export` and `data.delete`. |
| `identity` | The identity id, base58. |
| `key` | The id of the identity key that signed. |
| `nonce` | A fresh random value. The service stores `identity:nonce` until the request could no longer pass the time check, and refuses a repeat. |
| `time` | Unix seconds. It must be within 300 seconds of the service's clock. |
| `payload` | The action's arguments (an object; `{}` when there are none). |

Unknown fields are refused. The request text is at most 8 KiB.

## The signature

```
digest    = SHA-256(SHA-256("DashForgeService/v1\n" ‖ request))
signature = ECDSA secp256k1 over digest, RFC 6979 nonce, low-S, 64-byte compact (r ‖ s)
```

The signature is sent base64-encoded with standard padding.

The service accepts the request when **all** of these hold:

1. `service` is its own operator name.
2. `time` is within 300 seconds of its clock.
3. Key `key` of `identity`, **read from Platform with proofs**, is:
   - enabled (not disabled);
   - purpose `AUTHENTICATION`;
   - security level `HIGH` or `CRITICAL` (never `MASTER`);
   - type `ECDSA_SECP256K1`;
   - unbound, or bound to Forge: one of the network's Forge contracts (any document type of it, or a superseded one still in the group) or the Forge contract group. A key bound to another app's contract or group is refused: that app holds the key, and it must not be able to read or change the identity's email or delete its data.
4. That key's public key verifies the signature over `digest`.
5. The nonce has not been used before.

The service caches an identity's keys for 60 seconds. Disabling a key on Platform therefore stops it from signing service requests within about a minute.

## Why this is safe to sign with a browser's Forge key

The browser's key is a PV14 limited key: `AUTHENTICATION`/`HIGH`, bound to the dash-forge contract group, and budgeted (`forge-web/lib/auth/limited-key.ts`). Signing a service request with it cannot spend credits or write a document, for two reasons:

- **Domain separation.** Platform signs a state transition over the double SHA-256 of its serialization. That serialization starts with the transition's type, a small integer. The service digest starts with the ASCII line `DashForgeService/v1\n`, and `D` is `0x44`, which is not a transition type. So no service request is ever also a valid transition.
- **Operator binding.** A request names the operator it is for. A service cannot replay a request it received to a different service.

A signed request is still a credential for its own service while it is fresh. Send it only to the service it names, over HTTPS.

## Test vector

Both implementations check this vector in their tests: `auth::tests::the_shared_test_vector` in Rust, `lib/notify/client.test.ts` in the web app. RFC 6979 makes the signature deterministic.

| | |
|---|---|
| secret key | 32 bytes of `0x11` |
| request | `{"v":1,"service":"notify.example.org","action":"account.get","identity":"FrNpRnZQPP5gLFAjD7Foz4tZaML5DJ88CqaCvAkYNYjU","key":2,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","time":1791130000,"payload":{}}` |
| digest (hex) | `cd567e6ae5db8dd515af7665c245c9c93af9239ae54698f55ff539d20768a8c6` |
| signature (base64) | `i906pPEDYL304mGyHNxTsDavUvq0N+W0mVDHZ6lqigdj3AonKOZ9qCYIyvQ9xkvowx8LYouvBs69t/2iiX0HKw==` |
