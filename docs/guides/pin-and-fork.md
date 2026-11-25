# Pin or fork a repository

Two ways to keep someone else's repository on storage you run:

- **Fork** it to get your own copy you can push to. The parent's packs are copied to your storage, and your copy is listed first.
- **Pin** it to help host it without taking it over. Your storage keeps a copy of every pack, and a pack mirror record tells readers where it is. If the repository's own storage goes away, `git clone` still works from your copy.

Both need storage that other people can read: an IPFS node (yours from `dg ipfs up`, or one on a NAS or server, see [Run your own backend](self-host-backend.md)), or a bucket with a public URL. A bucket with no public URL works for a fork you read yourself, but not for a pin. Platform storage needs neither: it is already permanent.

## On the web

On a repository page, **Fork** and **Pin** sit side by side. Pin shows how many files it will copy, the space they take, and the fee for the records, then copies them in your browser. Once the copy is done the button says **Pinned**. After new pushes it says **Update pin (N new)**, and one click copies just the new packs. If you have no storage yet, the dialog's button is **Set up storage**.

## From the terminal

```sh
dg repo pin <owner>/<name>                    # copy and record, after showing the cost
dg repo pin <owner>/<name> --storage nas      # choose the profile
dg repo pin <owner>/<name> --follow           # also copy later pushes …
dg repo pin --all                             # … whenever this runs (cron, a systemd timer)
dg repo unpin <owner>/<name>                  # delete your records; files stay on your storage

dg repo fork <owner>/<name> --storage nas     # fork, copying the parent's packs
dg repo sync <you>/<name>                     # bring the fork up to date, copying new packs
```

Without `--storage`, both commands use the first profile in your storage policy (`dg storage use`) that others can read. A pin also falls back to your only such profile. `dg repo fork --no-copy` forks by reference, as before: the fork reads the parent's storage.

## What it costs

- **Copying** is free on Platform: it only uses your own disk or bucket.
- **A pin** writes one pack mirror record per pack: `dg` quotes up to 0.00075 DASH each (measured about 0.0005, 0.0006 for a repository's first). `dg repo unpin` deletes them and refunds most of that, as its prompt says (on testnet, less as the records age; see [Refunds](costs.md#refunds)).
- **A fork** costs what it did before, plus a few bytes for each extra address in its manifests.

## Private repositories

Readers never use pinned copies of a private repository. A member can still keep an encrypted backup on their IPFS node with `dg ipfs pin`.

How it works: [design note](../design/pin-and-fork-copies.md).
