# The private dashboard at /stats

`https://proofofstock.xyz/stats` is the owner's dashboard: visits by day, the MCP clients and tool calls, the recorder's
last runs per chain and the latest public exam. It shows aggregates only, from the same counter as
`scripts/stocks/analytics-report.mjs`: no pseudonym, no address, no user agent.

## How it is closed

1. nginx asks for a password (`location = /stats` in `deployment/nginx/proofofstock.xyz.conf`, `auth_basic`).
2. Only that location sets the header `X-Pos-Stats: gate`. Every other location clears it. The app answers `/stats` with
   404 unless the header is there, so a request that skipped the password sees the same 404 as an unknown path.
3. The page is `no-store, private` and `noindex`. It loads no script and no beacon, so the owner's own visits are not
   counted.

Until the password file exists, nginx refuses every request to `/stats`.

## Setting the password (the owner, once)

Run this from your own terminal, with <host> being the server's SSH name. The password is typed on the host and never passes through a chat or a file in this
repository:

```bash
ssh -t <host> 'read -rp "User name: " U; printf "%s:%s\n" "$U" "$(openssl passwd -apr1)" > /etc/nginx/pos-stats.htpasswd && chown root:www-data /etc/nginx/pos-stats.htpasswd && chmod 640 /etc/nginx/pos-stats.htpasswd && echo saved'
```

`openssl passwd` asks for the password twice. To change it later, run the same command again. nginx reads the file on
each request, so no reload is needed.
