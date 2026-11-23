# Embed a badge

Use this when you list, link or write about a tokenized stock and want your readers to see, on your own page, whether
that contract is the issuer's: a DEX or aggregator listing, a project page, a README, an article.

The badge is an image the site draws for one contract on one chain. It says the verdict and when it was checked:

| The badge says | When |
|---|---|
| green ✓ `Issuer-listed · NVDAc · Coinbase` | the exact contract is on the issuer's own list |
| red ✗ `Imitates NVDAc` | a look-alike: not on the list, and it copies a listed token |
| grey • `Not in the Coinbase registry` | not on the list (not necessarily fake: another issuer's token is not on it either) |
| amber ? `Registry unavailable` | the check could not be made just now |

It never shows a price, and it prints the address it vouches for and the time of the check, so it cannot be moved onto
a page about another token. It changes by itself when the issuer's list does. It is free and outside the rate limit.

## The quickest way

Open the token on [proofofstock.xyz](https://proofofstock.xyz): paste its address, or type its ticker and pick it. In its
passport, open **embed this badge**: the badge as it looks now, and the HTML and the Markdown to copy.

## By hand

Put the chain (`base` or `robinhood`) and the contract address in the URL:

```html
<a href="https://proofofstock.xyz/?chain=base&address=0x…">
  <img src="https://proofofstock.xyz/badge.svg?chain=base&address=0x…" alt="Proof of Stock verdict" height="40">
</a>
```

```markdown
[![Proof of Stock verdict](https://proofofstock.xyz/badge.svg?chain=base&address=0x…)](https://proofofstock.xyz/?chain=base&address=0x…)
```

The link takes a reader to the token's passport, where the verdict comes with its evidence.

## What to know

- The badge answers for the **address in its URL**. Put the address of the token you are writing about, and check it is
  the one your page names.
- A listed badge is cached for 5 minutes, the others for 1: a change in the issuer's list reaches your page within that.
- It always answers 200 with an SVG, even for a malformed address (then amber): a broken image on your page would read
  as an outage. A program that needs the verdict itself should call [`/verify`](../reference/http-api.md#route-verify).
- Listed says whose contract it is, not that its price is fair or that it is safe to buy.

Reference: [`GET /badge.svg`](../reference/http-api.md#route-badge).
