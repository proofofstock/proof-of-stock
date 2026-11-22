# The private dashboard at /stats

`https://proofofstock.xyz/stats` is the owner's dashboard: visits by day, the MCP agents with discovery kept apart from
use, the recorder's last runs per chain and the latest public exam. It shows aggregates only, from the same counter as
`scripts/stocks/analytics-report.mjs`: no pseudonym, no address, no user agent.

## MCP: discovery is not demand

Since the MCP registry entry (12.11) most of what connects is catalogues and health checkers indexing us, so the page
keeps the two apart. An agent counts as **use** for a day once it called a tool that day, and every request it sent
that day counts with it; everything else is **discovery**. The split is behaviour, never the client name: a name list
would go stale the day a new crawler appears, and a crawler can send any name, so the name is kept as a label in "Who
connected" only. A probe that happens to call a tool counts as use, and the card says so.

### The Agents tab: the same, without the checkers

The owner asked to see it without the catalogues (21.11), so the **Agents** tab hides every client that names itself a
checker: a name with probe, check, health, liveness, uptime, catalog, registry, census, scan, review, rank and similar
words, plus the few catalogues with none (`isCheckerName` in `scripts/stocks/analytics-report.mjs`). One row of the day
with such a name hides the whole agent. It is a view beside the split, never the split itself: the MCP tab still goes
by behaviour, and a checker that calls a tool is still use there. A name is what a client chose to send, so the view
can only undercount checkers: one with a plain name, or with no name, still shows as an agent.

It fits one desktop screen: six tiles on top, then tabs (Overview, Visits, MCP, Agents, Recorder, Exam, Days) made of radio
inputs and CSS, and histograms drawn on the server as inline SVG. On a phone it is one column and scrolls. It does
not refresh itself (a reload would reset the open tab); reload it to see new numbers.

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

## Not counting ourselves

Our own visits are no statistic. Two layers:

1. **No setting needed.** Loopback (`127.0.0.0/8`, `::1`) and every address this host's own interfaces hold are never
   counted, and neither is the CI canary, which names itself (`user-agent: proofofstock-canary`). The host's health
   check talks to `127.0.0.1`, so loopback already covers it. Reading the host's own addresses needs
   `AF_NETLINK` in the unit's `RestrictAddressFamilies=` (`getifaddrs`); without it the server counts its own visits
   and says so at startup:

   ```bash
   ssh <host> 'journalctl -u stp-web -n 30 --no-pager | grep -i "cannot read this host" || echo "its own addresses are being read"'
   ```
2. **The owner's own address** is configuration: `STP_ANALYTICS_IGNORE`, read by `stp-web` from
   `/etc/pos/analytics.env`. Plain addresses and CIDR ranges, IPv4 and IPv6, several of them, separated by commas,
   spaces or newlines, with `#` comments. No setting, or an empty one, ignores nothing beyond layer 1.

The dashboard says it itself: the Overview tab has a "Not counted" card with how many addresses the list holds, how
many of its own the server reads (or that it cannot), loopback, the canary, and the date from which this works. Counts
and a date, never an address: a dashboard ends up in a screenshot.

That date is `IGNORING_SINCE` in `apps/stocks-analytics.mjs`, the day this went live on the host (13.11.2026). It is a
constant because the files cannot tell whose a row was: if the counter is ever moved to a host where the ignoring
starts on another day, change it there, or the card will call earlier days clean when they are not.

An ignored request leaves no row at all: it is in no tile, no day, no country and no button count, and the file keeps
nothing about it. It is dropped before the pseudonym is computed, not when the dashboard reads the files, because the
files hold no address to filter on later: the pseudonym's key lives in memory only and is thrown away every day. The
other side of that: rows already written for an address keep being shown. To start clean, delete the day files
(`/var/lib/stp-analytics/hits-*.jsonl`) or just the ones for the days in question.

Set it from your own terminal, with `<host>` the server's SSH name. The address is typed on the host and never passes
through a chat, this repository or git. A release does not install unit files (`scripts/deploy.sh` only restarts
`stp-web`), so the unit that reads the file is copied in the same command, once:

```bash
ssh -t <host> 'cp /opt/stp/current/deployment/systemd/stp-web.service /etc/systemd/system/stp-web.service && systemctl daemon-reload && read -rp "Addresses or ranges to ignore, comma separated: " A; install -d -m 0755 /etc/pos && printf "STP_ANALYTICS_IGNORE=%s\n" "$A" > /etc/pos/analytics.env && chown root:root /etc/pos/analytics.env && chmod 0600 /etc/pos/analytics.env && systemctl restart stp-web && echo saved'
```

To find your own address first, run `curl -s https://api.ipify.org` on your own machine (not on the host, which would
give the host's). An address from an ISP usually changes now and then, and a phone on mobile data is a different one
again, so this is a list you add to: put every address or range you browse from in it, and check it after a change of
provider or router. Nothing else tells you it went stale; a visit of yours simply shows up in the numbers again. The list is read at startup, so `stp-web` must be restarted after a change; the line it logs then
says how many entries it took, never the addresses themselves:

```bash
ssh <host> 'journalctl -u stp-web -n 20 --no-pager | grep -i "not counting" || echo "nothing configured"'
```
