# Check that our data existed on a given day

Once a day we write a manifest: the SHA-256 of every data file the previous day produced (the price readings, the
recorder's run rows, the case archive and the registry snapshots), with the SHA-256 of the manifest before it. The
manifest's own SHA-256 is sent to the public [OpenTimestamps](https://opentimestamps.org) calendars, which commit it
to Bitcoin within a few hours.

This proves **when** the files existed in exactly this form: from that day on they cannot be changed without the
change showing. It does not prove that what they say is right; the methodology and the public exam are for that.

The same hash is also written to Base and to Robinhood Chain, in one transaction a day, as plain readable text.
Those are mirrors, and the order is deliberate: Base is sequenced by Coinbase and Robinhood Chain by Robinhood, the
two issuers this service checks, so the proof of time lives on the one chain here that none of them operates. The
mirrors are for reach and for speed, a block instead of a few hours. A mirror that disagrees with Bitcoin is a fact
about the mirror.

## Check one day

1. List the days: `https://proofofstock.xyz/anchors/`.
2. Download the day's manifest and one of its `.ots` proofs, for example:

   ```sh
   curl -O https://proofofstock.xyz/anchors/manifest-2026-11-12.json
   curl -O https://proofofstock.xyz/anchors/manifest-2026-11-12.json.a-pool-opentimestamps-org.ots
   ```

3. With the OpenTimestamps client (`pip install opentimestamps-client`), check it:

   ```sh
   mv manifest-2026-11-12.json.a-pool-opentimestamps-org.ots manifest-2026-11-12.json.ots
   ots verify manifest-2026-11-12.json.ots
   ```

   The proofs on the site are completed in place once Bitcoin confirms them: the next daily run asks the calendar
   for the path to the block and adds it, so a proof older than a day already names its Bitcoin block. A proof of
   the last day may still be "pending"; `ots upgrade manifest-2026-11-12.json.ots` completes it from the calendar.
   `ots verify` checks the proof against a Bitcoin node of your own; `ots info` shows which block attests it.

4. To check a data file against the manifest, compare its SHA-256 with the manifest's `files` entry. The data files
   themselves are available on request: hello@proofofstock.xyz.

## Check the mirrors

5. The mirror record of a day sits beside the manifest: `https://proofofstock.xyz/anchors/mirror-2026-11-12.json`.
   It names, per chain, the transaction hash and the address that sent it. Open the transaction in any explorer: its
   calldata is ASCII and reads `proofofstock anchor 2026-11-12 sha256:<hash>`, which must be the same hash as the
   manifest's.
6. Or ask once and get all of it: the MCP tool [`verify_anchor`](../reference/tools.md#tool-verify_anchor) returns
   the hash, the state of each OpenTimestamps proof and every mirror transaction for a day, with the steps.

The transactions are sent by a key that exists for this and nothing else. It signs a transfer of nothing to its own
address, so the worst it can do is spend its own gas; it holds no token of anyone's and never touches one.

The manifests form a chain: each names the SHA-256 of the one before (`previous`), so a gap or a rewritten day shows.
