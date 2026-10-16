# If Forge tells you to revoke keys

Forge may ask you to revoke your keys: a notice in the app, a release note, or a message from a maintainer. Revoking turns off the signing keys of your identity on Platform, so no copy of them can write as you any more, wherever it was made. This page shows how to disable them all at once.

You keep your identity, your repositories and your history. Only the keys that sign for you are replaced.

1. [What gets disabled, and what stays](#what-gets-disabled-and-what-stays)
2. [From the terminal](#from-the-terminal)
3. [From the web app](#from-the-web-app)
4. [Afterwards](#afterwards)
5. [If the master key or the 12 words may have been copied](#if-the-master-key-or-the-12-words-may-have-been-copied)

---

## What gets disabled, and what stays

**Disabled:** every Forge key of your identity that is not the one you are using now. That is each browser, each computer and each CI runner key you registered: the limited keys with a budget and an expiry, and the keys that can only report check runs.

**Stays:**

- the key you are signed in with here (this computer's key for `dg`, this browser's key for the web app);
- your **master key**, which Platform never lets you disable;
- your **encryption key**, because your private repositories open with it: replace it with [`dg auth keys rotate --encryption`](identity-and-keys.md#replacing-it-after-a-lost-device) if a device that held it may have been copied;
- keys that are not Forge keys, such as a wallet's signing key or another app's: `dg auth keys disable <id> --force` disables one of those, and says what it affects.

A disabled key can never sign again. Anything it was building, such as a CI runner, stops until you register a new key for it.

## From the terminal

You need your master key once: the identity file (`--master <file>`) or the 12 words, typed when asked.

```sh
dg auth keys disable --all-limited
```

It lists the keys it will disable and the key it keeps, then asks before it sends anything:

```
Disabling 3 limited keys of 9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD:
  #5   dash-forge key, expires in 41 days
  #7   dash-forge key, expires in 163 days
  #9   CI runner key
  kept: #11 (this computer signs with it), the master key and keys that are not Forge limited keys
  1 identity update (up to 10 keys each), signed by the master key
Disable 3 keys of 9r27eDsuXEqoMNymW1A2MKFrpBhzSkepVKwXrGzq9dUD? [y/N]
```

`--yes` skips the question, for a script. `--json` prints the keys it disabled.

Platform disables at most 10 keys in one identity update, so a longer list takes more updates, each signed by the master key. If one fails, the keys already disabled stay disabled: run the same command again and it finishes the rest. Each update costs about 0.00002 DASH ([costs](costs.md)).

`dg auth keys list` shows the result. The key this computer signs with is not disabled; to replace that one too, register a fresh key, which disables the current one in the same update:

```sh
dg auth keys add
```

## From the web app

**Settings → Devices & keys** lists every key on your identity. Under the list, **Disable all other keys** disables every Forge key except this browser's own.

1. Sign in, then open **Settings → Devices & keys**. The button appears when there is at least one other key to disable.
2. Select **Disable all other keys**. The dialog lists each key it will disable and the cost.
3. Give your identity file or recovery phrase, then **Sign & disable**. The master key signs each update and is not stored. The dialog shows its progress: a long list is sent 10 keys at a time.

If it stops part-way, the keys already disabled stay disabled and the page says how many: run it again for the rest.

This browser's own key stays. To replace it too, use **Settings → This browser's key → Renew key**, which registers a fresh key and disables this one.

## Afterwards

- Sign in again on your other devices. Each one needs a new key: `dg auth login` on a computer, **Sign in** in a browser. A CI runner needs a new key too ([CI](ci.md)).
- If you use private repositories, replace the encryption key if a device that held it may have been copied: `dg auth keys rotate --encryption`.
- Check `dg auth keys list` or **Devices & keys**: the old keys show as disabled.

## If the master key or the 12 words may have been copied

Disabling limited keys does not help then: whoever holds the master key can add keys and disable yours. See [Identity and keys](identity-and-keys.md#rotating-and-disabling-keys) for what to do.
