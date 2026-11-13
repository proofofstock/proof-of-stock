# Check that our data existed on a given day

Once a day we write a manifest: the SHA-256 of every data file the previous day produced (the price readings, the
recorder's run rows, the case archive and the registry snapshots), with the SHA-256 of the manifest before it. The
manifest's own SHA-256 is sent to the public [OpenTimestamps](https://opentimestamps.org) calendars, which commit it
to Bitcoin within a few hours.

This proves **when** the files existed in exactly this form: from that day on they cannot be changed without the
change showing. It does not prove that what they say is right; the methodology and the public exam are for that.

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

The manifests form a chain: each names the SHA-256 of the one before (`previous`), so a gap or a rewritten day shows.
