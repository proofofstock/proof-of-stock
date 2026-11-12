// evm/chains/robinhood/descriptor.mjs: what the passport needs to know about the chain: its id, the dollar stables and wrapped native a pool
// must be paired with to price a stock token (scripts/stocks/stock-peg.mjs referenceAssetsOf), and its public explorer.
export const ROBINHOOD_DESCRIPTOR = Object.freeze({
  "chainId": 4663,
  "name": null,
  "wrappedNative": "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  "stableAssets": [
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
  ],
  "explorer": {
    "webUrl": "https://robinhoodchain.blockscout.com"
  }
})
