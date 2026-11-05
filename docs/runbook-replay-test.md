# Runbook: replay test environment (local)

Status: planned, 2026-11-03. The files and npm scripts named below do not exist yet; this runbook is the specification they will be built to. Nothing here touches the live host, the droplet, or MQTT ingest code.

## 1. What it is

A self-contained copy of the app on your own computer, fed recorded mesh traffic instead of the live broker, with injected test messages so real health-check sessions run end to end: observers "hear" the message, receipts arrive, scores and regional scores come out. No radio, no internet needed after setup, no credits.

```
recording (.jsonl) ──► replay publisher ──► Mosquitto (localhost:1883) ──► app (localhost:3095) ──► browser / checks
                         + injected #healthcheck messages
```

What it covers: MQTT ingest and decoding, observer directory and region placement, out-of-area exclusion, session scoring and regional scoring, the location lookup, and the UI at real data volumes. What it does not cover: real radio propagation, the Cloudflare tunnel, Turnstile, and the live observer set as of today (only as of the recording).

## 2. Prerequisites

- Docker Desktop (Windows or macOS) or Docker Engine with the Compose plugin (Linux).
- Node.js 20 or later, for the record and check scripts. The app itself runs in Docker.
- A checkout of the repo (`git clone https://gitlab.com/tmcgee/bayarea-mesh-health-check.git`).
- Once, from the repo root: `npm ci`.

Recording needs internet and the shared read-only GoMesh broker account. Replaying needs neither.

## 3. Files (to be built)

| File | Purpose |
|---|---|
| `test/replay/docker-compose.replay.yml` | Two services: `mosquitto` (eclipse-mosquitto, 127.0.0.1:1883) and `app` (built from the repo `Dockerfile`, 127.0.0.1:3095) |
| `test/replay/mosquitto.conf` | Anonymous listener on 1883, no persistence |
| `test/replay/.env.replay` | App settings for replay (§4). Committed: it holds no secrets |
| `test/replay/data/` | Throwaway app data: `observer.json` seeded from the recording; session results. Git-ignored |
| `test/replay/recordings/` | Recorded traffic (`*.jsonl`) and its observer snapshot. Git-ignored |
| `scripts/replay-record.js` | Records the live broker to a recording (§5) |
| `scripts/replay-run.js` | Publishes a recording into Mosquitto at real or faster speed, and injects test messages (§6) |
| `scripts/replay-check.js` | Creates sessions, checks results over the API, takes screenshots, prints a summary (§7) |
| `package.json` | `replay:record`, `replay:up`, `replay:down`, `test:replay` |

## 4. App settings for replay

`test/replay/.env.replay` differs from `.env.bayarea.example` only where replay needs it:

```
PORT=3095
MQTT_URL=mqtt://mosquitto:1883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_CLIENT_ID=bayarea-health-check-replay
MQTT_TOPIC=meshcore/#
OBSERVERS_FILE=data/observer.json
OBSERVER_ACTIVITY_FILE=data/observer-activity.json
CORESCOPE_URL=
OBSERVER_RESEED_ENABLED=false
TURNSTILE_ENABLED=false
ADMIN_TOKEN=
REGIONS_FILE=regions/us-ca-bay-area.geojson
UPLINK_CODES_FILE=regions/us-ca-uplink-codes.json
MESHCORE_REGION_SCOPES_FILE=regions/us-ca-meshcore-scopes.json
TEST_CHANNEL_NAME=healthcheck
```

Notes:

- No broker credentials: the local broker is anonymous and bound to 127.0.0.1.
- No CoreScope and no reseed: the observer directory comes from the snapshot taken with the recording, so the reseed rule never comes up. `ADMIN_TOKEN` empty disables the admin endpoint.
- Turnstile off, so the check script can create sessions.
- Region files are the repo's own, so a replay tests exactly what would ship. For 1.2.0, the same recording runs against both the old and new region inputs to compare placements.

## 5. Record traffic (occasionally, needs internet)

```
npm run replay:record -- --minutes 10 --name 2026-11-03
```

- Connects read-only to `mqtt.gomesh.dev` with the shared account (credentials from your local `.env`, never typed on the command line, never committed). Never publishes.
- Writes `test/replay/recordings/2026-11-03.jsonl`: one line per message, `{t, topic, payload}` with `t` in milliseconds from the start.
- Also saves `2026-11-03.observers.json`, a copy of the public observer directory at that moment (from the app's own data if you run one, else built from the recording's status messages), used to seed `observer.json`.
- Ten minutes is typically a few thousand messages from about 35 observers on 15 codes; a recording is a few MB.

Re-record when the observer set changes noticeably, or keep a dated set to compare against.

## 6. Start the environment

```
npm run replay:up -- --recording 2026-11-03
```

This:

1. Copies the recording's observer snapshot to `test/replay/data/observer.json`.
2. Runs `docker compose -f test/replay/docker-compose.replay.yml up -d --build`.
3. Waits for `http://127.0.0.1:3095/api/bootstrap` to answer.
4. Starts `replay-run.js`, which publishes the recording into Mosquitto at real speed (`--speed 4` for four times faster) and loops it until stopped.

Open `http://127.0.0.1:3095` to use the dashboard by hand. Leave it running as long as you like; it uses no network.

### Sending a test message by hand

On the dashboard press New Code, then:

```
npm run replay:send -- --code ABC123 --observers 12 --spread 30
```

`replay-run.js` builds a #healthcheck channel message containing the code, encrypted with the channel key derived from the channel name (as the app does), and publishes it as heard by 12 observers from the recording, spread over 30 seconds, with plausible repeater paths and signal values. Options: `--observers all|N|key,key`, `--region "North Bay"` (only observers placed there), `--hops 1-4`.

## 7. Automated run

```
npm run test:replay -- --recording 2026-11-03 --speed 4
```

Starts the environment as in §6, then `replay-check.js`:

1. Creates sessions through `POST /api/sessions` and injects their messages with chosen patterns:
   - heard everywhere,
   - heard only in one region (score 100% there, low for All),
   - heard by fewer than 3 observers in a region (small-sample state),
   - heard by nobody in a region (no active observers).
2. Reads `GET /api/sessions/<id>` and checks counts, the overall score and every regional score against what was injected.
3. Checks that out-of-area observers (uplink codes in `outOfArea`, positions outside the boundary) never appear in the directory or any score.
4. Checks `/api/region-locator` and that location picks for known points land in the expected subregion.
5. Takes screenshots at 390 px and 1280 px wide (dashboard, a shared result, a regional selection) into `test/replay/output/`.
6. Prints a summary, one line per check, and exits non-zero on any failure.
7. Stops everything (§8).

A run takes a few minutes at `--speed 4`.

## 8. Stop

```
npm run replay:down
```

Stops the publisher by the process ID it recorded in `test/replay/data/replay.pid` (never by name), then `docker compose -f test/replay/docker-compose.replay.yml down`. Add `-- --clean` to delete `test/replay/data/` for a fresh start.

## 9. Running it in the sandbox or CI

The same `npm run test:replay` runs unattended:

- In the agent's sandbox, with Docker not available, it starts Mosquitto-compatible `aedes` in-process and the app with `node server.js` instead of the two containers; same settings, same checks. The agent reports the summary and screenshots, never a public URL.
- In GitLab CI, as a job alongside the existing ones, using a small committed recording (if approved; see §11).

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| `replay:up` waits forever | `docker compose -f test/replay/docker-compose.replay.yml logs app`; port 3095 or 1883 already in use |
| Dashboard shows no observers | Recording empty or wrong name; `observer.json` not copied; publisher not running (`replay.pid`) |
| Sessions never get receipts | Channel name in `.env.replay` must match the one the publisher encrypts with; check the app log for decode errors |
| Observers missing a region | Expected for coordinate-less observers on unclassified codes; listed with no region, as live |
| Times look wrong | Replay rewrites message timestamps to now; an old recording replayed without that would age every observer out |

## 11. Decisions still open

1. Recordings contain public broker traffic (observer keys, packet bytes). Keep them out of git (default), or commit one small, trimmed recording so CI can run the replay?
2. `aedes` (a Node MQTT broker) as a dev dependency, so the sandbox and CI need no Docker?
3. Port 3095 for the replay app, to stay clear of a local copy on 3090?

## 12. Rules this keeps

Read-only broker account, never publishing to it; no credentials sent to the live host and no `.env` committed; nothing deployed and no public URL; no reseed; processes stopped by exact PID; MQTT ingest, broker resubscribe, the observer directory code and droplet config unchanged.
