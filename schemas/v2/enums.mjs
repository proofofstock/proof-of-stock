// schemas/v2/enums.mjs: the enums of the stock-peg schemas, held equal to the schema files by the tests.
export const PEG_REFUSALS = Object.freeze(["no_reference","pairs_unavailable","no_pairs","no_eligible_pool","sources_disagree","reference_spread_wide"])
export const POOL_SOURCES = Object.freeze(["dexscreener","dexscreener+geckoterminal","dexscreener+onchain","dexscreener+geckoterminal+onchain","onchain"])
export const POOL_SIDES = Object.freeze(["base","quote"])
