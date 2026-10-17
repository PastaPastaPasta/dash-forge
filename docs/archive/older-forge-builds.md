# Older Forge builds (archived)

Moved here from [Audiences](../security/audiences.md). It applies only to people still running builds from before members-only content shipped.

People using older Forge builds see fewer things until they update. Nothing leaks and nothing breaks:

- members-only items are left out without saying why, and counts that include them are not labelled;
- a members-only issue opened by its number reads as "not found" (an older `dg` says E102);
- an older web app may describe members-only items as "encrypted by someone who is not a member". That is wrong. Update;
- a message to specific people is a placeholder in builds older than this one, even for the people it was sent to;
- an older build does not count a members-only review's approval, so it may refuse a merge an up-to-date build allows ([E804](../errors.md#e804)). Never the reverse. **Update to see and count members-only reviews.**

Change members only with an up-to-date Forge (`dg` or the web app), so the key follows every change:

- a member added by an older build has no key yet, and sees [E311](../security/audiences.md#e311). Nothing shares it automatically: a maintainer chooses **Repair** on the repository page or runs `dg repo keys repair`;
- a member removed by an older build can still read new members-only content until the key changes. `dg repo keys status` flags it, and `dg repo keys repair` changes the key.
