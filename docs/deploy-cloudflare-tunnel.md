# Deploying Bay Area Mesh Health Check — self-hosted + Cloudflare Tunnel

Target: `https://healthcheck.bayareameshcore.org` served from your own box, no inbound ports open.

## Why not Vercel

Worth recording, because it will come up again. The app is a single long-lived Node process, and every one of these is load-bearing:

- A persistent MQTT subscription to `mqtt.gomesh.dev` that must stay connected and accumulate observer state between page views.
- An in-process WebSocket server (`new WebSocketServer({ noServer: true })`, `server.js:3052`) plus HTTP upgrade handling.
- In-memory `Map`s for `sessions`, `observerState`, `messageToSession`, `rateLimitBuckets`, `turnstileAuthTokens` (`server.js:716-721`) and a `setInterval` pruning them (`server.js:3147`).
- `fs.writeFileSync` into `./data`, mounted as a Docker volume.

Vercel functions cannot hold any of that. Instances are paused between requests and recycled, and the docs explicitly tell you to keep shared state in an external store rather than instance memory ([Vercel Services on Fluid compute](https://vercel.com/kb/guide/vercel-services-fluid-compute)). Execution is capped — 300 s on Hobby, 800 s max on Pro, 1800 s in extended beta ([function limits](https://vercel.com/docs/functions/limitations)). WebSockets do work now, but a socket is pinned to one instance and closes at the duration cap ([WebSockets on Vercel](https://vercel.com/docs/functions/websockets)). Running this on Vercel would mean splitting out a separate always-on MQTT→state service plus Redis/KV — a rewrite, not a config change. The repo already ships a `Dockerfile` and `docker-compose.yml`, so self-hosting takes it as-is.

## What you need

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

### Watchdog

The hourly URL-rotation watchdog was retired. Its replacement checks `https://healthcheck.sonomamesh.com/api/bootstrap` and `localhost:3090` every two hours, restarts the app or the tunnel supervisor if either is down, and only notifies when the public hostname cannot be returned to 200. It is explicitly forbidden from minting quick tunnels or rewriting `SITE_URL`.
