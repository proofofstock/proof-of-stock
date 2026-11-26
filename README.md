# Proof of Stock exam, 2026-11-26

Asked https://proofofstock.xyz about 746 tokens whose right answer comes from the issuers, not from us. Set SHA-256 `4fab39c0a3a95138ca227322d864632bcf300df4b6e88c248f5c21e45e3250d2`; rerun with `node scripts/exam.mjs`.

| Check | Result | Target |
|---|---|---|
| False "listed" (look-alikes, strangers, wrong chain) | 0 | 0 |
| False "not listed" (tokens on the issuer list) | 0 | 0 |
| A real token called a fake | 0 | 0 |
| Look-alikes of the week flagged | 60 of 60 | all |
| Coinbase "minted" agrees with total_supply | all | all |
| Refused ("registry unavailable") | 0 | honest when it happens |
| Base list_proof equals the hash of Coinbase's list | yes | yes |
| Robinhood list_proof equals the hash of Robinhood's list | yes | yes |
| Price evidence replayed on chain, same bytes | 5 of 5 on-chain (0 aggregator-only) | all on-chain |
| /verify batch latency p50 / p95 | 432 / 460 ms | reported as is |

Set: A 640 issuer-listed, B 60 look-alikes flagged this week, C 26 strangers, D 20 asked on the other chain.

No failures.

Listed agrees with the issuer by definition; the weight of this exam is in the look-alikes, the honest refusals and the evidence. Found a wrong verdict? hello@proofofstock.xyz
