# Deploying Bay Area Mesh Health Check — self-hosted + Cloudflare Tunnel

Target: `https://healthcheck.bayareameshcore.org` served from your own box, no inbound ports open.

## Why not Vercel

Worth recording, because it will come up again. The app is a single long-lived Node process, and every one of these is load-bearing:

- A persistent MQTT subscription to `mqtt.gomesh.dev` that must stay connected and accumulate observer state between page views.
- An in-process WebSocket server (`new WebSocketServer({ noServer: true })`, `server.js:3052`) plus HTTP upgrade handling.
- In-memory `Map`s for `sessions`, `observerState`, `messageToSession`, `rateLimitBuckets`, `turnstileAuthTokens` (`server.js:716-721`) and a `setInterval` pruning them (`server.js:3147`).
- `fs.writeFileSync` into `./data`, mounted as a Docker volume.

Vercel functions cannot hold any of that. Instances are paused between requests and recycled, and the docs explicitly tell you to keep shared state in an external store rather than instance memory ([Vercel Services on Fluid compute](https://vercel.com/kb/guide/vercel-services-fluid-compute)). Execution is capped — 300 s on Hobby, 800 s max on Pro, 1800 s in extended beta ([function limits](https://vercel.com/docs/functions/limitations)). WebSockets do work now, but a socket is pinned to one instance and closes at the duration cap ([WebSockets on Vercel](https://vercel.com/docs/functions/websockets)). Running this on Vercel would mean splitting out a separate always-on MQTT→state service plus Redis/KV — a rewrite, not a config change. The repo already ships a `Dockerfile` and `docker-compose.yml`, so self-hosting takes it as-is.

## Recommended host — a $6 DigitalOcean droplet

The tunnel path below is the right answer when the box has no public IP: a Pi at home, anything behind CGNAT. It is the wrong answer when you can just have an IP, because the tunnel is a second daemon that can fail independently of the app — and did, twice, in ways recorded in the appendix.

So the recommended production shape is a **DigitalOcean Basic droplet, 1 GiB / 1 vCPU / 25 GiB, in SFO3, $6/mo** ([Droplet pricing](https://www.digitalocean.com/pricing/droplets)). Billing is per-second since 1 January 2026 with a 672-hour monthly cap, so the bill never exceeds the monthly figure ([DigitalOcean](https://www.digitalocean.com/blog/dropletplans-persecbilling-byoip-natgateway)). The included 1,000 GiB of outbound transfer is far beyond anything this dashboard emits; overage would be $0.01/GiB ([Droplet pricing details](https://docs.digitalocean.com/products/droplets/details/pricing/)).

**Do not take the $4 / 512 MiB plan.** Runtime is not the problem — steady-state RSS is under 200 MiB. `npm ci` is: dependency extraction gets OOM-killed on 512 MiB even with dev dependencies omitted. The extra $2 also brings 25 GiB of disk instead of 10 GiB.

SFO3 rather than a New York or European region: it is a current region ([Droplet availability](https://docs.digitalocean.com/products/droplets/details/availability/)) and it puts the box a few milliseconds from the Bay Area operators actually loading the page.

Two scripts in `scripts/` do the whole job:

| File | Role |
|---|---|
| `scripts/provision-droplet.sh` | Idempotent bare-metal-to-serving setup. Swap, Node, service account, source, `npm ci --omit=dev`, systemd, Caddy, ufw, unattended upgrades, verification. |
| `scripts/mesh-health-check.service` | The systemd unit. Installed by the script; `sed` rewrites `APP_DIR`/`User` if you override them. |
| `scripts/update-app.sh` | Snapshot `data/`, deploy a new version, `npm run check`, restart, health-gate, print rollback commands. |

```bash
# on a fresh Ubuntu 24.04 droplet, as root
DOMAIN=healthcheck.sonomamesh.com \
SOURCE_MODE=archive ARCHIVE=/root/mhc-deploy.zip \
TLS_MODE=origin-ca ADMIN_SSH_CIDR=<your.ip>/32 \
  ./provision-droplet.sh
```

### What this deletes

Every moving part the sandbox deployment needed in order to fake a public IP:

| Retired | Replaced by |
|---|---|
| `/tmp/app-supervise.sh` | `Restart=always` in the unit — a supervisor the OS maintains |
| `/tmp/named-tunnel.sh`, `/tmp/named-tunnel-b.sh` | a real public IPv4 |
| `/tmp/tunnel-watchdog.sh` (`scripts/tunnel-watchdog.sh`) | nothing to watch; no tunnel to half-open |
| `protocol: http2` and quoted `edge-ip-version: "4"` | Caddy, which has no equivalent trap |
| two `cloudflared` replicas | one reverse proxy |

`healthcheck.sonomamesh.com` does not change. You replace the tunnel `CNAME` with an `A` record at the droplet IP; the hostname, and therefore UptimeRobot monitor `803863215`, is untouched.

### Four decisions worth knowing about

**The unit must not use `EnvironmentFile=`.** `server.js` loads `.env` itself with `parseEnvFileLoose()`, which deliberately takes everything after the first `=` as the value, inline `#` included. systemd's parser strips inline comments and unescapes quotes. Point both at the same file and `APP_DESCRIPTION` and the MQTT comment blocks resolve differently depending on which one read it. The app owns its config file; the unit sets only `NODE_ENV`.

**`ProtectSystem=strict` with one `ReadWritePaths`.** The whole filesystem is read-only to the service except `data/`. That is sufficient and was verified against every write path: `server.js:1026-1031` (write-temp-then-rename, which needs the *directory* writable, not just the file), `server.js:1360-1361` (`reseed-log.jsonl`), and `seed-observers.py:333-334` (`shutil.copy2` backup then rewrite). The daily reseed's `python3` child inherits the sandbox and stays inside it.

**`StartLimitIntervalSec=0`.** systemd's default gives up permanently after 5 restarts in 10 seconds. For an unattended dashboard that converts a transient boot-time DNS failure into an indefinite outage — precisely the class of failure this move exists to eliminate. `RestartSec=5` still caps the loop at 12 attempts a minute.

**`MemoryDenyWriteExecute` is deliberately absent.** The V8 JIT needs `W+X` pages; Node will not start with it set. Every other hardening directive is on.

### Firewall

`server.js` calls `listen(PORT)` with no host argument, so it binds `0.0.0.0`. The firewall is the only thing keeping `:3090` private, and the script never opens it. With `TLS_MODE=origin-ca` the script also fetches [Cloudflare's published ranges](https://www.cloudflare.com/ips-v4) and allows 443 only from them, so the origin IP is unreachable directly and 80 stays shut — Cloudflare handles the redirect at the edge.

`TRUST_PROXY=1` must stay set. Behind a reverse proxy without it, every session arrives from `127.0.0.1` and the per-IP rate limiter throttles the entire internet as a single client. The script checks and warns.

### TLS

`TLS_MODE=origin-ca` keeps the orange cloud on: create a 15-year Cloudflare Origin CA certificate for the hostname, drop the pair at `/etc/caddy/origin.pem` and `/etc/caddy/origin.key`, set the zone to Full (strict). Note that `caddy validate` *provisions* the TLS loader, so a missing cert pair is a hard validation failure rather than a warning — the script detects this and says so instead of leaving Caddy dead silently.

`TLS_MODE=letsencrypt` is the grey-cloud alternative and needs the record set to DNS only, or Cloudflare answers the ACME HTTP-01 challenge instead of Caddy.

Both generated Caddyfiles were validated against Caddy 2.10.0. The script runs `caddy fmt --overwrite` first, because an unset `tls`/`email` line leaves a blank line inside a block that Caddy accepts but complains about on every start.

### Automatic reboots at 04:30

`unattended-upgrades` is configured to reboot for kernel updates at 04:30 local — after `OBSERVER_RESEED_HOUR=4` has finished its pass, so a restart never lands mid-write on `observer.json`.

## What you need (tunnel path)

- A box that stays up: Raspberry Pi 4/5, NUC, home server, or any small VPS. Docker + Docker Compose plugin. ~500 MB RAM is plenty.
- Outbound 443 only. `cloudflared` dials Cloudflare; nothing is forwarded inward, so this works fine behind CGNAT or a locked-down router.
- `bayareameshcore.org` is already on Cloudflare nameservers (`chip.ns.cloudflare.com`, `zainab.ns.cloudflare.com`), so the hostname route works with no registrar changes.

## Step 1 — create the tunnel

Zero Trust dashboard → Networks → Tunnels → Create a tunnel → **Cloudflared** → name it `bayarea-health-check`. Copy the connector token (the long string after `--token`). This is the remote-managed path: routes live in the dashboard, so you never hand-edit `config.yml`.

Then add a public hostname on that tunnel:

| Field | Value |
|---|---|
| Subdomain | `healthcheck` |
| Domain | `bayareameshcore.org` |
| Type | `HTTP` |
| URL | `mesh-health-check:3090` |

Saving this creates the proxied `CNAME healthcheck → <tunnel-uuid>.cfargotunnel.com` for you. (CLI equivalent, if you prefer locally-managed: `cloudflared tunnel create bayarea-health-check` then `cloudflared tunnel route dns bayarea-health-check healthcheck.bayareameshcore.org`.)

Leave "Additional application settings" alone — the defaults proxy WebSocket upgrades, which the live dashboard needs.

## Step 2 — files on the box

```
git clone https://github.com/yellowcooln/meshcore-health-check.git
cd meshcore-health-check
cp /path/to/.env.bayarea.example .env
cp /path/to/us-ca-bay-area.geojson regions/
cp /path/to/theme-bayarea.css public/
cp /path/to/logo.png public/logo.png        # keep the stock one as logo-stock.png
mkdir -p data
```

Also apply the three one-line HTML patches (`index.html`, `landing.html`, `share.html`: add `<link rel="stylesheet" href="/theme-bayarea.css">`, set `theme-color` to `#0b1220`) and the `sw.js` patch (add `/theme-bayarea.css` to `CORE_ASSETS`, bump the cache name). Easiest path: push a `bayarea` branch to your GitLab with all of this committed, and clone that instead — then updates are `git pull && docker compose up -d --build`.

Drop `docker-compose.tunnel.yml` next to `docker-compose.yml`.

## Step 3 — finish `.env`

Everything else is already set in `.env.bayarea.example`. Fill these four:

```
MQTT_PASSWORD=<the GoMesh password>
SITE_URL=https://healthcheck.bayareameshcore.org
TURNSTILE_SITE_KEY=<from Cloudflare → Turnstile>
TURNSTILE_SECRET_KEY=<from Cloudflare → Turnstile>
TUNNEL_TOKEN=<connector token from step 1>
CARTO_BASEMAP_KEY=<free key from https://carto.com/basemaps/apikey/>
TRUST_PROXY=1
```

`CARTO_BASEMAP_KEY` (accepted as `CARTO_API_KEY` too, for .env files written before upstream v1.3.8) is what stops the basemap tiles being stamped with CARTO's "API KEY REQUIRED" watermark. Free, no account, emailed back immediately; 5M tiles/month fair use. Without it the map falls back to OpenStreetMap tiles in both themes (upstream v1.3.8 behaviour) rather than requesting a watermarked CARTO tile.

Turnstile: create a widget for domain `healthcheck.bayareameshcore.org`, Managed mode. Without keys you must set `TURNSTILE_ENABLED=false`, otherwise the gate fails with "Invalid input for parameter sitekey" — fine locally, not fine on a public URL where anyone can burn code generations.

`TRUST_PROXY=1` matters behind the tunnel, or every visitor looks like the same IP to the rate limiter.

Reminders from the earlier work, since they bite silently:

- `TEST_CHANNEL_NAME=healthcheck` — **no** `#`. The UI adds it; `#healthcheck` renders as `##healthcheck`.
- `TEST_CHANNEL_SECRET=3ae59c2cda86744c75e68b3975a902ae` — the derived hashtag key. Blank means the dashboard connects and counts observers but never matches a code.
- Never leave `MQTT_TOPIC` blank; it falls back to Boston's `meshcore/BOS/#`.
- No inline `#` comments on assignment lines — the env parser keeps them as part of the value.

## Step 4 — bring it up

```
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
docker compose logs -f mesh-health-check
```

Healthy startup looks exactly like this:

```
[regions] loaded 23 region boundaries from regions/us-ca-bay-area.geojson
[web] listening on http://localhost:3090
[web] using broker mqtt.gomesh.dev and #healthcheck (02)
[mqtt] connected mqtt.gomesh.dev
[mqtt] subscribed meshcore/#
```

And `docker compose logs cloudflared` should show `Registered tunnel connection`. If it loops on `failed to dial to edge with quic`, your network blocks UDP/443 — uncomment `TUNNEL_TRANSPORT_PROTOCOL: http2` in the overlay and recreate.

## Step 5 — verify

```
curl -s https://healthcheck.bayareameshcore.org/api/bootstrap | jq '.mqtt, (.activeObservers|length)'
```

Expect `"connected": true`, broker `mqtt.gomesh.dev`, and roughly 30 active observers — that matched the live count today. Then in a browser: pass Turnstile, take the generated `MHC-XXXXXX` code, send it to `#healthcheck` from a real node, and watch observers light up.

One thing that looks broken but isn't: region and group filters populate slowly. Observer coordinates only arrive on advert/status packets, which are a small fraction of broker traffic. Fifteen minutes after a cold start today, 1 of 31 observers had coordinates (San Benito / Central Coast). Give it hours, not minutes, and keep the `data` volume so it survives restarts.

## Operating notes

- Backups: only `./data` holds state. A nightly `tar` of it is enough.
- Updates: `git pull && docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build`. Bump the `sw.js` cache name whenever you change front-end assets, or PWA installs keep serving stale files.
- Cloudflare zone: leave the record proxied. Don't enable "Bot Fight Mode" on this hostname — it can kill the WebSocket upgrade. Turnstile is already doing the human check.
- Rotate the GoMesh MQTT password; it has been shared in chat.
- Monitoring: two respawn loops for repair, plus a Cloudflare Tunnel Health Alert and a 5-minute external keyword check for detection. See "Monitoring and alerting" in the appendix — including why the scheduled agent watchdog was retired.
- If you'd rather not run hardware, the same tree deploys unchanged to Fly.io or Render with a persistent volume — the tunnel overlay is simply omitted.

## Appendix — the live test instance's named tunnel (built 2026-08-29)

The sandbox test instance ran on `trycloudflare.com` quick tunnels for two days. Cloudflare revoked the hostname **nine times in eleven hours**, each after 55–120 minutes: authoritative NXDOMAIN from `cloudflare-dns.com` while `cloudflared` still reported `readyConnections: 1`, so the process had no idea it was orphaned. Every share link minted before a revocation was dead. Quick tunnels are unusable for anything you hand to other people.

It now runs on a **named tunnel** bound to `healthcheck.sonomamesh.com`. The shape of it, for rebuilding your own — substitute your own identifiers for the `<PLACEHOLDERS>`:

| Thing | Value |
| --- | --- |
| Tunnel name | `bayarea-mesh-health-check` |
| Tunnel ID | `<TUNNEL_ID>` — a UUID, returned when you create the tunnel |
| Account | `<ACCOUNT_ID>` — 32 hex chars, in any dashboard URL or from `GET /accounts` |
| Zone | `sonomamesh.com` → `<ZONE_ID>` — 32 hex chars, on the zone's Overview page |
| DNS record | CNAME `healthcheck` → `<TUNNEL_ID>.cfargotunnel.com`, proxied |

The `cfargotunnel.com` target is derived purely from the tunnel ID; there is no separate hostname to look up.

### API token permissions

A custom token needs **three** rows, and the tunnel one is the easy one to miss:

- **Account → Cloudflare Tunnel → Edit** — "Grants access to create and delete Cloudflare Tunnels" ([Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). There is no Zone-scoped equivalent, so if the permission row's scope dropdown says Zone the option never appears in the list. Newer dashboards label the value **Write** rather than Edit.
- **Zone → DNS → Edit**
- **Zone → Zone → Read**

With Tunnel set to Read instead of Edit, `POST /accounts/:id/cfd_tunnel` fails with a bare `10000 Authentication error` — indistinguishable from a bad token, and `GET` on the same path still returns `200` with an empty list.

### Creating it without a browser

`cloudflared tunnel login` needs an interactive browser, so create the tunnel over the API and write the credentials file yourself:

```bash
SEC=$(openssl rand -base64 32)
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"bayarea-mesh-health-check\",\"tunnel_secret\":\"$SEC\",\"config_src\":\"local\"}"
# then, from the returned id:
# { "AccountTag": "<acct>", "TunnelSecret": "<SEC>", "TunnelID": "<id>" }  -> /etc/cloudflared/creds.json  (chmod 600)
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"CNAME\",\"name\":\"healthcheck\",\"content\":\"$TID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"
```

`config_src: local` keeps ingress rules in your own YAML rather than the Zero Trust dashboard.

### The config, including two things that cost time

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/creds.json
metrics: 127.0.0.1:20242
no-autoupdate: true
protocol: http2
edge-ip-version: "4"
retries: 10
ingress:
  - hostname: healthcheck.sonomamesh.com
    service: http://localhost:3090
  - service: http_status:404
```

- **`protocol: http2` is not optional here.** Outbound UDP is blocked in this sandbox, so QUIC fails with `failed to dial to edge with quic: timeout: no recent network activity`, retries forever, and the hostname serves `530`. `cloudflared`'s own preflight cheerfully reports "UDP Connectivity: QUIC connection successful" and then still can't hold the connection.
- **`edge-ip-version` must be quoted.** Unquoted `4` is parsed as an integer and `cloudflared` exits immediately with `expected string found int for edge-ip-version` — with the supervisor loop in place that turns into a silent crash-loop, visible only in the log.

Healthy startup registers four connections and `curl -s http://127.0.0.1:20242/ready` returns `{"status":200,"readyConnections":4,...}`.

### Monitoring and alerting

The hourly URL-rotation watchdog is **gone**, and so is the daily one that replaced it. Across 27 runs, every one of its 8 recovery events was quick-tunnel hostname loss — a failure mode the named-tunnel cutover eliminated outright. It never once had to restart the app. An agent-driven watchdog also bills for a whole reasoning session every time it fires, to answer a question `curl` answers for free.

What replaced it is three layers, none of which cost anything to run.

**1. Local supervision — repairs.** Two bash respawn loops, one per process, restart the child 5 s after any exit:

```bash
# /tmp/app-supervise.sh   (and /tmp/named-tunnel.sh, same shape for cloudflared)
while true; do
  node server.js >> /tmp/mhc-supervised.log 2>&1
  echo "$(date -u +%FT%TZ) exited $? - respawning in 5s" >> /tmp/mhc-supervised.log
  sleep 5
done
```

Verified by `kill -9` of the node child: back and answering 200 in under 12 s, MQTT reconnected on its own. On a real box use `restart: unless-stopped` in Compose, or a systemd unit with `Restart=always`, instead of this.

The hazard this creates: **a supervisor will fight you.** `data/observer.json` is read once at boot into an in-memory `Map` and rewritten from that Map, debounced 250 ms after any learned advert. Editing the file while the app runs gets it clobbered, and killing only the node child is useless because the loop brings it straight back. Anything writing that file from outside has to stop the *supervisor* first, then the child, confirm nothing respawned, then write.

**Which is why the CoreScope refresh moved inside the app.** `OBSERVER_RESEED_ENABLED=true` runs the seeding pass in-process, once a day after `OBSERVER_RESEED_HOUR` (local): the app flushes its debounced write, spawns `seed-observers.py --write --json`, then reloads the file into the same `Map` and reconciles. The file wins for coordinates and confirmed hash widths — the fields the script owns, including the deliberate clearing of a position outside the region boundary — and memory wins for names and uplink codes, which are learned from adverts and MQTT topics. There is no stop, no restart, and no outage: measured at **~800 ms** per pass, with a second pass immediately after reporting zero changes. Each pass appends one JSON line to `data/reseed-log.jsonl`, and the script prunes its own `observer.json.bak-*` files to the newest `SEED_BACKUPS_KEEP` (14).

Two things follow. The daily agent task is gone, because nothing in that sequence needs reasoning — it was billing a reasoning session to run `curl`, a diff, and a restart. What remains is one **weekly** agent run that only reads `reseed-log.jsonl`, checks a scheduled pass landed on each of the last seven days, and pages you if an observer newly appeared on the map, a hash width moved, a rendered prefix collided, a day is missing, or either host is not answering 200.

Scheduling it from outside is possible but earns nothing. With `ADMIN_TOKEN` set, `POST /api/admin/reseed` (header `x-admin-token`) drives the same pass, and `GET` on the same path returns the last result — enough for host cron, a Cloudflare Workers cron trigger, or a CI schedule. Cron Triggers are on the Workers free plan, capped at 5 per account with 10 ms CPU per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)), and since a Worker can only make an HTTP request it would still need this endpoint. An app that can be poked on a schedule can equally run its own timer, so the external scheduler is one more moving part and one more authenticated route facing the internet. Both routes 404 while `ADMIN_TOKEN` is blank, which is the default.

**1b. Two connector replicas — the 1033 gap.** One `cloudflared` is not enough on a host with unreliable egress. Measured over the first 5h40m of this deployment, the connector lost **all four** edge connections at once eight times: 12:22:31Z, 13:50:55Z, 16:10:16Z and 16:53:57Z were spontaneous, and each burst dropped every `connIndex` within the same second. Recovery is fast — 1 to 20 s, backoff starts at 1 s — but while the count is zero the tunnel has no connector, so Cloudflare serves **HTTP 530 with `error code: 1033`** even though the app on `localhost:3090` is answering 200 the whole time. That is what a user reports as "the host is down". The 16:53 burst was preceded by `Failed to refresh DNS local resolver error="lookup region1.v2.argotunnel.com: i/o timeout"`, which points at the sandbox's egress rather than at any Cloudflare colo. `protocol: http2` makes it more likely, since long-lived HTTP/2 streams are exactly what an idle NAT timeout collects, and QUIC is not an option where UDP is blocked.

The fix is redundancy at the tunnel, not a faster restart: run a **second `cloudflared` replica of the same tunnel**, with its own supervisor loop, its own log, and its own metrics port. Same `tunnel:` ID, same credentials file, same ingress — nothing about DNS, the hostname or the tunnel ID changes. Cloudflare registers it as a separate connector and load-balances across every connection either one holds, so one replica flapping no longer takes the count to zero:

```bash
sed 's#20242#20243#' /tmp/cf-tunnel-config.yml > /tmp/cf-tunnel-config-b.yml
# then a second respawn loop running: cloudflared --config /tmp/cf-tunnel-config-b.yml tunnel run
```

```
GET /accounts/<acct>/cfd_tunnel/<id>  ->  status healthy | total conns 8
  connector 8830a7ab  4 connections
  connector 99f60057  4 connections
```

Proven by killing one outright — supervisor first, then the connector, so nothing respawned — and polling the public hostname every 3 s for 30 s: **ten consecutive 200s**. The same test against a single connector on 2026-08-29 at 14:24 produced 530s for about 30 s. On a real box this is two systemd units, or `deploy: replicas: 2` in Compose, and it is worth having even on a stable network: it also makes `cloudflared` upgrades and config changes zero-downtime, one replica at a time.

**1c. The wedge that supervision cannot see — and why replicas didn't save it.** At **17:38:17Z** Cloudflare set the tunnel's connection count to zero and left it there for 30 minutes, serving 530 / 1033, while:

- the app answered **200 in 13 ms** on `localhost:3090` the whole time,
- **both** `cloudflared` replicas reported `{"status":200,"readyConnections":4}`,
- both had **logged nothing at all** since registering at 16:58 and 16:59Z — no `Lost connection`, no retry, no error,
- and `ss -tnp` showed all eight sockets to `198.41.x.x:7844` still `ESTAB` with empty send and receive queues.

Half-open TCP. The edge had gone away; this sandbox's NAT (local address `169.254.0.21`) never delivered a FIN or RST, so from the connectors' side nothing had happened. `protocol: http2` has no application-level keepalive to notice, and a fresh `/dev/tcp` connection to `198.41.192.227:7844` succeeded on the first try, so egress itself was fine. Nothing was broken enough to fix itself.

**This is why §1b was only half a fix.** Two replicas protect against one connector flapping independently. They protect against nothing when the failure is shared by the host both replicas sit on — both wedged in the same minute, in the same way, for the same reason. Redundancy on one box is redundancy against one box's *processes*, not against its network.

Neither existing layer could catch it. The respawn supervisors watch for **exit**, and the process never exited. `/ready` and `/metrics` are the wedged process's own opinion of itself, and it reported four healthy connections while holding four dead sockets — so any check pointed at `:20242` would have passed happily through the entire outage. **Liveness has to be measured end to end**, from outside, at the URL a user types.

Hence `/tmp/tunnel-watchdog.sh`: plain bash, no agent, no credits. Every 60 s it probes the public URL. On a non-200 it probes `localhost:3090` too, and if the app is the thing that is down it logs that and keeps its hands off, because the app supervisor owns that. Two consecutive public failures with a healthy app means the tunnel is wedged, so it kills the connector *children* by exact PID — never a supervisor, never `node` — and their own respawn loops bring them back 5 s later. Then a 90 s cooldown so it cannot fight the reconnection it just triggered.

Two details that matter, both learned by testing it rather than trusting it:

- **`kill` does not kill a stopped process.** The first version's `SIGTERM` sat queued while the target stayed in state `Tl`, and the watchdog logged two confident "restarting" lines having killed nothing at all. It now sends `SIGCONT`, then `SIGTERM`, waits up to 6 s, escalates to `SIGKILL`, and logs loudly if a PID survives even that.
- **Match the binary, not the string.** The pattern is `$2 == "/tmp/cloudflared" && /tunnel run$/` on `ps -eo pid,args`, anchored on the executable, so no shell command that merely mentions `cloudflared` can be selected as a victim.

Measured end to end: connectors frozen with `SIGSTOP` at **18:15:49Z** (a wedge the supervisors cannot see and `/ready` denies), detected at **18:16:39Z**, both restarted by **18:17:09Z**, public **200** at **18:17:09Z**. **80 seconds, unattended.** Cloudflare then reported `healthy | conns 8` across both connectors again. Worst case is the probe interval plus one 20 s second opinion plus reconnection — roughly 100 s — against the 30 minutes this failure ran unattended.

**QUIC is not the answer here, tempting as it looks.** QUIC has the keepalives that would notice a dead path in seconds, and `cloudflared`'s own precheck reports `UDP Connectivity region1/region2 PASS - QUIC connection successful`. It fails in practice: switching one replica to `protocol: quic` registered and then immediately produced `failed to run the datagram handler error="timeout: no recent network activity"` and `failed to accept QUIC stream`, with `readyConnections: 0`. The UDP handshake survives this NAT; a sustained datagram flow does not. Reverted to `http2` on both, which is what the pinned setting in the config was always protecting.

**2. UptimeRobot — external detection.** A **keyword** monitor, not a plain HTTP one:

| Field | Value |
| --- | --- |
| Type | `KEYWORD` |
| URL | `https://healthcheck.<your-domain>/api/bootstrap` |
| Keyword | `observerDirectory`, `keywordType: ALERT_NOT_EXISTS` |
| Accepted status codes | `2xx, 3xx, 4xx, 5xx` — deliberately all of them |
| Interval | 300 s (the free plan's floor) |
| Region | `na` |

Accepting every status code and requiring a string from the payload catches what a status-code check misses: tunnel up, app up, but the edge serving an interstitial, a Cloudflare error page, or a stale cache. `observerDirectory` only appears if the real bootstrap JSON was generated. The free plan allows 50 monitors and 5 integrations at a 5-minute interval ([UptimeRobot pricing](https://uptimerobot.com/pricing/)).

Created over the v3 API, which takes a bearer token — v2's `api_key`-in-the-body style is awkward to inject safely:

```bash
curl -s -X POST https://api.uptimerobot.com/v3/monitors \
  -H "Authorization: Bearer $UR_KEY" -H 'Content-Type: application/json' \
  -d '{"type":"KEYWORD","url":"https://healthcheck.<your-domain>/api/bootstrap",
       "friendlyName":"healthcheck - Bay Area mesh health check","interval":300,
       "keywordType":"ALERT_NOT_EXISTS","keywordValue":"observerDirectory",
       "successHttpResponseCodes":["2xx","3xx","4xx","5xx"],"regionalData":"na",
       "assignedAlertContacts":[{"alertContactId":<ID>,"threshold":0,"recurrence":0}]}'
```

Two API quirks worth knowing: `regionalData` must be the bare string `"na"` on create (`{"REGION":["na"]}` is rejected with `regionalData must be one of the following values: na, eu, as, oc`, even though that object shape is what `GET` returns), and a `threshold` above 0 is silently normalised to 0 — alerts fire on the first failed check.

**3. Cloudflare Tunnel Health Alert — first-party detection.** Cloudflare itself knows when the connector deregisters, which is faster and more specific than any external prober. Included with all Zero Trust plans, free tier included ([Cloudflare tunnel notifications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/notifications/)).

The alert type is `tunnel_health_event`, shown in the dashboard as **Tunnel Health Alert**. Do not confuse it with `tunnel_update_event` (tunnel created/deleted) or with the Magic WAN / IPsec / GRE tunnel alerts, which are a different product. Enumerate what your account actually offers before guessing:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/alerting/v3/available_alerts" \
  -H "Authorization: Bearer $CF_TOKEN"
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/alerting/v3/policies" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Bay Area mesh health check tunnel","alert_type":"tunnel_health_event",
       "enabled":true,"mechanisms":{"email":[{"id":"cloudflare@<your-domain>"}]},
       "filters":{"tunnel_id":["<TUNNEL_ID>"]}}'
```

- **The `tunnel_id` filter matters.** Without it the policy alerts on every tunnel on the account. `available_alerts` reports the filter keys this alert type accepts: `tunnel_id` and `new_status`.
- **Leaving `new_status` unset means you also hear about recovery**, which is what you want for something that flaps rather than dies. Add the filter if a chatty tunnel starts spamming you.
- **This needs a permission the tunnel token doesn't have.** The three rows in the section above are enough to build and run a tunnel but not to touch alerting; add **Account → Notifications → Edit**. The symptom is the usual useless `10000 Authentication error`, while `GET /user/tokens/verify` cheerfully reports the token "valid and active" — because it is, just not for that endpoint. A quick tell: `GET /accounts` returning an empty list means the token holds no account-scoped rights at all.
- Email destinations must be eligible before use — `GET /alerting/v3/destinations/eligible` should show `email: {eligible: true, ready: true}`. PagerDuty shows `eligible: false` until it is connected.

**Test it for real.** A test that doesn't take the tunnel down proves nothing. Stop the tunnel supervisor first (not just `cloudflared`, or the loop restarts it), then watch the API:

```bash
ps -eo pid,args | grep -E '[n]amed-tunnel.sh|[c]loudflared --config'   # kill these exact PIDs
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel/$TID" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r["status"],len(r["connections"]))'
```

Measured on 2026-08-29: supervisor and connector killed at **14:24:37Z**; the public hostname served `530` immediately; Cloudflare reported `status: down, connections: 0` at **14:24:48Z**, **11 seconds** later. Restarting the supervisor re-registered four connections by 14:25:00Z and the API read `healthy` again at 14:25:16Z. Total outage ≈ 30 s, and both the down and the recovery transition fire an email.

The 5-minute prober saw none of it — no incident was recorded. That is the point of running both layers: Cloudflare catches seconds, UptimeRobot catches the failures Cloudflare cannot see, such as the connector staying happily registered while the app behind it serves garbage.

One trap when testing from a sandbox: if the shell has an HTTPS credential proxy injected for some other host, `curl` to your own site through it can return `000` while the site is perfectly healthy. Re-check without the proxy before believing an outage.

**What is deliberately not monitored.** MQTT connectivity to `mqtt.gomesh.dev` — `/api/bootstrap` reports `mqtt.connected`, so a keyword monitor on `"connected":true` would alert on broker-side outages you cannot fix. Left out on purpose; add it if you want the visibility.
