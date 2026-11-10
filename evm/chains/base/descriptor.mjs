// evm/chains/base/descriptor.mjs — what the passport needs to know about the chain: its id, the dollar stables and wrapped native a pool
// must be paired with to price a stock token (scripts/stocks/stock-peg.mjs referenceAssetsOf), and its public explorer.
export const BASE_DESCRIPTOR = Object.freeze({
  "chainId": 8453,
  "name": null,
  "wrappedNative": "0x4200000000000000000000000000000000000006",
  "stableAssets": [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"
  ],
  "explorer": {
    "webUrl": "https://basescan.org"
  }
})
