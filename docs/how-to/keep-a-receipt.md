# Keep a receipt of a check

If your wallet, exchange or agent shows a user a warning about a token (or lets a buy through), you may later have to
show why. A receipt is the record of one check, made so that it can be checked again months later, after the issuer's
list has changed and without trusting us.

## Get one

```bash
curl -s 'https://proofofstock.xyz/verify?chain=base&address=0xb20000000000000000000078ee7ce2fe4908108c&receipt=1' | jq .receipt > receipt.json
```

The receipt holds:

- `verdict` (`listed`, `impostor` or `not_listed`), the address and the chain, and when it was issued;
- `rule`: the rule the verdict follows, in words, and the version of the service that applied it;
- `list`: the issuer list it was decided against, named by the SHA-256 of its sorted addresses, and
  `addresses_url`, that exact list frozen (it is kept in the history archive, so the URL keeps answering);
- `issuer_factory`: whether the issuer's own token factory created the contract, from the chain;
- `sha256`: the SHA-256 of all the above, over the JSON with its keys sorted.

## Check one, now or later

```bash
node scripts/receipt-check.mjs receipt.json
```

From [the repository](https://github.com/proofofstock/proof-of-stock); Node 20 or newer, no dependencies. It checks:

1. **where the list is served from:** a receipt that names a list anywhere but this site fails here, before anything
   is fetched. Without that check the whole exercise is circular: anyone could write a receipt saying `listed`, serve
   a list that hashes to what it claims, rehash the receipt, and watch every other check go green on their own bytes;
2. the receipt's own hash: an edited receipt fails here;
3. its fields: the address, the chain and the verdict must be well-formed and agree with each other (a verdict of
   `impostor` with `listed: true` fails here, before anything is fetched or printed);
4. the list's chain: this site names the chain of every frozen list it serves (the `x-pos-chain` header), and a Base
   receipt over a Robinhood list fails here;
5. the frozen list's hash against the one the receipt names: a different list fails here;
6. the verdict again, from that list: a receipt rehashed after its verdict was changed fails here.

What the list can show is whether the address was on it. A verdict of `impostor` says more: that the token's symbol
or name copied a listed one. That part is our finding at the time of the check, and the checker says so rather than
claiming to have derived it again.

Our daily [anchors](verify-an-anchor.md) put the archive's files in Bitcoin's timeline, so the frozen lists can also be
shown to have existed on their day. A receipt carries no signature: what makes it checkable is the hashes.
