# Proof of Stock exam, 2026-11-12

Asked https://proofofstock.xyz about 592 tokens whose right answer comes from the issuers, not from us. Set SHA-256 `8263f324665cf8f494bd1ab1b0918ed66391c48b1f01beefcb3dc1f124d399c3`; rerun with `node scripts/exam.mjs`.

| Check | Result | Target |
|---|---|---|
| False "listed" (look-alikes, strangers, wrong chain) | 0 | 0 |
| False "not listed" (tokens on the issuer list) | 0 | 0 |
| A real token called a fake | 0 | 0 |
| Look-alikes of the week flagged | 5 of 5 | all |
| Coinbase "minted" agrees with total_supply | all | all |
| Refused ("registry unavailable") | 0 | honest when it happens |
| Base list_proof equals the hash of Coinbase's list | yes | yes |
| Robinhood list_proof equals the hash of Robinhood's list | yes | yes |
| Price evidence replayed on chain, same bytes | 6 of 6 on-chain (0 aggregator-only) | all on-chain |
| /verify batch latency p50 / p95 | 310 / 747 ms | reported as is |

Set: A 541 issuer-listed, B 5 look-alikes flagged this week, C 26 strangers, D 20 asked on the other chain.

No failures.

Listed agrees with the issuer by definition; the weight of this exam is in the look-alikes, the honest refusals and the evidence. Found a wrong verdict? hello@proofofstock.xyz
