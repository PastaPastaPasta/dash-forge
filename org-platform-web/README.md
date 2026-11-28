# Organizations on Platform: live testnet e2e (web, #789/#790)

2026-11-28, local testnet build of #790, headless Chromium, forge-org 61dAELEsWbi1Nz9kyVo4WY2GGAUBzMw8AzNn74vhJHjx.
QA org 7xmySibLg9RELWNvBcaU4ErgK9w7tyjjb3zjWW1UbPhL (2 of 3). Members' Forge identities: alice = OWNER, bob = MAINTAINER, carol = COLLAB.

| Step | Result | Shots |
|---|---|---|
| Connect as alice, bob, carol (orgMember + orgShare each) | pass, after fixing identifier bytes (first try: consensus 10101, `org` sent as base58) | connect-*-1/2/3, fail-connect-* |
| Masked phrase box | pass | connect-bob-2-masked-phrase, publish-2b-unlock-masked |
| Publish organization (alice) | pass: 2 proposals + 2 signatures | publish-1/2/3 |
| Inbox by identity: bob on a fresh profile sees the badge and "Needs your signature", signs; his client finishes | pass: `org` roster written, profile declared | inbox-1..4 |
| Visitor sees "Organization · 2 of 3" | pass | visitor-1-org |
| Refused request: "Forge won't sign this: …" + Dismiss | pass | view-carol, view-carol-dismissed |

Measured fees (credits; 1 DASH = 1e11):
- orgMember + orgShare: 124,768,640
- request of 2 parts (2 proposals + 2 signatures): 227,809,540
- one small proposal: 63,662,820
- bob's sign and finish (2 signatures + 2 send records, plus a browser key registration): 200,460,940
- the organization's own writes on finish (org create + profile create): 66,806,580
