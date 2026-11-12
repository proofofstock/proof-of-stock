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

3. With the OpenTimestamps client (`pip install opentimestamps-client`), complete the proof and check it:

   ```sh
   mv manifest-2026-11-12.json.a-pool-opentimestamps-org.ots manifest-2026-11-12.json.ots
   ots upgrade manifest-2026-11-12.json.ots
   ots verify manifest-2026-11-12.json.ots
   ```

   A proof is "pending" until its Bitcoin block is confirmed, usually a few hours after the manifest was written.

4. To check a data file against the manifest, compare its SHA-256 with the manifest's `files` entry. The data files
   themselves are available on request: hello@proofofstock.xyz.

The manifests form a chain: each names the SHA-256 of the one before (`previous`), so a gap or a rewritten day shows.
