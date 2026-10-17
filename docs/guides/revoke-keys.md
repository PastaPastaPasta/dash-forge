# If Forge tells you to revoke keys

Forge may ask you to revoke your keys: a notice in the app, a release note, or a message from a maintainer. Revoking turns off the signing keys of your identity on Platform, so no copy of them can write as you any more, wherever it was made. This page shows how to disable them all at once.

You keep your identity, your repositories and your history. Only the keys that sign for you are replaced.

1. [What gets disabled, and what stays](#what-gets-disabled-and-what-stays)
2. [From the terminal](#from-the-terminal)
3. [From the web app](#from-the-web-app)
4. [Afterwards](#afterwards)
5. [The encryption key](#the-encryption-key)
6. [If the master key or the 12 words may have been copied](#if-the-master-key-or-the-12-words-may-have-been-copied)

---

## What gets disabled, and what stays

**Disabled: every signing key (AUTHENTICATION key) of your identity except the one you are using now and the master key.** That is each browser, computer and CI runner key you registered, and also the keys other apps use to sign as you:

- **Forge limited keys**: the keys with a budget and an expiry that a browser or `dg` signs with;
- **wallet sign-ins**: the key a Dash wallet gave Forge or another app when you scanned a sign-in, whether it has no contract limits or is tied to one contract and has no budget. Wallet keys have no budget and may never expire, which makes them the most worth disabling;
- **CI runner keys**: the keys that can only report check runs;
- **other apps' keys**: any other signing key on the identity, including ones this page can't name.

Other apps that use this identity, a wallet sign-in for one, will need to sign in again. So will every other browser, computer and CI runner of yours. Both tools list each key with its kind and what it may sign for before they send anything, and ask first.

**Stays:**

- the key you are signed in with here (this computer's key for `dg`, this browser's key for the web app);
- your **master key**, which signs the update and which Platform never lets you disable;
- your **encryption**, **decryption** and **transfer** keys: your private repositories open with the encryption key, and the transfer key moves credits. They are not signing keys. [The encryption key](#the-encryption-key) may need replacing too.

A disabled key can never sign again. Anything it was doing, such as a CI runner, stops until you register a new key for it.

## From the terminal

You need your master key once: the identity file (`--master <file>`) or the 12 words, typed when asked.

```sh
dg auth keys disable --all-limited      # also spelled --all-other
```

It lists the keys it will disable, with their kind and what they may sign for, and the key it keeps, then asks before it sends anything:

```
Disabling 4 keys of 9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD:
  #1   wallet sign-in        any contract
  #5   Forge limited key     Forge contract group, expires in 41 days
  #7   wallet sign-in        forge-collab
  #9   CI runner key         checkRun records of forge-community
  kept: #11 (this computer signs with it), the master key, and encryption, decryption and transfer keys
  1 identity update (up to 10 keys each), signed by the master key
  Other apps that use this identity (a wallet sign-in, for one) will need to sign in again.
Disable 4 keys of 9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD? [y/N]
```

`--yes` skips the question, for a script. `--json` prints the keys it disabled, each with its kind.

Platform disables at most 10 keys in one identity update, so a longer list takes more updates, each signed by the master key. If one fails, the keys already disabled stay disabled: run the same command again and it finishes the rest. Each update costs about 0.00002 DASH ([costs](costs.md)).

`dg auth keys list` shows the result. The key this computer signs with is not disabled; to replace that one too, register a fresh key, which disables the current one in the same update:

```sh
dg auth keys add
```

## From the web app

**Settings → Devices & keys** lists every key on your identity. Under the list, **Disable all other keys** disables every signing key except this browser's own and the master.

1. Sign in, then open **Settings → Devices & keys**. The button appears when there is at least one other signing key to disable.
2. Select **Disable all other keys**. The dialog lists each key with its kind and what it may sign for, says that other apps (a wallet sign-in, for one) will need to sign in again, and shows the cost.
3. Give your identity file or recovery phrase, then **Sign & disable**. The master key signs each update and is not stored. The dialog shows its progress: a long list is sent 10 keys at a time.

If it stops part-way, the keys already disabled stay disabled and the page says how many: run it again for the rest.

Wallet keys this browser holds, besides the one it signs with, are disabled too, and the writes they allowed ask for a wallet approval again. This browser's own key stays. To replace it too, use **Settings → This browser's key → Renew key**, which registers a fresh key and disables this one.

## Afterwards

- Sign in again on your other devices and in any app that used a wallet sign-in. Each one needs a new key: `dg auth login` on a computer, **Sign in** in a browser. A CI runner needs a new key too ([CI](ci.md)).
- Check `dg auth keys list` or **Devices & keys**: the old keys show as disabled.

## The encryption key

Disabling signing keys does not replace your encryption key. If a wallet sign-in or the web app may have copied keys, the encryption key may have been copied too. If you use private repositories, follow [replacing the encryption key](identity-and-keys.md#replacing-it-after-a-lost-device): `dg auth keys rotate --encryption`.

## If the master key or the 12 words may have been copied

Disabling signing keys does not help then: whoever holds the master key can add keys and disable yours. See [Identity and keys](identity-and-keys.md#rotating-and-disabling-keys) for what to do.
