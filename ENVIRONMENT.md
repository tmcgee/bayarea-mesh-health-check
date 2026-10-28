# Environment Variables

Copy `.env.example` to `.env` and set only the values your deployment needs.
Runtime configuration should stay in `.env`; do not hardcode deployment values
in source files.

## App

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3090` | HTTP listen port inside the container. |
| `APP_TITLE` | `Mesh Health Check` | Main site title and metadata title. |
| `APP_EYEBROW` | `MeshCore Observer Coverage` | Small hero/dashboard label. |
| `APP_HEADLINE` | `Check your mesh reach.` | Hero headline on the dashboard. |
| `APP_DESCRIPTION` | Generated coverage description | Site description and social metadata. |
| `SITE_URL` | blank | Public site URL used for generated absolute share links and social metadata. Set it behind a reverse proxy that serves one hostname; leave it blank when several hostnames serve the app, so each one self-references via the request `Host` header. |
| `CORESCOPE_URL` | blank | Optional CoreScope root URL. When set, matched message hashes link to `#/packets/<hash>`. |
| `CARTO_BASEMAP_KEY` | blank | Public browser key for CARTO raster map tiles. Without it, the coverage map uses OpenStreetMap tiles in both themes while the dashboard keeps its dark theme. `CARTO_API_KEY` is accepted as a legacy alias. |
| `MAP_TILE_DARK_URL` | blank | Full tile-URL override for the dark basemap. Wins over `CARTO_BASEMAP_KEY`. |
| `MAP_TILE_LIGHT_URL` | blank | Full tile-URL override for the light basemap. Wins over `CARTO_BASEMAP_KEY`. |
| `EXTERNAL_LINK_URL` | blank | Optional HTTP(S) hero/control-center external link URL. Other URL schemes are rejected. |
| `EXTERNAL_LINK_LABEL` | blank | Label for the optional external link. |
| `LOG_LEVEL` | `info` | Use `debug` only while troubleshooting ingest or decode behavior. |
| `TRUST_PROXY` | `1` | Express proxy trust setting. Use `1` behind one trusted reverse proxy or `false` for direct access so client IP rate limits cannot be spoofed with forwarded headers. |
| `DISTANCE_UNIT` | `mi` | Distance labels for packet-path estimates. Use `mi` or `km`. |

As of August 2026, CARTO requires an API key for its raster basemaps. Keep the
project key in `.env`, not Git. CARTO's browser integration exposes the key in
tile request URLs, so scope it to this project and its deployment hostnames.

## Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `OBSERVERS_FILE` | `data/observer.json` | Persistent observer profile map with `name`, `lat`, and `lon`. |
| `OBSERVER_ACTIVITY_FILE` | `data/observer-activity.json` | Rolling observer packet history for dynamic default observer ranking. |
| `RESULTS_FILE` | `data/session-results.json` | Retained session result store for `/share/:sessionId` links. |
| `OBSERVER_RESEED_ENABLED` | `false` | Run the CoreScope seeding pass in-process, once a day. Removes the need for an external scheduler and for stopping the app to write `OBSERVERS_FILE`. |
| `OBSERVER_RESEED_HOUR` | `4` | Local-time hour after which the daily pass runs. Checked every ten minutes, once per calendar day, so a restart cannot make the day's pass skip. |
| `OBSERVER_RESEED_SCRIPT` | `seed-observers.py` | Script the refresh runs, resolved against the app directory. |
| `OBSERVER_RESEED_PYTHON` | `python3` | Interpreter used to run it. |
| `OBSERVER_RESEED_LOG` | `data/reseed-log.jsonl` | One JSON line per pass: counts, newly located and still-unlocated observers, hash-width moves, duration. |
| `OBSERVER_RESEED_TIMEOUT_MS` | `240000` | Hard timeout for the script. |
| `OBSERVER_RESEED_BOOT_DELAY_MS` | `60000` | Delay before the boot pass that fires when `REGIONS_FILE` or `UPLINK_CODES_FILE` no longer match the fingerprint recorded by the last successful pass. Ignores `OBSERVER_RESEED_HOUR`, needs `OBSERVER_RESEED_ENABLED`, and does not consume the day's scheduled run. |
| `ADMIN_TOKEN` | blank | When set, exposes `POST /api/admin/reseed` and `GET /api/admin/reseed`, authenticated with an `x-admin-token` header, so an outside scheduler can drive or inspect the refresh. Both routes 404 while it is blank. `GET /api/reseed-status` is always public and read-only: whether the last pass ran and succeeded, with counts and observer names but no paths or error text. |
| `SEED_BACKUPS_KEEP` | `14` | Backups of `OBSERVERS_FILE` the script keeps; older `.bak-*` files are pruned after each write. |

Keep these paths under the mounted `data/` directory if data should survive
container rebuilds.

## MQTT

| Variable | Default | Purpose |
| --- | --- | --- |
| `MQTT_HOST` | `mqtt.example.net` | MQTT broker hostname when `MQTT_URL` is not set. |
| `MQTT_PORT` | `443` | MQTT broker port. |
| `MQTT_USERNAME` | blank | Optional MQTT username. |
| `MQTT_PASSWORD` | blank | Optional MQTT password. |
| `MQTT_TOPIC` | `meshcore/SITE/#` | Topic filter the app subscribes to. |
| `MQTT_TRANSPORT` | `websockets` | Use `websockets` or a TCP transport. |
| `MQTT_WS_PATH` | `/` | WebSocket path for MQTT-over-WebSocket brokers. |
| `MQTT_TLS` | `true` | Enables TLS for MQTT connections. |
| `MQTT_CLIENT_ID` | blank | Optional fixed MQTT client ID. |
| `MQTT_URL` | blank | Optional full broker URL override, such as `wss://host.example:443/mqtt`. |
| `DASH_BROKER_HOST` | blank | UI-only public broker label. Does not affect the MQTT connection. |

## Channel

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHANNELS_FILE` | blank | Optional repo-local channel file. Leave blank to use the direct channel env vars. |
| `TEST_CHANNEL_NAME` | `test-channel` | Channel name users send the health-check code to. |
| `TEST_CHANNEL_SECRET` | blank | Channel secret used to decode the configured channel. |
| `TEST_CHANNEL_HASH` | blank | Optional explicit channel hash when secret-based hash calculation is not desired. |

The backend keeps packet handling scoped to the configured test channel.

## Sessions

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_TTL_SECONDS` | `600` | Active code lifetime. |
| `RESULT_RETENTION_SECONDS` | `604800` | How long retained share results stay available. |
| `MAX_USES_PER_CODE` | `3` | Maximum matching messages per generated code. |
| `SESSION_RATE_WINDOW_SECONDS` | `600` | Rate-limit window for creating sessions. |
| `SESSION_RATE_MAX` | `30` | Max session creations per rate-limit window. |

## Observers

| Variable | Default | Purpose |
| --- | --- | --- |
| `KNOWN_OBSERVERS` | blank | Comma-separated full observer pubkeys for a fixed default target set. |
| `OBSERVER_TOP_WINDOW_DAYS` | `7` | Lookback window for dynamic top-observer ranking. |
| `OBSERVER_TOP_COUNT` | `10` | Number of observers auto-selected when `KNOWN_OBSERVERS` is blank. |
| `OBSERVER_HASH_DISPLAY_BYTES` | `1` | UI hash prefix width: `1` = `AB`, `2` = `ABCD`, `3` = `ABCDEF`. |
| `OBSERVER_ACTIVE_WINDOW_SECONDS` | `900` | Active observer fallback window when no ranking history exists. |
| `OBSERVER_RETENTION_SECONDS` | `0` | Age cutoff for dashboard/map observers. Set `0` to disable pruning. |

`OBSERVER_HASH_DISPLAY_BYTES` only changes display labels. It does not restrict
which packets or path-hop sizes the app accepts.

Packet path distances are estimates based on observer coordinates and path-hop
hashes that can be matched back to known observers. Unknown or ambiguous hops
are skipped. If no hop-by-hop distance can be calculated, the longest packet
metric falls back to the farthest pair of receipt observers with coordinates.
When known observer anchors appear on both sides of unknown or no-coordinate
hops, the app still estimates that gap and marks it as estimated. Receipt cards
show path distance when available and fall back to observer-span distance when
only receipt observer coordinates are available.

## Regions

| Variable | Default | Purpose |
| --- | --- | --- |
| `REGIONS_FILE` | blank | GeoJSON FeatureCollection used to assign observer regions. |
| `REGION_NAME_PROPERTY` | `name` | Feature property used as the child region label. |
| `REGION_GROUP_PROPERTY` | `group` | Feature property used as the parent group label. |

Bundled examples include:

- `regions/us-states.geojson`
- `regions/us-places.geojson`
- `regions/uk.geojson`
- `regions/de-bundeslaender.geojson`

Leave `REGIONS_FILE` blank to disable region detection.

## MeshCore routing scopes

| Variable | Default | Purpose |
| --- | --- | --- |
| `MESHCORE_REGION_SCOPES_FILE` | blank | JSON file `{"regions": ["name", ...]}` of MeshCore region scope names to recognise in matched receipts. Resolved against the app directory. Blank turns name matching off; scoped receipts are still marked as scoped. A configured file that is missing or invalid stops startup. |

Each matched receipt records its transport code. A code that matches one listed
name shows that name, a code matching more than one shows `Ambiguous: a or b`,
an unlisted code shows `Scoped, name not listed`, and a flood or direct packet
shows `Unscoped`. Names follow the firmware rules: at most 30 bytes, no
duplicates, at most 1024 names, file at most 64 KiB. Written with or without the
leading `#`. The Bay Area file is `regions/us-ca-meshcore-scopes.json`, 73 names
copied from [matkam/meshcore-settings](https://github.com/matkam/meshcore-settings);
it is not part of the re-seed fingerprint.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MESHCORE_SCOPE_EVIDENCE_FILE` | `meshcore-scope-evidence.json` beside `OBSERVER_ACTIVITY_FILE` | Where per-repeater scope evidence is kept (7 days). Created on the first scoped or advert packet; an unreadable file is logged and ignored. |

Scope evidence needs no setting to run. It records each advertiser heard by an
in-area observer with the scope its own flood advert carried, and each path hop
of a scoped flood packet with the scopes it repeated. Names are matched with the
`MESHCORE_REGION_SCOPES_FILE` list; without one, scoped entries read `disabled`.
A code that matches no listed name is kept as `(unlisted)`. Read it at
`GET /api/meshcore-scope-evidence` (`?all=1` adds advertisers heard unscoped).

## Turnstile

| Variable | Default | Purpose |
| --- | --- | --- |
| `TURNSTILE_ENABLED` | `true` | Enables the Cloudflare Turnstile landing flow. |
| `TURNSTILE_SITE_KEY` | blank | Public Turnstile site key. |
| `TURNSTILE_SECRET_KEY` | blank | Secret Turnstile verification key. |
| `TURNSTILE_API_URL` | Cloudflare verify endpoint | Verification API endpoint. |
| `TURNSTILE_COOKIE_NAME` | `mesh_health_turnstile` | Signed access cookie name. |
| `TURNSTILE_TOKEN_TTL_SECONDS` | `86400` | Turnstile access lifetime. |
| `TURNSTILE_BOT_BYPASS` | `true` | Allows known link-preview bots to read public metadata. |
| `TURNSTILE_BOT_ALLOWLIST` | common social bots | Comma-separated lowercase user-agent fragments. |
| `TURNSTILE_VERIFY_RATE_WINDOW_SECONDS` | `600` | Rate-limit window for Turnstile verification. |
| `TURNSTILE_VERIFY_RATE_MAX` | `10` | Max verification attempts per rate-limit window. |

Turnstile is recommended for public deployments. Private/internal deployments
can disable it.
