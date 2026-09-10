# Adapting meshcore-health-check for the Bay Area

## Short answer

Essentially **no code changes are required**. The app is fully config-driven: everything region-specific lives in `.env` plus one GeoJSON boundary file. The only literal Boston reference in the whole tree is a credit line in `README.md` ("The idea for this app came from Nick D from Boston"), and the only hardcoded map view is a neutral world default (`setView([20, 0], 2)`) that auto-fits to observer coordinates.

The real work is operational, not code: getting **subscribe access to the GoMesh broker** and standing up the **`#healthcheck` channel**. GoMesh is reachable at `wss://mqtt.gomesh.dev:443/mqtt` (not `mqtt://…:8883`), and with the supplied credentials it grants read on `meshcore/#` — verified live, with 34 observers publishing. The feed is no longer a blocker.

One code-level caveat found on review: if `MQTT_TOPIC` is left blank, `server.js` defaults to `meshcore/BOS/#` — Boston. Always set it explicitly.

---

## 1. MQTT feed — GoMesh (`mqtt.gomesh.dev`)

`mqtt.gomesh.dev` is the right host — but `mqtt://…:8883` will not work from outside. I tested it live on 2026-08-27.

### What actually answers

| Endpoint | Result |
|---|---|
| `wss://mqtt.gomesh.dev:443/mqtt` | **Works.** HTTP 101 Switching Protocols with `sec-websocket-protocol: mqtt`, and anonymous MQTT CONNECT returns **CONNACK rc=0** |
| `mqtt://mqtt.gomesh.dev:8883` | TLS handshake resets (`write:errno=104`), no peer certificate |
| `mqtt://mqtt.gomesh.dev:1883` | TCP accepts, then never answers an MQTT CONNECT |
| `https://mqtt.gomesh.dev/` | Cloudflare **520** — origin speaks MQTT, not HTTP, which is exactly what you'd expect |

The reason is Cloudflare. `mqtt.gomesh.dev` resolves to `172.67.165.169` / `104.21.11.80` with a valid Let's Encrypt cert for `*.gomesh.dev`, so the record is orange-clouded. Cloudflare proxies WebSockets on 443 but does **not** proxy 1883 or 8883, so those ports are black-holed at the edge no matter what the origin is listening on. The [gomesh.dev](https://www.gomesh.dev/) landing page does advertise `mqtt.gomesh.dev · 1883 / 8883` — but the site also says "standing up", and those ports are only reachable if you bypass Cloudflare (grey-clouded hostname, direct origin IP, or a tunnel).

So for this app:

```
MQTT_HOST=mqtt.gomesh.dev
MQTT_PORT=443
MQTT_TRANSPORT=websockets
MQTT_WS_PATH=/mqtt
MQTT_TLS=true
# or simply: MQTT_URL=wss://mqtt.gomesh.dev:443/mqtt
```

Any path works — `/mqtt`, `/`, `/ws`, and `/api/mqtt` all upgraded — so the origin isn't path-routing. Use `/mqtt` for convention.

### Credentials verified — read access works

Tested 2026-08-27 with the `example_user` account on `wss://mqtt.gomesh.dev:443/mqtt`:

```
CONNACK rc = 0
SUBACK #              granted=[128] DENIED
SUBACK meshcore/#     granted=[0]   OK
SUBACK MESHCORE/#     granted=[128] DENIED
SUBACK msh/#          granted=[128] DENIED
SUBACK gomesh/#       granted=[128] DENIED
SUBACK $SYS/#         granted=[128] DENIED
```

`meshcore/#` is granted; everything else is denied, including the bare `#` root and `$SYS`. So the ACL is scoped exactly to the observer tree — which is all this app needs. Anonymous clients get CONNACK 0 but no read grant, and a wrong password returns CONNACK **134**, so auth is genuinely enforced.

Because the grant covers the whole tree, there is no reason to enumerate cities:

```
MQTT_TOPIC=meshcore/#
```

**Never leave `MQTT_TOPIC` blank** — `server.js` falls back to `['meshcore/BOS/#']`, i.e. Boston. That is the one genuinely Boston-specific default in the code. Using `meshcore/#` also matches what Boston, MWMesh, and Chicago do (see appendix); the GeoJSON region filter, not the topic filter, is what makes the deployment regional.

### Live observer census

A 270-second capture on `meshcore/#` collected 2,400 messages from **34 distinct observers** across 12 IATA codes:

| IATA | Msgs | Observers | Locale | Sample observer names |
|---|---|---|---|---|
| SJC | 636 | 11 | San Jose / South Bay | K6WJG-OBS, Nullrouten, Rockymon Room Observer |
| STS | 337 | 3 | Santa Rosa / North Bay | KO6JOT Observer, armooo, bot-drycreek |
| OAK | 327 | 6 | Oakland / East Bay | 67 Repeater, BlorkoBot, lutin |
| PRB | 258 | 3 | Paso Robles | KB6CIO Tower Repeater, PL@W Williams Hill |
| MRY | 224 | 2 | Monterey | N6IJ Repeater, TREX-MRY Room Observer |
| SQL | 209 | 2 | San Carlos / Peninsula | Pilsner G3, SQL observer JBS |
| SFO | 204 | 2 | San Francisco | C0ffee SF, Sunol Ridge Repeater |
| MCE | 129 | 1 | Merced | VLK-OMG3-HB |
| COA | 61 | 1 | Columbia / Calaveras | SIERRA Dorrington Obs |
| MCO | 11 | 1 | Orlando FL — out of area | N4BUT G3 MQTT Observer |
| PHL | 3 | 1 | Philadelphia — out of area | SIKOP_RPTR_OBSVR |
| SBP | 1 | 1 | San Luis Obispo | MorroBay Rptr (Quintana) |

Leaf subtopics seen: `packets` (2,253), `raw` (114), `status` (33). No `internal` topic, and no channel-name field in any payload.

Three things this settles:

1. **The broker is live and busy**, not merely "standing up" as the landing page suggests. SJC alone has 11 observers.
2. **It is not Bay-Area-only.** MCO and PHL are East Coast, so the GeoJSON region filter is doing real work — those observers will simply show as unmatched rather than polluting a region.
3. **Four codes fell outside the original region file** — PRB and SBP (San Luis Obispo County), MCE (Merced), COA (Calaveras). The file has been extended from 16 to 28 counties (23 at the time; Kern, then Fresno, Madera, Kings and Tulare added 2026-09-10), adding San Luis Obispo to Central Coast, Merced to the Central Valley group (since split — see §3), and a new **Sierra Foothills** group (Amador, Calaveras, El Dorado, Placer, Tuolumne). Every in-state observer above now resolves to a named county; Reno and Orlando still correctly fall through.

### Envelope field mapping — GoMesh differs from LetsMesh

The upstream app reads signal telemetry as `envelope.rssi` and `envelope.snr`. GoMesh does not publish those names. Sampling 322 live messages on `meshcore/#` over 45 s gave this field census:

| Field | Messages | Notes |
|---|---|---|
| `timestamp`, `origin`, `origin_id` | 322 | on every message |
| `type`, `direction`, `packet_type`, `route`, `raw`, `len`, `payload_len` | 307 | packet messages |
| `hash` | 298 | maps to `messageHash` — already handled |
| **`SNR`**, **`RSSI`** | **298** | **uppercase, and quoted strings** (`"SNR":"-1.5"`, `"RSSI":"-85"`) |
| `score` | 248 | GoMesh's own composite quality figure, e.g. `"609"` — not consumed by the app |
| `duration` | 87 | lowercase, matches upstream |
| `path` | 6 | mostly absent; hops come from the decoded packet instead |
| `status`, `radio`, `model`, `firmware_version`, `client_version`, `stats` | 3 | observer metadata leaves |

Because `envelope.rssi` is `undefined` on this broker, every receipt stored `rssi: null` / `snr: null`, and the front end's `signalSummary()` — which needs at least one finite `rssi` or `snr` across the session's receipts — fell through to its `'--'` / "Awaiting telemetry." branch. Coverage, receipt spread, and latency were unaffected, since those don't depend on radio metrics.

Fix (`gomesh-telemetry.patch`): a case-insensitive `envelopeNumber(envelope, ...names)` lookup replaces the three direct reads, so lowercase LetsMesh and uppercase GoMesh envelopes both resolve. Two details matter:

- **Blank strings are rejected.** `Number('')` is `0`, so a naive numeric coercion would record an empty `RSSI` as a genuine 0 dBm — the strongest possible reading.
- **Repeat packets no longer overwrite good telemetry with `null`.** `recordReceipt()` unconditionally reassigned `existing.rssi`/`snr` on every subsequent packet from the same observer. GoMesh publishes each observer's own `direction: "tx"` rebroadcast without SNR/RSSI, so the second message routinely erased the first message's reading. Values are now only replaced when the incoming one is finite.

### Still worth asking the operator

1. **A dedicated account for this deployment** rather than reusing a shared one, so the credential can be rotated without breaking other tools.
2. Whether the `raw` and `status` leaves are stable — the app keys off `packets`, but observer names and coordinates come from metadata topics.
3. Native MQTT on 8883 is still black-holed by Cloudflare. Not a blocker, since wss/443 works, but worth knowing if you ever want a non-WebSocket client.

---

## 2. Test channel — `#healthcheck` (hashtag channel)

```
TEST_CHANNEL_NAME=healthcheck
TEST_CHANNEL_SECRET=3ae59c2cda86744c75e68b3975a902ae
TEST_CHANNEL_HASH=
```

Three things matter here, all verified against the code and a live run.

**The secret is still required, even though a hashtag channel has no private key.** A hashtag channel's key is derived from its name — the first 16 bytes of `sha256("#name")` ([MeshCore companion protocol docs](https://docs.meshcore.io/companion_protocol/), [RevSpace sensor-net writeup](https://revspace.nl/Meshcore-sensor-net)) — but this app does not do that derivation. `server.js` builds `decoderKeyCandidates` only from `TEST_CHANNEL_SECRET` (or a `CHANNELS_FILE` entry), and `tryDecodeGroupText()` returns `null` immediately when that list is empty. Leave the secret blank and the dashboard connects, subscribes, counts observers — and never matches a single test code, because it cannot decrypt GroupText. So the derived key has to be written into the config:

```python
hashlib.sha256(b"#healthcheck").digest()[:16].hex()  # 3ae59c2cda86744c75e68b3975a902ae
```

This is not a secret: anyone who knows the channel name can compute it, which is the whole point of hashtag channels. It is safe to commit. Cross-check that the derivation is right — the repo's own test fixtures use `E6D973AAC5101145AD3A3F3A0B3D52EB`, which is exactly `sha256("#health-check")[0:16]`, i.e. Boston's `#health-check` channel. Same method, different name.

**Write the name without the `#`.** `server.js` and `public/app.js` both render it as `` `#${TEST_CHANNEL_NAME}` `` (the session instruction string, the OG title fallback, the startup log, the Channel tile). `TEST_CHANNEL_NAME=#healthcheck` displays as `##healthcheck`. The `#` only belongs in the string being hashed.

**Leave `TEST_CHANNEL_HASH` blank.** It is derived as `sha256(key)[0]` = `02`, which is the byte the app matches against each incoming GroupText packet.

Verified on a live run against GoMesh:

```
[web] using broker mqtt.gomesh.dev and #healthcheck (02)
```

and the UI reads `Send MHC-XXXXXX to #healthcheck`, Channel `#healthcheck`, with 30-32 active observers.

**Gotcha found while testing: no inline comments in `.env`.** `parseEnvFileLoose()` in `server.js` takes everything after the first `=` as the value — it does not strip trailing `# ...`. A comment after `TEST_CHANNEL_HASH=` made the hash literally `"# derived automatically: 02"`, which silently breaks channel matching. Every comment in `.env.bayarea.example` is now on its own line.

Radio settings stay whatever the local mesh already uses — Bay Area MeshCore runs 910.525 MHz, SF7, 62.5 kHz BW, CR8 ([MeshCore Ninja network directory](https://meshcore.ninja/networks/)) — but the app doesn't care about RF config; it only reads MQTT.

Since `#healthcheck` is joinable by name alone, publishing is easy: tell people to use *Add Channel → Join a Hashtag Channel* and type `#healthcheck` ([WCMesh channel guide](https://wiki.wcmesh.com/meshcore-app/channels/)). Worth checking on Discord first that `#healthcheck` isn't already in use locally for something else — the keyspace is shared globally, so anyone anywhere typing that name is on the same channel ([discussion of hashtag-room keyspace](https://www.reddit.com/r/meshcore/comments/1puvqnf/hashtag_rooms_have_a_highly_limited_key_space_and/)).

---

## 3. Region filter — new boundary file

The bundled files are country-level (`us-states.geojson`) or 32,656 Census places (`us-places.geojson`), neither of which gives useful Bay Area grouping. I generated a purpose-built file for you:

**`regions/us-ca-bay-area.geojson`** — 30 counties, 498 KB, with `name` = county and `group` = subregion:

| Group | Counties | Live IATA codes seen |
|---|---|---|
| San Francisco | San Francisco | SFO |
| Peninsula | San Mateo | SQL |
| South Bay | Santa Clara | SJC |
| East Bay | Alameda, Contra Costa | OAK |
| North Bay | Marin, Napa, Solano, Sonoma | STS |
| Central Coast | Santa Cruz, San Benito, Monterey, San Luis Obispo | MRY, PRB, SBP |
| Sacramento Valley | Sacramento, Yolo | SMF, MHR |
| San Joaquin North | San Joaquin, Stanislaus, Merced | SCK, MOD, MCE |
| San Joaquin South | Kern, Fresno, Madera, Kings, Tulare | BFL, FAT, MAE, HJO, VIS |
| Sierra Foothills | Alpine, Amador, Calaveras, El Dorado, Mariposa, Placer, Tuolumne | COA |

The county list is not guesswork — it was fitted to the broker census in Section 1. The original 16-county draft left PRB, SBP, MCE, and COA observers unmatched, so San Luis Obispo and Merced were added and a Sierra Foothills group created. Kern was added later (2026-09-10): it was originally excluded as out of area, but CoreScope shows a live 16-node cluster there — Tehachapi (`TEH -` prefix), Frazier Park (`FP -`), and Bakersfield itself — all within reach of the network, so it is now in the boundary file and `BFL` moved from the exclusion list into `codes`. The single **Central Valley** group was split three ways on the same day. It had grown to six counties spanning about 300 miles, and it conflated the state's two distinct valleys: Sacramento and Yolo are in the Sacramento Valley, everything else in the group is San Joaquin Valley ([Central Valley](https://en.wikipedia.org/wiki/Central_Valley_(California))). The San Joaquin line follows standard usage — San Joaquin, Stanislaus and Merced are the [North San Joaquin Valley](https://www.labor.ca.gov/wp-content/uploads/sites/338/2024/11/North-San-Joaquin-Valley-RPP2.pdf), and Kern is the valley's south end ([Fresno State CRPC](https://socialsciences.fresnostate.edu/geography/crpc/scope.html)). `San Joaquin North` and `San Joaquin South` are named that way round so they sort adjacently: groups are ordered by `localeCompare` (`server.js:2577`, `2833`), nothing hardcodes an order, and no group name appears anywhere outside these two data files.

Adding Kern left a ~200 mile hole between Merced and Kern, so **Fresno, Madera, Kings and Tulare were added the same day** and the San Joaquin Valley is now complete at its standard eight counties. That was not a theoretical gap: point-testing CoreScope's 846 nodes against Census polygons for those four counties found 15 real nodes inside them — 7 in Fresno (including `KJA_RPT_Fresno_01`, `KJA_RPT_CLOVIS_2` and `K6US-Repeater`), 4 in Madera, 1 in Kings, 3 in Tulare, several heard within the hour. All 15 now resolve to `San Joaquin South`, which holds five counties rather than Kern alone. Madera sits in the south group with the other four; the north group stays at the three counties the standard definition gives it.

**Mariposa and Alpine were added on 2026-09-10** after point-testing all 692 located CoreScope nodes against every California county. Only six landed outside the boundary, and two of those were bad data — one node at longitude `+122.48` (western Pacific) and one coastal node in a polygon seam. The rest: `Bullion Repeater` and `Bullion Room (hello)` in Mariposa, heard by twelve observers between them including armooo, C0ffee SF and KO6JOT; `SIERRA Lake Alpine` in Alpine, part of the same Highway 4 SIERRA chain that already fills Calaveras. Mariposa is enclosed on three sides by Tuolumne, Merced and Madera, so it was a hole rather than an extension.

`MPI` (Mariposa-Yosemite) was added as an `anticipated` code for the unlocated case. Alpine County has no IATA airport, so it has no code — an unlocated Alpine observer falls through to unclassified, which is the correct outcome rather than a guess.

The seventh outside node, `Gravel Peak` in Santa Barbara County, was **declined** despite being the busiest excluded node on the broker (189 adverts, coverage 0.54, heard by five observers). Southern California runs MeshCore on a different frequency, so repeaters below the SLO line are noise on this network for now. It is left unclassified rather than added to `outOfArea`: no `SBA` code has ever appeared in the feed, and the exclusion list is for codes actually seen.

Before that, a Fresno observer would have hit the worst path in the system: `REQUIRE_REGION_MATCH` discards coordinates outside the boundary file, so it would have survived as unlocated, fallen through to the uplink-code table where `FAT` was unclassified, and ended up listed with no region, absent from the map, and still a scoring target that could never be reached. `FAT`, `MAE`, `HJO` and `VIS` were added as `anticipated` codes to close the unlocated case as well.

The split does not move the score: `regionCoverageFor` counts only groups holding a located observer in the scoring set, and the only Central Valley observers on the broker are three in Merced, all of which land in `San Joaquin North`. `Sacramento Valley` and `San Joaquin South` start empty, so they produce no chips and no coverage denominator until an observer appears in them.

The extra Central Coast / Central Valley reach also tracks where the network has been expanding — Santa Cruz, Monterey, Sonoma, Sacramento ([r/santacruz announcement](https://www.reddit.com/r/santacruz/comments/1toqpfz/open_source_emergency_offgrid_communications_for/), [Sonoma Mesh](https://sonomamesh.com/)). Drop features you don't want; unmatched observers degrade gracefully.

Enable it with:

```
REGIONS_FILE=regions/us-ca-bay-area.geojson
REGION_NAME_PROPERTY=name
REGION_GROUP_PROPERTY=group
```

Source geometry: legal county boundaries from the [Census TIGERweb State_County service](https://tigerweb.geo.census.gov/arcgisrest/) (`STATE='06'`, GeoJSON, EPSG:4326), reduced with Ramer–Douglas–Peucker at 0.0009° (~100 m) — 7,259 vertices, 287 KB. Rebuild with `build_bayarea_geojson.py`.

Two corrections to the paragraph above, both found on 2026-09-10 while adding Kern. The shipped file measures **20,260 vertices** across its 28 features, not 7,259. And `build_bayarea_geojson.py` is not in this repository, so Kern could not be produced by the documented pipeline: it was fetched from the same TIGERweb layer and reduced with a fresh RDP implementation at **0.0003° (~33 m)**, chosen because 0.0009° returned roughly half the vertex density of the existing counties (Monterey 578 against the shipped 1,431). Kern is landlocked, so the shoreline fidelity that motivated the TIGERweb switch does not apply to it; it lands at 120 vertices because its borders are largely straight lines. Fresno, Madera, Kings and Tulare came through the same 0.0003° path later that day — 1,770, 1,017, 162 and 587 vertices respectively, reduced from 9,733, 6,367, 2,334 and 3,365 raw. Their Sierra edges are genuinely convoluted, which is why they cost far more than Kern. Mariposa and Alpine came through the same 0.0003° path — 683 vertices from 3,996 raw, and 350 from 1,753. The file now measures 21,293 vertices across 30 features.

The first draft used the [plotly/datasets US counties GeoJSON](https://github.com/plotly/datasets) decimated to ~200 m, and that was a real bug: at ~70 vertices per county the shoreline is gone, so an Alameda island repeater at 37.7595, −122.2642 and a Monterey harbour node at 36.6175, −121.8804 both fell **outside their own counties** and lost their region. TIGERweb boundaries include the water portion of each county, so dock, island, and marina nodes now resolve. Re-verified: Treasure Island → San Francisco, Angel Island → Marin, Berkeley Marina → Alameda, Santa Cruz wharf → Santa Cruz, Half Moon Bay harbour → San Mateo, Sausalito → Marin; Fresno, Bakersfield, Reno, Orlando, and a point 60 km offshore all correctly return no region.

Two of those claims no longer hold. **Bakersfield and Fresno now resolve to San Joaquin South by design** (§3 above). And re-testing the shipped file on 2026-09-10 put the Monterey harbour point at 36.6175, −121.8804 and the tip of the Santa Cruz wharf at 36.9581, −122.0175 **outside** any county, while the wharf base at 36.9628, −122.0169 and Treasure Island, Berkeley Marina and the Alameda island node all resolve as described. So the over-water reach is shorter than this paragraph claims. Nobody has reported a node affected by it, and it was not investigated further.

Point-in-polygon verified against one real observer location per live IATA code: Twin Peaks → San Francisco, Oakland → Alameda/East Bay, San Jose → Santa Clara/South Bay, San Carlos → San Mateo/Peninsula, Santa Rosa → Sonoma/North Bay, Monterey → Monterey/Central Coast, Paso Robles and Morro Bay → San Luis Obispo/Central Coast, Merced → Merced/San Joaquin North, Dorrington → Calaveras/Sierra Foothills. Reno and Orlando correctly fall through as unmatched.

---

## 4. Branding, theme, and site config

```
APP_TITLE=Bay Area Mesh Health Check
APP_EYEBROW=Bay Area MeshCore Observer Coverage
APP_HEADLINE=Check your mesh reach across the Bay.
SITE_URL=https://healthcheck.bayareameshcore.org
EXTERNAL_LINK_URL=https://bayareameshcore.org/
EXTERNAL_LINK_LABEL=Bay Area MeshCore
CORESCOPE_URL=https://corescope.stonekitty.net
DASH_BROKER_HOST=mqtt.gomesh.dev
DISTANCE_UNIT=mi
```

`CORESCOPE_URL` makes matched packet hashes clickable through to [CoreScope](https://corescope.stonekitty.net); `DASH_BROKER_HOST` is a UI label only.

The same base drives two more link families on the observer cards, and CoreScope routes the two identities under different, **case-sensitive** paths for the same public key:

| Link | Route | Key case |
| --- | --- | --- |
| Packet hash | `#/packets/<hash>` | lowercase hash |
| Observer name on each card | `#/observers/<KEY>` | **uppercase** |
| Named repeater in the leg list and in the hop chips | `#/nodes/<key>` | **lowercase** |

`/api/observers/<lowercase>` and `/api/nodes/<UPPERCASE>` both answer `404`, so the casing is functional. A hop links only when its prefix resolved to exactly one node — an ambiguous or unknown prefix stays plain text rather than linking to a guess. Unset `CORESCOPE_URL` and every one of these renders as plain text.

Not every observer here exists in that CoreScope: the out-of-area MoKanMesh station feeds a different broker, so its link lands on an empty observer page.

### Colour scheme

[bayareameshcore.org](https://bayareameshcore.org/) is Astro + Bootstrap 5.3 with a light/dark toggle. Its palette, read from `/_astro/index.DchGtAFf.css`:

| Role | Site light | Site dark |
|---|---|---|
| Page background | `#f3f6fb` | `#0b1220` |
| Body text | `#1f2937` | `#d7e1ee` |
| Headings | `#0f172a` | `#f8fafc` |
| Card / panel | `#ffffff` | `#111c2f` |
| Hairline | `#dbe4f0` | `#22314d` |
| Primary / link | `#0d6efd` | `#58a6ff` |
| Strong link | `#1d4ed8` | — |
| Secondary accent | `#198754` | `#2dd4bf` |
| Muted text | — | `#9db0cd` |
| `theme-color` | `#f3f6fb` | `#0b1220` |

The health check keeps all of its colour in CSS custom properties on `:root` (dark) and `body[data-ui-theme="light"]`, so no component CSS has to change. Added **`public/theme-bayarea.css`**, which remaps both sets onto the palette above, plus the hero wash (the site's blue + teal radial gradients over `#0b1220`). One change to the markup: a `<link rel="stylesheet" href="/theme-bayarea.css">` after `styles.css` in `index.html`, `landing.html`, and `share.html`, the file added to `CORE_ASSETS` in `sw.js`, the SW cache name bumped to `mesh-health-check-pwa-v3-bayarea`, and `theme-color` changed from `#07111d` to `#0b1220`.

One deliberate difference: the stock status ramp used blue / amber / magenta. Magenta doesn't exist in the site palette, so *poor* is now red (`#f0708a` dark, `#c02a45` light) and *good* is the site blue. Verified in the browser in both modes; the faint small-caps labels visible in light mode are pre-existing stock behaviour, not caused by the retheme (confirmed by A/B screenshot with the theme sheet disabled).

### Icons

Worth flagging: **bayareameshcore.org has no brand icon to copy.** Its `favicon.svg` is still Astro's default logo, and its `og:image` (`/baymc_avatar.png`) is an unrelated stock image of two robot faces. Rather than import either, I recoloured the health check's own radiating-signal mark to the site surface — background `#1f2937` → `#0b1220`, glyph white → `#d7e1ee` — and wrote it to `public/logo.png` (stock original preserved as `public/logo-stock.png`). That one file feeds the favicon, the apple-touch icon, both PWA manifest icon sizes, and the OG/Twitter card image.

If the group ever commissions a real mark, replacing `public/logo.png` is the only change needed. The three `image1-3.png` screenshots have been regenerated from this deployment; `regen-readme-shots.py` reshoots them from an archived session, so they can be refreshed after any layout change.

### Basemap — CARTO now needs a free API key

The stock app hard-codes `https://{s}.basemaps.cartocdn.com/dark_all/...` in `public/app.js`. CARTO has since made raster basemaps key-gated: keyless tiles are still served, but each one is stamped diagonally with **"API KEY REQUIRED / carto.com/basemaps/apikey"** ([CARTO basemaps FAQ](https://docs.carto.com/faqs/carto-basemaps)). Confirmed in the browser against this deployment — the coverage map was covered in watermarks. The upstream Boston instance has the same problem.

The key is free, needs no CARTO account, and is emailed straight back; the form asks for an email, the domain, and a one-line project description ([request a key](https://carto.com/basemaps/apikey/)). Fair use is **5,000,000 tile requests per calendar month** aggregated across all of an account's keys, with CARTO and OpenStreetMap attribution required to stay visible ([basemap terms](https://carto.com/legal/basemap-terms/)). This deployment will not come close to that ceiling. Note also that CARTO says the raster PNG basemaps are being retired, so a move to their vector basemaps is a future task — the same key covers both.

Rather than paste a key into front-end source, the tile URLs are now server-side config:

- `server.js` reads `CARTO_API_KEY` (renamed to `CARTO_BASEMAP_KEY` in §6z, old name still accepted), `MAP_TILE_DARK_URL`, `MAP_TILE_LIGHT_URL` and publishes a `site.map` block in `/api/bootstrap` (`darkTileUrl`, `lightTileUrl`, per-theme attribution, `cartoKeyConfigured`).
- Default dark style is `rastertiles/dark_all` — visually identical to the legacy `dark_all` path, which is the older undocumented URL form.
- Light mode previously hit `tile.openstreetmap.org` directly. With a CARTO key present it now uses CARTO `light_all` instead, which both matches the dark styling and keeps the app off OSM's community tile servers. With no key it falls back to OSM, since a keyless OSM tile has no watermark.
- `public/app.js` builds the Leaflet layer from that config and rebuilds it if the config changes; the old hard-coded URLs remain as a fallback.
- Startup now warns when no key is set: `[web] no CARTO_API_KEY set - basemap tiles carry an "API KEY REQUIRED" watermark`. Superseded in §6z: the message names `CARTO_BASEMAP_KEY` and the map falls back to OpenStreetMap instead of fetching a watermarked tile.

Attribution is unchanged and still rendered by Leaflet, which the terms require — do not strip it, and do not try to mask the watermark instead of getting a key.

### Detail collapsed behind one toggle

The stock `/app` page is a long scroll: hero, session control, then a three-panel grid (coverage map, observer set, observer reports + session history). For a casual visitor the answer is in the hero — the rest is diagnostics. So the whole `dashboard-grid` section is now wrapped in a native `<details id="additional-info">` that starts closed, with a full-width bar reading **Show Additional Information**; opening it flips the label to **Hide Additional Information** and rotates the chevron.

Implementation notes:

- Native `<details>`/`<summary>` rather than a JS show/hide, so it works without JavaScript, is keyboard-operable, and gets browser find-in-page expansion for free. The default disclosure marker is suppressed and replaced with a CSS chevron.
- The bar uses `var(--panel)` and `var(--line)`, so it inherits the Bay Area palette in both modes; a small `body[data-ui-theme="light"]` override supplies the light border and text colour.
- **Leaflet cannot measure a hidden container.** Building the map inside a closed `<details>` gives it a zero-size viewport, which shows as a grey box or a single misplaced tile on expand. `syncAdditionalInfo()` in `public/app.js` listens for the `toggle` event and, on open, clears `state.map.boundsKey`, calls `invalidateSize(true)`, then re-renders — so the map lays out and refits the observer bounds. Verified: 16 tiles loaded, both markers placed, no console errors, correct in dark, light, and at 390 px wide.
- `aria-expanded` is kept in sync on the summary for screen readers.
- State is not persisted — every load starts collapsed, as specified.
- `public/share.html` was left alone. On a shared result link the coverage map is the thing the recipient was sent, so hiding it there would defeat the link.

No service-worker bump was needed: `sw.js` already treats navigations and `.css`/`.js` as network-first, so returning visitors get the new markup without a cache-name change.

**Narrow-screen ordering fix.** `.workspace` is a grid, and the `@media (max-width: 720px)` block hand-orders its children (`.hero-band` 0, `.command-grid` 1, `.glance-grid` 2, `.dashboard-grid` 3, `.site-footer` 4). Wrapping the dashboard in `<details>` moved the grid out of `.workspace`, so that `order: 3` stopped applying and the `<details>` fell back to the default `order: 0` — which put the collapsed section **above** Session Control on phones while it stayed below on desktop. Fixed by ordering the element that is actually the grid item:

```css
@media (max-width: 720px) {
  .additional-info { order: 3; }
}
```

The `.dashboard-grid { order: 3 }` rule stays for `share.html`, where the grid is still a direct child of `.workspace`. Verified at 390 px, 720 px, and 1440 px, collapsed and expanded: hero → at-a-glance → Session Control → Show Additional Information → footer, in that order at every width, with 8 map markers and no console errors.

**Revision: the coverage map came back out.** The map is the one panel you want without a click, so it now sits in its own always-visible section directly above the toggle; only the observer set and the reports/history ledger stay collapsed. Three coupled changes:

1. **`public/index.html`** — the `#coverage-map` article moved out of the `<details>` into `<section class="dashboard-grid map-section">` placed immediately before it. The grid remaining inside gained a second class, `additional-info__grid`.
2. **`public/styles.css`** — two rules appended at the *end* of the file:

```css
.map-section {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "map";
}

.additional-info__grid {
  grid-template-areas: "ledger observers";
}

@media (max-width: 1240px) {
  .additional-info__grid {
    grid-template-areas: "observers" "ledger";
  }
}
```

   The end-of-file placement is deliberate. `.dashboard-grid` is redefined at six points in the stylesheet, including inside `@media` blocks, and media queries add no specificity — so a single-class rule placed last wins at every breakpoint and one pair of rules covers all of them. Dropping the `map` area from the inner grid matters: leaving it would reserve an empty `minmax(0, 1.26fr)` column next to the observer panel.
3. **`public/app.js`** — `syncAdditionalInfo()` no longer clears `state.map.boundsKey` or calls `invalidateSize(true)`. That existed only because Leaflet cannot measure a `display: none` container; the map is never hidden now. The toggle still flips its label, updates `aria-expanded`, and schedules one `render()` for the panels that *were* hidden.

The narrow-screen ordering still works without a new rule: the map section carries `.dashboard-grid`, so it inherits `order: 3` — the same value as `.additional-info` — and a tie in `order` falls back to document order, which puts the map first.

Measured on the live instance at 1440 px and 390 px, collapsed and expanded: `details.contains(#coverage-map)` is `false`, the map renders 1400×560 px (374×320 px on mobile) with 22 markers and 18 loaded tiles, and the vertical order is Session Control (bottom 1073) → map (top 1089) → toggle (top 1785). The inner grid computes to `871.9px 512.1px` / `"ledger observers"` on desktop and a single `374px` column / `"observers" "ledger"` on mobile. No console errors.

One consequence worth knowing: at full width the map is a 2.5:1 box, and `fitBounds` has to satisfy both axes, so fitting the observer latitude span (≈36.0–38.6°N) leaves a lot of empty longitude — Nevada and the open Pacific. Making it fill horizontally would need a container roughly 1500 px tall. If the empty margin bothers you, the options are a capped, centred `max-width` on `.map-section` or moving the region chips up beside the map.

Patch: `map-always-visible.patch`.

---

## 5. Seeding observer coordinates from CoreScope

The app only learns a position two ways — from an `.../status` or `.../internal` MQTT payload, or from a decoded **Advert** packet. GoMesh `status` payloads carry no position at all (verified across 18 payloads: `status, timestamp, origin, origin_id, model, firmware_version, radio, client_version, repeat, stats{…}`), and adverts arrive from only 4–5 distinct origins in a 4-minute window. That is why the uplink observers were named but unlocated: **10 of 37 had coordinates**, so the coverage map opened with "0/2 mapped observers reached".

[CoreScope](https://corescope.stonekitty.net) already holds the position database, so seed from it:

```
GET https://corescope.stonekitty.net/api/nodes?limit=5000
→ { nodes: [ { public_key, name, lat, lon, role, last_seen, … } ], total: 799,
    counts: { repeaters: 597, companions: 140, rooms: 62 } }
```

Default `limit` is 50 — pass `limit` explicitly. `public_key` is lowercase 64-hex; `data/observer.json` is keyed **uppercase**.

`seed-observers.py` does the merge (dry run by default, `--write` to apply, and it backs the file up first):

| Step | Result |
|---|---|
| CoreScope nodes fetched | 799 |
| Have a usable non-zero fix | 654 |
| **Inside `us-ca-bay-area.geojson`** | **636** |
| Outside → discarded | 18 |
| New profiles written | 510 |
| Coordinates filled on existing profiles | 524 |
| Existing coordinates left untouched | 112 |
| Out-of-region coordinates purged | 19 |

Inside/outside is a real point-in-polygon test — bounding-box pre-filter, then ray casting with hole support, the same rule `server.js` uses in `deriveRegionInfo`. Kept nodes span 20 counties: Santa Clara 135, Alameda 71, Santa Cruz 70, San Mateo 63, San Francisco 49, Contra Costa 42, San Luis Obispo 39, Monterey 36, Sonoma 33, Marin 25, then Merced, Solano, Calaveras, San Benito, Napa, Sacramento, San Joaquin, Placer, Tuolumne, Stanislaus.

The discarded set is not noise — GoMesh relays a whole **Orlando, Florida** cluster (`OARC/OCARES Room`, `Eola - FLDISMESH`, `W4ORL G2 Repeater`, `K4AIB Repeater 1/2`, `KO4KVV Room Server`, …), a **Philadelphia** repeater (`SIKOP_RPTR_OBSVR`, 40.0804, −75.3574), and one bad fix at `lat = 0` with a valid longitude. Those 19 coordinates were stripped from `data/observer.json`; the observers stay listed, they just no longer drag the map bounds across the continent.

A purge alone wouldn't hold, because the next Florida advert re-teaches the app the same position. So the filter is enforced in code too (`region-gate.patch`):

```
REQUIRE_REGION_MATCH=true
```

With it set, `updateObserverLocation()` drops any fix that matches no region boundary — which also disposes of the `lat = 0` bad fix, since the null-island equator is in no Bay Area county. Default is `false`, so upstream behaviour is untouched for other deployments; `npm test` is 41/41 with the flag off. Running the suite with this `.env` loaded fails 9 tests on purpose, because the fixtures are Boston coordinates and hop positions at 1°N / 0–3°E: unset `REQUIRE_REGION_MATCH`, `REGIONS_FILE`, and `SITE_URL` when testing.

After seeding and restart, measured live on `/api/bootstrap`:

| | Before | After |
|---|---|---|
| Located uplink observers | 10 / 37 | **21 / 33** |
| Counties represented | 4 | **12** |
| Groups represented | 3 | **8 of 8** |
| Markers on the map (top-10 target) | 0 | **8 / 10** |
| Out-of-area pins | 2 | **0** |

Seeding is safe to re-run and safe to over-seed: a profile only appears in the observer directory once that key actually publishes packets (`observerIsRetained` requires a `lastPacketAt`), so the 510 extra profiles are invisible until the node uplinks — at which point it shows up already positioned and already assigned to a county and group. Existing coordinates are never overwritten, since advert-derived positions are the node's own claim. Re-run it monthly, or after any big regional build-out.

---

## 6. Coverage map scope — `MAP_OBSERVER_SCOPE`

Upstream, the coverage map plots the *scoring target*, not the network. `public/app.js` reads `document.body.dataset.mapObserverScope` and falls back to `'expected'` — and no template in `public/` ever set that attribute, so the fallback was permanent. With `OBSERVER_TOP_COUNT=10` the map therefore drew at most 10 candidates, then filtered to those with usable coordinates: **8**. That is why a run reporting "30 of 30 observers reached" sat above a map captioned "8 of 8 mapped observers reached" while the Observer Set panel's *All regions* chip said 22.

The three numbers came from three different populations:

| Figure | Source | Population |
|---|---|---|
| 30 of 30 | `Math.max(1, expected.length, seen.length)` | everyone who actually reported, so the denominator inflates to match and the percentage is guaranteed 100% whenever more than `OBSERVER_TOP_COUNT` observers hear you |
| 8 of 8 mapped | `mapKnownObservers()` under scope `'expected'` | the 10-node target, minus those without coordinates |
| 22 in All regions | `buildRegionHierarchy(directory)` | every directory entry whose coordinates fall inside a region polygon |

Fix (`map-observer-scope.patch`): a new `MAP_OBSERVER_SCOPE` env var, defaulting to the upstream `'expected'`, is substituted into the `<body>` tag of `public/index.html` as `data-map-observer-scope`, which is exactly the attribute `app.js` was already looking for. Set it to `directory` and the map plots every located observer in the directory:

```
MAP_OBSERVER_SCOPE=directory
```

Verified live: markers went **8 → 22** and the caption now reads "0/22 mapped observers reached", matching the *All regions* chip. `npm test` stays at 43/43. `public/share.html` is deliberately left on `'expected'` — a share link is a snapshot of one run, and plotting it against the live directory would imply observers that were never in that session.

Note this does **not** touch the health percentage. The inflating denominator above was a separate change, resolved in §6e.

---

## 6b. Observer target set

Leave `KNOWN_OBSERVERS` blank for launch — with `OBSERVER_TARGET_MODE=active` (§6e) the app scores against every eligible observer active inside `OBSERVER_ACTIVE_WINDOW_SECONDS`, and `OBSERVER_TOP_WINDOW_DAYS`/`OBSERVER_TOP_COUNT` only rank the observer picker. Once you know which Bay Area hilltop/rooftop observers are genuinely always-on (Mt. Diablo, Twin Peaks, Mt. Tam, Sierra Azul-type sites), pin their full public keys so scores are comparable over time. Keep `OBSERVER_RETENTION_SECONDS=0` so pinned observers stay visible even when quiet.

---

## 6c. Uplink-code region fallback — `UPLINK_CODES_FILE` / `REGION_FALLBACK`

13 of 34 active observers publish no position at all, so nothing places them in a region and nothing counts them anywhere. They do, however, all publish under an IATA-style code: every GoMesh topic is

```
meshcore/<CODE>/<pubkey>/<stream>
```

`<CODE>` is the **uplink gateway's** metro, not the node's own location. That distinction is the whole design constraint — a node in Santa Cruz reaching the network through a San Jose gateway publishes under `SJC`. Upstream discards the segment entirely; `ingestMqttMessage()` only reads `parts[parts.length - 2]` (the pubkey) and `parts[parts.length - 1]` (the stream).

### How reliable is the code?

Measured over a 120 s census of the live broker: 34 distinct nodes across 13 codes, and **no node ever appeared under two different codes**. Cross-checking the 22 observers that *do* publish coordinates against the polygon they fall in, the code agreed with the boundary group for **18 of 22**:

| Code | Polygon group(s) observed | Verdict |
|---|---|---|
| `COA` ×2, `MCE` ×2, `MRY` ×2, `OAK` ×3, `PRB` ×2, `SQL` ×1, `STS` ×1 | one group each | agrees |
| `SFO` | San Francisco ×1, **East Bay** ×1 (Sunol Ridge, Alameda) | gateway ≠ node |
| `SJC` | South Bay ×4, **Central Coast** ×2 (AC3T Glen Arbor/Santa Cruz, Hollister/San Benito) | gateway ≠ node |

So the code is a good **group-level** hint and a bad county-level one. The implementation reflects that exactly.

### Two independent gates

`UPLINK_CODES_FILE` points at `regions/us-ca-uplink-codes.json`, which has two blocks:

- `codes` — in-area identifiers, each mapping to a region **group** that must exist in the boundary file (a code pointing at an unknown group is rejected at load with a warning, so it can never create a phantom chip). 36 entries: the 10 evidence-backed ones marked `"confidence": "observed"`, the rest `"anticipated"` — including `BFL`, which is only `anticipated` because no located observer publishing under it has been available to cross-check since it left the exclusion list.
- `outOfArea` — the **authoritative exclusion list**: `MCO` (the Orlando cluster `REQUIRE_REGION_MATCH` was added for), `PHL` (a single Philadelphia repeater), `MCI` (Kansas City, a MoKanMesh node relayed onto the broker). `BFL` was on this list until 2026-09-10 and is now an in-area code — see §3.

  A code in **neither** block is not excluded: its observers are listed with no region and the code is logged once. That is why `MCI` had to be added by hand after "MoKanMesh Eastwood Hill" appeared as an unheard, unlocated, region-less row that was still a scoring target. Inverting this default — absent means excluded — is an open design question, not current behaviour.

The two gates are deliberately separate:

| Setting | Effect |
|---|---|
| `UPLINK_CODES_FILE` set | Observers on an `outOfArea` code are removed from `observerDirectory()` outright — no directory entry, so no counts, no region chip, no map marker, no selection. **Unconditional**, regardless of `REGION_FALLBACK`. |
| `REGION_FALLBACK=uplink-code` | *Additionally*, an observer with no usable coordinates inherits the region **group** its code maps to. |

Neither file nor variable set → nothing is classified and behaviour is byte-identical to upstream.

A code in **neither** block stays unclassified: the observer remains listed with no region, and the code is logged once (`uplink code LAX is in neither codes nor outOfArea; region unresolved`). Silently dropping observers on an unrecognised code would lose data every time the network grows a metro; this way a new code surfaces in the log and gets classified deliberately.

### Inferred means read-only

`resolveObserverRegion()` puts coordinates first, always. Only when they yield no region does the code apply, and then it sets `regionGroup` but **never `region`**:

```js
function resolveObserverRegion(observer) {
  const fromCoordinates = deriveRegionInfo(observer?.lat ?? null, observer?.lon ?? null);
  if (fromCoordinates.region) {
    return { ...fromCoordinates, regionSource: 'coordinates' };
  }
  if (REGION_FALLBACK_UPLINK) {
    const info = uplinkCodes.get(normalizeUplinkCode(observer?.uplinkCode));
    if (info) {
      return { region: null, regionGroup: info.group, regionSource: 'uplink-code' };
    }
  }
  return { region: null, regionGroup: null, regionSource: null };
}
```

Because `region` stays null, an inferred observer contributes no county to the hierarchy and can never gain a map marker — the two things the code isn't accurate enough to justify. It is then read-only everywhere:

- excluded from `observerKeysForRegionSelection()`, so clicking a region chip never selects it
- excluded from `topObserverKeys()` and `activeObserverKeys()` via `observerIsScoringEligible()`, so it never enters the default target
- its allowlist checkbox is rendered `disabled`, with the detail line `South Bay via SJC · read-only · no map`

Explicit `KNOWN_OBSERVERS` entries stay authoritative — pinning a key still overrides all of this.

### What the UI shows

Group chips carry a second, dashed badge: `East Bay 4 +4` means four observers placed by coordinates and four more by uplink code. The counts stay honest — the `+N` is never folded into the mapped figure. `observerStats` also exposes `outOfAreaCount`, `inferredRegionCount`, and `regionFallback` so excluded observers don't vanish without a trace.

Live result after enabling both gates:

```
directory 34   located 22   inferred 13   out-of-area 3

Central Coast     6 +2      North Bay      1 +2      Sierra Foothills  2
Central Valley    2         Peninsula      1 +1      South Bay         5 +4
East Bay          4 +4      San Francisco  1
```

That output predates the 2026-09-10 Central Valley split; its two Central Valley observers are in Merced and now report as San Joaquin North.

All 13 previously region-less observers now sit in a group, all 13 render with a disabled checkbox, and the three out-of-area repeaters are gone from every count. Map markers stay at 22 — by design. `npm run check` clean; `npm test` **50/50** (43 baseline + 7 new tests in `test/uplink-code-region.test.js` covering inference, coordinate precedence, unconditional exclusion, unknown codes, hierarchy counts, target-set exclusion, and the fallback-off path).

One edge case worth knowing: a group whose members are *all* inferred still gets a chip (`count=0 +N`), but selecting it targets nothing, since inferred observers are read-only. That doesn't occur with the current network.

Patch: `uplink-code-region.patch`.

---

## 6d. Unmeasured is not zero — startup placeholders

On a cold load the health pocket read **POOR** in red with **0%**, and *Observers Reached* read **0 / 10**. Nothing was wrong with the mesh; nothing had been measured yet. The readout was reporting the absence of a result as a failing result.

The cause is that `healthLabel(percent)` in `server.js` is a pure function of the percentage, and a session with no receipts scores `Math.round((0 / denominator) * 100) = 0`, which falls through to `POOR`. The frontend's `healthClass()` then returned `status-poor` for anything that wasn't VERY HEALTHY / GOOD / FAIR, so the red was applied faithfully to a number that meant nothing.

The fix separates *not yet measured* from *measured badly*:

```js
// server.js
const healthMeasured = seen.length > 0 || Boolean(session.matchedAt);
```

`matchedAt` is the important half. A session that has never matched the test message has nothing to score. A session that *did* match but which nobody heard is a genuine 0% and still scores POOR in red — that is a real result and must stay alarming. The session payload gained a `healthMeasured` boolean, and `healthLabel(percent, measured)` returns `WAITING` when `measured` is false.

The frontend renders the pending state as `--` in the default text colour:

| Element | Measured | Pending |
|---|---|---|
| Current Health label | `session.healthLabel`, tone class | `Waiting`, no tone class |
| Ring figure | `85` + `%` | `--` (`.score-num--pending`) |
| Ring stroke | good / fair / poor | `--accent-strong` (unchanged behaviour) |
| Observers Reached | `4 / 10` | `--` |
| Repeaters | `2` | `--` |
| Session history row | `80%` · `GOOD` | `--` · `Waiting` |

`isHealthPending()` treats a missing label, `WAITING`, and `Waiting` alike, and the frontend falls back to the label when `healthMeasured` is absent, so a cached payload from an older server still renders the placeholder instead of a red zero. The static markup in **both** `public/index.html` and `public/share.html` was changed to `--` as well, since that is what paints before the first render pass — and remember those templates are read once at boot, so the server needs a restart after editing them.

`.score-num--pending` sets `color: var(--text)` and `letter-spacing: -0.12em`; at 1.7rem bold the two default-tracked hyphens read as two stray dashes rather than one placeholder.

Verified live at four points — first paint, no session, a freshly created session, and a reload restoring that session from `sessionStorage`. All four report label `Waiting`, class `''`, computed colour `rgb(215, 225, 238)` (the theme's `--text`, `#d7e1ee`), and `--` for the percentage, observers, and repeaters, with no console errors. `npm test` 51/51 with one new assertion in `test/api.test.js`.

Patch: `health-pending-placeholder.patch`.

---

## 6e. Scoring set — `OBSERVER_TARGET_MODE=active` and Regions Reached

`OBSERVER_TOP_COUNT=10` was inherited from Boston and had quietly become the wrong unit of measurement for this network. Two separate bugs and one design mismatch were stacked on top of each other.

**The denominator was not the target set.** `defaultObserverTarget()` builds a top-10 roster at session creation and stores it as `expectedObserverKeys` **whether or not the user picked observers** — `allowlistEnabled` only filters incoming reports, it does not narrow the denominator. So every default session was scored out of 10 regardless of how large the network actually was.

**And it could inflate.** The old line was:

```js
const denominator = Math.max(1, expected.length, seen.length);
```

That fails asymmetrically in both directions:

| Situation | Old result | Why |
|---|---|---|
| Only 6 of the 10-node roster are online | caps at **60%** | the roster is ranked over a 7-day window; a node that was busy last Tuesday and is dark today still occupies a slot |
| 31 observers hear you | exactly **100%** | `seen.length` becomes its own denominator, so the score is 100% by construction and cannot report anything else |

Both were confirmed against real retained sessions in `data/session-results.json`: `MHC-BDCA34` reported `31 / 31 = 100%`, and `MHC-899466` reported `1 / 10 = 10% POOR`.

**Is the default set of 10 even relevant?** Not as a denominator. Live eligible packet counts over the 7-day window, descending:

```
92, 81, 66, 60, 59, 54, 54, 50, 50, 46, 43, 38, 38, 38, 32, 31, 31, 30, 30, 29, 26, 0
```

There is no natural break anywhere in that list, and the top-10 boundary lands *inside a three-way tie at 38*. The tie is resolved by `lastPacketAt` and then by label sort, which means roster membership flips between sessions for reasons that have nothing to do with the mesh. `OBSERVER_TOP_COUNT` has a floor of 1 and no unlimited sentinel (`server.js` line 447), so it cannot simply be turned off.

### The fix

A new env var, defaulting to upstream behaviour so the patch is safe to send back to the Boston tree:

```
OBSERVER_TARGET_MODE=active
```

- **`top-window`** (default) — upstream: the busiest `OBSERVER_TOP_COUNT` observers over `OBSERVER_TOP_WINDOW_DAYS`.
- **`active`** — every scoring-eligible observer that reported inside `OBSERVER_ACTIVE_WINDOW_SECONDS`. That is the honest reachable audience: those radios were demonstrably listening minutes ago, so if they don't hear you it is a real miss.

The active set is **snapshotted onto the session at creation** (`activeObserverKeys`, persisted in `session-results.json` and restored on boot) so the denominator cannot drift while a code is open. Scoring then becomes:

```js
const activeAtStart = dedupe((session.activeObserverKeys || []).map(normalizeKey));
const scoringBaseline = OBSERVER_TARGET_MODE === 'active' && activeAtStart.length > 0
  ? activeAtStart
  : expected;
const scoringKeys = session.allowlistEnabled && expected.length > 0
  ? expected
  : dedupe([...scoringBaseline, ...seen]);
const denominator = Math.max(1, scoringKeys.length);
```

The union with `seen` is what removes the 100% pin: an observer that wakes up mid-session adds to the numerator **and** the denominator, so the score is bounded by 100 without a clamp and is never forced to it. `expectedObservers` in the payload now enumerates that same set, so the Score Against list and the score can no longer disagree — a property asserted directly in the tests as `expectedObservers.length === expectedCount`.

An explicit allowlist is still honoured verbatim. Top-N therefore survives as an **opt-in selection**, which is what it was always good for: it still ranks the observer picker and still pre-selects a curated set. It just no longer decides what your score is divided by.

Live effect on this deployment: `defaultObserverSource` moved from `top-window` to `active-window`, and the default scoring set from **10 to 21** — the eligible-and-active subset of 32 active directory entries (the other 11 are uplink-code-inferred or out-of-area and were never scoring-eligible).

### Regions Reached

The percentage answers "how many of the listening radios heard me". It does not say anything about *where*, and with observers clustered unevenly a high percentage can still mean the packet never left one valley. So the score grid gains a second headline metric next to Observers Reached:

```
Regions Reached    3 / 8
```

`regionCoverageFor(scoringKeys, seen)` groups the scoring set by `regionGroup` and reports `reached` (groups where at least one observer reported) over `total` (groups with at least one observer in the set). Two deliberate rules:

1. **Only `regionSource === 'coordinates'` counts.** An uplink-code-inferred group (§6c) is a plausible guess, not a position. Letting it tally would inflate reach with exactly the data the map itself refuses to plot.
2. **A group with no located observer is left out of the total, not counted as a miss.** There is no way to hear from it, so charging the sender for a hole in the observer network would be dishonest.

The card's `title` breaks the number down on hover — `Reached: East Bay (4/4), San Francisco (1/1)…` / `No report: Sierra Foothills (0/2)…` — and both the card and the tooltip clear to `--` under the same `healthMeasured` gate as the rest of the score (§6d), so a session that has heard nothing shows a placeholder rather than a misleading `0 / 8`.

The eight groups in play in one live session, recorded before the 2026-09-10 Central Valley split: Central Coast (6 observers), East Bay (4), South Bay (4), Central Valley (2), Sierra Foothills (2), North Bay (1), Peninsula (1), San Francisco (1). Note this spans far more than one RF domain — a local SF test that reaches 2 of 8 is not a failing grade, it is an accurate statement that the Bay Area mesh is not one contiguous coverage blanket. That is more useful than a single percentage precisely because it cannot be averaged away.

Seven cards in a two-column `.score-grid` would leave a half-width orphan, so the last card spans instead. The rule is written to be self-correcting rather than pinned to seven:

```css
.score-grid > .metric-card:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}
```

### Back-compatibility

Sessions retained from before this change have no `activeObserverKeys`, and there is no way to reconstruct who was listening at the time, so they fall back to the old top-N baseline unioned with `seen` and keep reporting their original percentage. Their **Regions Reached is recomputed** and is meaningful immediately: `MHC-BDCA34` reads `8 / 8`, and the single-receipt `MHC-899466` reads `1 / 5` — considerably more informative than the `10%` next to it.

`active-denominator.patch` covers `server.js`, `public/app.js`, `public/index.html`, `public/share.html`, `public/styles.css`, `.env.bayarea.example`, and both test files. Three tests were added and one pinned: the existing top-window bootstrap test now sets `OBSERVER_TARGET_MODE=top-window` explicitly so an `active` deployment cannot silently change what it asserts. `npm run check` clean, `npm test` **54/54**.

---

## 6f. Narrow targets are not graded — `OBSERVER_MIN_SCORING_SET`

Immediately after §6e went live a session came back reading **`1 / 1`, 100%, VERY HEALTHY** off a single receipt. That is a true statement about one observer and a worthless statement about network health.

### Root cause: the region filter was silently a target picker

`MHC-8E504C` was stored as:

```
allowlistEnabled:       true
expectedObserverKeys:   ['BB34780231E5BE…4A15FB']   ← exactly one
expectedObserverSource: 'selected observer'
activeObserverKeys:     21
```

That key is **KO6JOT Observer** (Sonoma / North Bay), the only observer with coordinates in that group. Clicking the North Bay chip ran `applyRegionSelection()`, which set `state.selectedObserverKeys = observerKeysForRegionSelection(...)` and called `scheduleSessionRetarget()` — no confirmation, no visible change to the "Default Set" badge. The next code was created with a one-key explicit allowlist, which scoring honours verbatim.

Five of the region groups are in this position, each with exactly one located observer: **Sonoma, San Francisco, San Mateo, Santa Cruz, San Luis Obispo**. The selection also persists in `sessionStorage` via `loadSelectedObserverKeys()`, so a chip clicked once kept narrowing subsequent codes across page loads.

This predates §6e — the old `Math.max(1, expected.length, seen.length)` with `expected` and `seen` both one key also evaluated to 1. What §6e changed was the size of the surprise: the default set went from 10 to 21, so falling into a one-observer target became far more conspicuous.

### Two independent fixes

**1. The region filter filters, and only that.** `applyRegionSelection()` is now a single `render()` call. `reconcileRegionSelection()` no longer writes `state.selectedObserverKeys`. `observerKeysForRegionSelection()` is replaced by `observersMatchingRegionFilter()`, which narrows the *rendered* observer list. Only an explicit checkbox creates an allowlist. When a filter is active the picker says so:

```
DEFAULT: 21 OBSERVERS ACTIVE IN THE LAST 15 MIN.
REGION FILTER SHOWING 3 OF 35 — FILTERING DOES NOT CHANGE THE TARGET.
```

Uplink-inferred observers have a `regionGroup` but no county, so they appear under a group chip and vanish under a county chip — which is exactly as much as their uplink code can justify.

**2. Below a floor, no grade is issued.**

```
OBSERVER_MIN_SCORING_SET=3
```

When `scoringKeys.length` is under this, the payload carries `healthRated: false` and `healthUnratedReason: 'target-too-small'`, and `healthLabel()` returns `NOT RATED`. The percentage is still computed and sent — a client that wants the raw number can have it — but the UI withholds it:

| Element | Rated | Not rated |
| --- | --- | --- |
| Score ring / `#health-percent` | `100%` | `--` |
| `#health-label` | `VERY HEALTHY` | `Not rated`, neutral colour |
| Observers Reached | `1 / 1` | `1 / 1` — still shown, it is honest |
| Regions Reached | `1 / 1` | `--` |
| `#health-note` | hidden | explains the withholding |

The note reads: *"Not rated: this code targeted 1 observer, below the 3 needed for a percentage to mean anything. The count above is still what was heard."*

Note the two gates are separate. `healthMeasured` means a message landed, so the counters have something to report. `healthRated` means the target set was large enough for a percentage to mean anything. `1 / 1` stays visible because the count is true; only the ratio derived from it is withheld. Set `OBSERVER_MIN_SCORING_SET=1` to restore upstream always-grade behaviour.

History rows and `/share/:id` inherit this through `historyHealthPending()` / `historyHealthLabel()`, which now consult `healthRated` first and fall back to the label for payloads from an older server.

### Verified against the reported session

Re-rendering `MHC-8E504C` through the patched server:

```
MHC-8E504C  1 / 1  label NOT RATED  measured true  rated false
            reason target-too-small  minScoringSet 3
```

and real multi-observer runs are untouched:

```
MHC-BDCA34  31 / 31  100%  VERY HEALTHY  rated true  regions 8 / 8
MHC-899466   1 / 10   10%  POOR          rated true  regions 1 / 5
MHC-394B45   0 / 6     0%  WAITING       rated false (nothing heard yet)
```

Clicking North Bay on the live instance now leaves the badge on **Default Set**, `#expected-source` on **ACTIVE SET**, the target at 21, the Clear button disabled, and the list narrowed to 3 rows.

`not-rated-scoring.patch` covers `server.js`, `public/app.js`, `public/index.html`, `public/share.html`, `public/styles.css`, `test/api.test.js`, and `.env.bayarea.example`. One test added — a one-key target that receives its receipt must report `expectedCount 1`, `observedCount 1`, `healthRated false`, `healthUnratedReason 'target-too-small'`, `healthLabel 'NOT RATED'`. `npm run check` clean, `npm test` **55/55**.

---

### 6g. The observer checkboxes are gone — `remove-observer-picker.patch`

§6f left the checkboxes in place but stripped their only remaining reason to exist. Auditing what they still did:

- In default mode **all 21 active observers rendered checked**, so the boxes doubled as a readout of the target. "This is in the target" and "I chose this" looked identical.
- Deviating from that minted a genuine allowlist, and **every single toggle created a new session code** — `scheduleSessionRetarget()` debounced 200 ms into `createSession()`. Live: `MHC-ED7689 / ACTIVE SET / 21 checked` → uncheck one → `MHC-853B9C / CUSTOM SET / Custom: 20 observers.` → Clear → `MHC-7354EF / ACTIVE SET`. Three codes for two clicks.
- A custom target was scored differently, and more harshly, than a default one. `server.js:2639` sets `scoringKeys = expected` with **no union against `seen`**, unlike the default path, so the denominator froze at creation. Worse, `server.js:2592` filters `reports` down to the allowlist, so a non-selected observer's receipt was discarded from the timeline, the coverage map, the Repeaters count, and Longest Packet — as far as the session was concerned it never happened.

Nothing about a health check wants that. The point of the tool is "who can hear the mesh right now," and hand-picking the answer set makes the number mean less, not more. So the whole picker came out.

**Removed from `public/app.js`:** `state.selectedObserverKeys`, `loadSelectedObserverKeys()` / `saveSelectedObserverKeys()` and the `sessionStorage` key, `usingDefaultObserverSet()`, `customSelectedObserverKeys()`, `effectiveObserverKeysForCreate()`, `targetPreviewSession()`, `sessionCanRetarget()`, `selectionDiffersFromSession()`, `sameKeys()`, `sessionTargetKeys()`, `scheduleSessionRetarget()`, `state.sessionRetargetTimer`, `ui.observerAllowlistClear`, and the change/click handlers.

**Removed from both templates** (`public/index.html`, `public/share.html`): the `<input type="checkbox">` in each observer row and the `Default Set` button.

**`public/styles.css`:** the `.observer-option input` and `.observer-option.read-only input` rules dropped, the row grid went from `20px minmax(0, 1fr)` to a single column, and `.observer-option.selected` was renamed **`.observer-option.targeted`** — "the next code will score this," not "you picked this."

The row is now read-only for everyone. Membership is stated in the detail line instead: `in target · known observer · mapped`, or `North Bay via STS · read-only · no map` for an uplink-inferred node. The `.targeted` accent tint was invisible under the light theme — it layered white over what was already white — so a `body[data-ui-theme="light"]` override now tints with the accent at 9% against `#ffffff`.

**The server-side allowlist API is deliberately kept.** `POST /api/sessions` still honours `expectedObserverKeys` and `allowlistEnabled`, and `explicitObserverAllowlist()` still resolves them; the tests exercise that path. Only the browser lost the ability to send one, which keeps the door open for a scripted regional check later without re-litigating the scoring code.

Verified live after restart — 0 checkboxes in the DOM, no `#observer-allowlist-clear`, 34 rows of which 21 carry `.targeted`, `#expected-source` on **ACTIVE SET**. Clicking North Bay narrows the list to 3 rows while the code stays `MHC-9F7CD6` and the note reads `Default: 21 observers active in the last 15 min. Region filter showing 3 of 34.` No console errors on `/app` or on a `/share/` page. `npm run check` clean, `npm test` **55/55** unchanged.

`remove-observer-picker.patch` covers `public/app.js`, `public/index.html`, `public/share.html`, and `public/styles.css` — frontend only, no server or test changes.

---

### 6h. Unlocated observers are scored — `infer-scoring.patch`

With the checkboxes gone the **Observers** list and the **Score Against** panel became two views of the same thing, and they disagreed: the list showed 34 rows, the target showed 21. The 13 missing rows were the uplink-inferred ones.

That gap was mine, and it was wrong. `observerIsScoringEligible()` excluded two unrelated categories in one expression:

```js
return !observerIsOutOfArea(observer) && !observerRegionIsInferred(observer);
```

The first clause is correct and stays — an out-of-area code is a deliberate exclusion. The second clause said "this observer publishes no coordinates, therefore its receipts don't count," and there is no defensible version of that. Scoring measures one thing: did the observer publish a receipt for the test message. Position has nothing to do with whether it can hear the channel. The exclusion made the health score partly a survey of **who happens to broadcast GPS**.

The cost was not theoretical. On the live instance all 13 inferred observers were active within the 15-minute window, and several were among the busiest nodes on the network — `Pilsner G3` 128 packets, `lutin🏡` 108, `SRV Mesh Recon 🔎` 105, `BerryRPT🫐` 93, `armooo` 69. **37% of the live mesh was being discarded from the denominator and from every receipt-derived panel.**

The clause originally existed because the checkboxes needed a category of row that could not be ticked. §6g deleted the checkboxes, so the only surviving effect was the scoring exclusion — vestigial, and invisible unless you compared the two panel counts.

**The change is one clause.** `observerIsScoringEligible()` now tests out-of-area only. What a missing position *does* govern was already enforced separately, and both guards are untouched:

- **The coverage map** plots `lat`/`lon`. An observer with no position gets no marker, before and after. Live marker count stayed at **22**.
- **Regions Reached** goes through `coordinateRegionGroupForKey()`, which requires `regionSource === 'coordinates'`. An uplink-inferred group cannot tally. This is the important one: an inferred group is the metro of the observer's *MQTT gateway*, not the observer, and 21 of 31 codes are still `"confidence": "anticipated"` — letting those count would inflate reach with a guess. Verified on a fresh 33-observer session: `expectedCount 33`, region denominator **8 groups covering 21 observers**, not 33.

So `Observers Reached` counts everyone who could report, and `Regions Reached` counts only where we can prove someone was. Those are different questions and they now have different denominators on purpose.

**Relabelling.** "Read-only" described a control that no longer exists, and it now actively misled — these rows are ordinary scoring targets. The row class `.observer-option.read-only` became **`.observer-option.unlocated`**, and its `opacity: 0.66` was dropped: dimming read as "excluded", which is precisely what these rows are not. The dashed border stays as the no-position marker. Target membership now leads every row's detail line, inferred or not, because it finally means the same thing on both:

```
in target · known observer · mapped                    (located)
in target · Central Coast via SBP · no coordinates     (inferred)
```

The `+N` chip tooltip was corrected the same way — from "no coordinates, read-only" to "scored like any other, but no coordinates so no map marker and no Regions Reached credit."

**Verified live** after restart: target **21 → 33**, all 12 then-active inferred observers present, `Score Against` rendering 33 badges that match the list one-for-one, `#expected-source` on ACTIVE SET, 0 elements still carrying the old `read-only` class, map markers unchanged at 22, no console errors.

**Tests.** `test/uplink-code-region.test.js` had a test named *"inferred observers stay out of the default scoring target"* that failed immediately — which is the correct outcome, since it pinned the behaviour being removed. It was replaced by two tests that pin the new split: one asserting an inferred observer **is** in the default target while still reporting `regionInferred true`, `hasLocation false`, `lat null`, `region null`; and one creating a session targeting only the inferred observer and asserting `regionCoverage.total === 0`. The harness gained a second `run()` argument exposing `baseUrl` and a `post()` helper so a test can drive a real session instead of only the bootstrap snapshot. `npm run check` clean, `npm test` **56/56**.

`infer-scoring.patch` covers `server.js`, `public/app.js`, `public/styles.css`, and `test/uplink-code-region.test.js`.

### 6i. One Observers panel — `merge-observer-panel.patch`

§6h made the two panels agree, which made them redundant. Two grids, same 34 members, differing only in that one carried the region chips and the detail lines and the other carried the seen/not-seen state. Reconciling them row by row was left to the reader for no gain.

They are now one panel. `renderObserverAllowlist()` and the old `renderExpectedObservers()` are both gone, replaced by a single `renderObservers(session)` that owns the chips, the filter, the details, and the state.

**Markup.** The panel keeps one header. `<p class="panel-label">Observer Set</p>`, the `Target` / `Score Against` header, `<div class="observer-selector" id="observer-allowlist">`, the `panel-divider`, and `<p id="expected-source">` are all removed from both `public/index.html` and `public/share.html`. What remains is: heading, summary sentence, region chips, badge grid.

**Naming.** The headings `Target`, `Active Set`, and `Score Against` all described a distinction that no longer exists — there is one set, and it is the observers. `sessionObserverSourceLabel()` existed only to feed `#expected-source` and is deleted. `defaultObserverTargetSummary()` is renamed `observerTargetSummary()` and drops the leading `Default: ` from all three branches, since there is no alternative set for it to be the default of.

**Every row states its own status,** so nothing is lost by collapsing the panels:

```
CONTRA COSTA, EAST BAY · MAPPED          NOT SEEN     (located, scored, no receipt yet)
SOUTH BAY VIA SJC · NO COORDINATES       NOT SEEN     (inferred group, still scored)
SANTA CLARA, SOUTH BAY · MAPPED          NOT SCORED   (in the directory, outside the active window)
```

The detail line reads county, group, position and — when relevant — `not recently heard`. Target membership moved out of the detail line and into the status chip, where it no longer duplicates itself.

**A third state was needed.** The old badge grid rendered only the target, so a directory observer that had gone quiet simply vanished. Dropping rows silently is the failure mode this whole exercise was about, so quiet observers stay listed as **`NOT SCORED`** on a `.observer-pill.untargeted` row: dashed, muted, neutral rather than red, with the tooltip *"Not heard inside the active window, so this code is not scored against it."* Scored rows sort first so the measured set reads as one block. The summary sentence counts the target (31) while the filter clause counts the list (`showing 8 of 34 listed`), which is why it says **listed**.

**Region chips filter this panel now,** which is what they always meant, and the empty-state copy still says plainly that the chips change what is listed and not what the code is scored against.

**A light-mode bug fell out of the merge.** `body[data-ui-theme="light"] .observer-pill` repaints every pill white, and the dark-theme state tints it overrides mix their colour into `transparent` before layering it over `rgba(255, 255, 255, 0.03)` — a no-op on a white card. So in light mode `seen`, `waiting`, and `untargeted` were indistinguishable. This is the same layering trap the `.targeted` row hit in §6g, and it mattered more here because this panel is now the only place observer state appears. Light-theme rules were added that mix into `#ffffff` explicitly, plus status colours, since light mode was also flattening `.status` to `var(--text)` for every pill.

**Dead CSS removed:** the `.observer-selector` scroll container and all of `.observer-option`, `.observer-option-copy`, `.observer-option.targeted`, `.stale`, `.unlocated`, and the light-theme `.targeted` override. Nothing in the tree references either class name any more.

**Verified live** in both themes: one `Observers` heading, `#observer-allowlist` and `#expected-source` absent, 34 rows carrying 34 detail lines — 31 scored, 3 `NOT SCORED`, 12 `unlocated` — the East Bay chip narrowing to 8 rows with the note reading `31 OBSERVERS ACTIVE IN THE LAST 15 MIN. REGION FILTER SHOWING 8 OF 34 LISTED.`, and no console errors on `/app` or `/share/`. `npm run check` clean, `npm test` **56/56**.

`merge-observer-panel.patch` covers `public/index.html`, `public/share.html`, `public/app.js`, and `public/styles.css`.

### 6j. Per-observer path hash width — `hash-width.patch`

Every observer rendered a **1-byte** prefix, because `OBSERVER_HASH_DISPLAY_BYTES=1` was a single global. That is wrong twice over: it is not what most Bay Area nodes actually transmit, and at one byte the directory had two genuine collisions.

| 1-byte prefix | collides |
|---|---|
| `69` | Livermorium 🔭 (`6969370D`) vs PL@W Williams Hill (`6942089F`) |
| `E4` | ALC_HM (`E4031318`) vs Sunol Ridge Repeater (`E4CBE914`) |

All four are confirmed 2-byte nodes, so showing each node its own width resolves both. Network-wide the problem is much larger: 254 of the 256 possible 1-byte prefixes are in use across the ~800 nodes CoreScope tracks, so a 1-byte label is close to meaningless as an identifier.

**What the width actually is.** The `path_len` byte is bit-packed — bits 0-5 are the hop count, bits 6-7 carry `hash_size − 1`, giving 1, 2, or 3 bytes per hop ([MeshCore packet format](https://docs.meshcore.io/packet_format/), [protocol spec](https://swaits.github.io/meshcore-spec/latest/03-path.html)). It is set per node with `set path.hash.mode {0|1|2}` on firmware v1.14.0+ ([CLI commands](https://docs.meshcore.io/cli_commands/), [mbug wiki](https://wiki.mbug.com.au/en/Meshcore/path-hashsizes-and-regions)).

**The trap, stated plainly:** `path.hash.mode` sizes only the packets a node *originates*. A 1.14+ repeater forwards all three widths regardless of its own setting ([MeshCore FAQ](https://docs.meshcore.io/faq/), [rflab.io on IDs and collisions](https://rflab.io/guides/meshcore-ids-and-collisions.html)). So a prefix observed inside somebody else's forwarded path is **not** evidence of that node's configuration. Only the node's own advert is.

**CoreScope already did this work.** `/api/nodes` carries `hash_size`, `hash_size_inconsistent`, `multi_byte_status` (`confirmed` / `suspected` / `unknown`), `multi_byte_evidence` (`advert` / `path`), and `multi_byte_max_hash_size`. Across 800 nodes: 394 `confirmed` from an advert, 398 `suspected` from a path only, 8 `unknown`, and `hash_size_inconsistent` false for all 800. Sniffing live MQTT is not a substitute — a 55-second window saw 618 packets of which 97.6% were 1-byte (companion-originated `TXT_MSG` dominates), and a ~3-minute window caught adverts from only **3** nodes. CoreScope has months of them, with `advert_count` up to 264.

**Rule adopted:** mirror each node's confirmed advert width; fall back to `OBSERVER_HASH_DISPLAY_BYTES` otherwise. `suspected`/`path` is deliberately **not** trusted.

**Seeding.** `seed-observers.py` gained a pass that writes `hashBytes` into each profile when `multi_byte_status == "confirmed"` **and** `multi_byte_evidence == "advert"` **and** `hash_size_inconsistent` is false. Two details matter:

- The width pass runs over **every** profile already in the store, not just the ones inside the GeoJSON, because a width is position-independent and 13 of our observers publish no position at all. It never *creates* a profile — doing so would drag all ~800 network nodes into `observer.json`.
- If CoreScope stops confirming a width, the field is **removed**, not left stale. The run reports newly recorded / changed / cleared counts.

On the store of 736 profiles this recorded 361 widths: 1 one-byte, 349 two-byte, 11 three-byte.

**Server.** `hashFromKeyPrefix(value, byteSize)` takes an optional width (clamped 1-3, falling back to the global). New `observerHashBytes(key)` and `observerHashBytesConfirmed(key)` read `profile.hashBytes`. `parseObserversJson` accepts `hashBytes` or `hash_size`, clamps to an integer 1-3 or null, and — importantly — **`writeObserverNamesFile` had to be widened too**, because it serializes the in-memory profile map back over `observer.json` through a field whitelist; without that change every learned width would be silently dropped on the next debounced write. `serializeObserver` now recomputes `hash` live instead of reading the cached `observer.hash`, so a width learned mid-run applies without a restart.

**Frontend.** `observerHashBytes(observer)` prefers `observer.hashBytes` and falls back to `observerStats.hashDisplayBytes`. The pill, list row, and map popups all consume the server's `hash`, so they widen automatically.

**The row now states the mode**, so a wider prefix never looks like an inconsistency:

```
C0ffee SF               C0FFEE   SAN FRANCISCO, SAN FRANCISCO · MAPPED · 3-BYTE PATH HASH
67 Repeater             6767     CONTRA COSTA, EAST BAY · MAPPED · 2-BYTE PATH HASH
armooo                  EA       NORTH BAY VIA STS · NO COORDINATES
```

It is only stated where the advert confirmed it — an observer with no confirmed width shows its 1-byte prefix and says nothing, rather than asserting a default as if it were measured.

**A wrapping bug fell out of this.** `.observer-detail` sets `overflow-wrap: anywhere; word-break: break-word` so that long county names fit a narrow card, and that happily split `2-BYTE PATH` after the hyphen — `· 2-` / `BYTE PATH`. My fault; the first version appended the width to the plain detail string, which left no way to exempt it. The width is now rendered as its own `<span class="observer-detail__mode">` with `white-space: nowrap; word-break: keep-all`. It is short and fixed-length, so it cannot overflow even at 390px. The rest of the detail line keeps the break-anywhere behaviour it needs.

**The label later became `2-byte path hash`** (was `2-byte path`). Two words were candidates and neither was right alone. The note only appears when the node's own advert confirmed the width, so it reports that node's `path.hash.mode` setting, not the route any message took — which argues against `path`. But `prefix` alone sits immediately after the truncated key on the same row and reads as an annotation on *that* string's display width rather than on a radio setting, and it drops the reason the width exists. `path hash` is upstream's own term: [the MeshCore FAQ](https://docs.meshcore.io/faq/) names `path.hash.mode 1` a 2-byte path hash, and the [path diagnostics post](https://blog.meshcore.io/2026/03/06/path-diagnostics-improvements) describes these hashes as "the pubkey prefixes" a v1.14+ repeater appends before forwarding — a prefix of the key, not a digest of the route. Matching upstream makes the card searchable against community documentation. The longer string cannot introduce a mid-token break, because the span was already `nowrap`; it just moves to the next line as a unit on a narrow card.

**Verified live** on a 35-row directory: 17 rows at 2 bytes, 2 at 3 bytes (C0ffee SF, Salusa Secundus), 16 unconfirmed at 1 byte; 19 rows stating a width; **zero duplicate displayed prefixes**, so both the `69` and `E4` collisions are gone. Confirmed intact — no mid-token break — in dark mode, light mode, and at 390px, with no console errors. `npm run check` clean, `npm test` **56/56**.

One honest caveat: this set moves. SIERRA Dorrington Obs was confirmed 2-byte on an earlier read and is `suspected`/`path` now, so it currently shows 1 byte. That is the rule behaving correctly — CoreScope has not seen a recent advert from it — and the nightly refresh will pick the width back up when one arrives. Five observers are `suspected` only and deliberately untrusted (Marsh-MQTT, SQL observer JBS, K6WJG-OBS, Nullrouten 📎, Pilsner G3, plus SIERRA Dorrington Obs); ten are not in CoreScope at all.

`hash-width.patch` covers `server.js`, `public/app.js`, `public/styles.css`, and `seed-observers.py`.

### 6k. Observer Reports — one card per observer — `observer-reports.patch`

Three separate problems in the same panel.

**Every observer was listed twice.** A `Timeline / Arrival order` sub-panel rendered a chip per observer, then the receipt cards below rendered the same observers again with full detail. On a real 31-observer run that is 62 rows for 31 facts, and the chip carried only three pieces of information the card did not already have: the arrival **order**, the **offset from the first receipt**, and a relative-position track.

Those three moved into the card, in a `.receipt-arrival` block sitting immediately above the Signal bar as you asked. The card head now reads `1ST OF 31` where it used to repeat the clock time, and the arrival block states `First receipt` or `+4.0 s after first` on the left with the absolute time on the right, over the same fill-and-dot track geometry the chips used. The aggregate the sub-panel's header used to own — `31 REPORTS ACROSS 6.5 S` — moved into the Observer Reports panel header as `#receipt-spread-note`, so nothing was lost.

Ordering is computed from `firstSeenAt` in a single pass before the render loop rather than trusting array order, and receipts with no timestamp fall through to `Time not recorded` instead of claiming a position they do not have.

Removed: `renderReceiptTimeline()` and its two call sites, the six dead `ui` handles, the `.timeline-block` markup in both `public/index.html` and `public/share.html`, and every `.timeline-*` CSS rule including the three light-theme overrides and the responsive collapse. The track styles were not deleted but renamed to `.receipt-arrival__track` / `__fill` / `__dot`, which is why the light theme still gets the correct `rgba(39, 98, 210, …)` treatment for free.

**Receipts were still showing 1-byte prefixes.** §6j fixed the observer directory but not the receipt cards, because they read a different field. `observerHash` is written onto the report at packet time (`server.js` line 3286), so it froze whatever width was current when the packet arrived — and a session reloaded from `data/session-results.json` can carry a value recorded before the width was ever learned. The fix is the same trick `serializeObserver` uses: `serializeSession` now recomputes it, so both `/app` and `/share/` are covered by one change.

```js
observerHash:
  hashFromKeyPrefix(report.observerKey, observerHashBytes(report.observerKey))
  || report.observerHash,
observerHashBytes: observerHashBytes(report.observerKey),
observerHashBytesConfirmed: observerHashBytesConfirmed(report.observerKey),
```

The two new fields are what the client-side `receiptHashPrefix()` fallback uses for a payload that predates the change. Note the path chips below are deliberately untouched — those are the hashes actually carried on air in that packet, not display labels.

**Distance legs were one run-on paragraph.** `pathDistanceSegments` was joined with a middle dot into a single escaped `<span>`, so an 8-hop estimate wrapped into a wall of text. Each leg is now its own `.receipt-distance__leg` — route on the left, distance right-aligned in the mono face — so the numbers read as a column. The route can wrap; the value cannot.

**Verified live** against a real archived 31-receipt session (`MHC-BDCA34`), in dark, light, and at 390px:

| check | result |
|---|---|
| receipt cards | 31, no `#receipt-timeline` anywhere on the page |
| prefix widths | 12 at 1 byte, 17 at 2 bytes, 2 at 3 bytes (`F19E7F` Salusa Secundus, `C0FFEE` C0ffee SF) |
| arrival block above the Signal bar | 31 of 31 |
| multi-leg distances | 31 of 31, longest 8 legs, every leg on its own line |
| horizontal overflow | 0 px on the 8-leg card |
| console errors | none |

`npm run check` clean, `npm test` **56/56**.

One layout bug I introduced and fixed before shipping: the arrival block was first laid out side-by-side with `flex: 1 1 240px` on the track, which in the narrow receipt column squeezed the copy so hard that `First receipt` and `9:51:05 AM` each broke onto two lines. It now stacks — copy row above, full-width track below — with `white-space: nowrap` on both labels.

`observer-reports.patch` covers `server.js`, `public/app.js`, `public/index.html`, `public/share.html`, and `public/styles.css`.

---

### 6l. Whole-system metrics moved below the fold — `layout-metrics.patch`

The page opened with five blocks of deployment-wide telemetry above the fold: a **Live Surface** blurb, a **Control Center / Health at a glance** panel carrying the MQTT pill and the **Observer Window**, and a four-card strip of **Transport**, **Node Count**, **Signal Quality**, and **Receipt Spread**. None of that describes the session a visitor came to run. They now live where they belong.

**Four of the five moved into `Show Additional Information`, at the very bottom.** A new full-width `#system-metrics` panel closes the collapsed section, holding the Control Center copy, the `#mqtt-pill`, the `#network-window` readout, the Live Surface note, and the Transport / Node Count / Signal Quality cards. It uses the same single-area trick `.map-section` already used —

```css
.metrics-section {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "metrics";
}
```

— so no existing `grid-template-areas` had to be rewritten. `share.html` has no `<details>` wrapper, so there the same panel is simply the last section before the footer; its labels stay page-specific (`Shared Control Center`, `Share Mode`, `Shared Surface`, `Mapped Nodes`).

**Receipt Spread moved into Observer Reports instead**, directly above `#receipts-empty` and the receipt list, because it is derived from those receipts rather than from the deployment. `#receipt-spread-note` — added to the panel header in §6k — is now redundant and was deleted along with the `renderReceipts` block that wrote it: `latencySummary()` already produces the identical sentence, and the card renders it as `+6.5 s` over `31 observers across 6.5 s`.

**The theme toggle deliberately did not move.** `#ui-theme-toggle`, `#install-app-button`, and `#external-link` are controls, not metrics; burying them inside a collapsed section would make the theme unreachable without expanding it, and would break the Playwright checks that click the toggle. They moved up into the brand row instead, hard right of the title.

Two knock-on layout fixes were needed:

- `.hero-stage` was a three-column grid (`1.18fr / 0.82fr / 0.28fr`) whose third column was already dead — `.hero-stage__action-rail` is not in the markup. With the Control Center panel gone it is now a single `minmax(0, 1fr)` column, and `.hero-stage__lead .dock-lede` went from `62ch` to `96ch` so the lede does not sit in a narrow strip beside two-thirds of empty row.
- The moved cards dropped `telemetry-strip__item`, which is what gave them the strip's square-cornered, border-right treatment. They render as ordinary rounded `.glance-card`s in a `repeat(auto-fit, minmax(220px, 1fr))` grid.

**One bug I introduced and had to fix.** Light mode never repainted a bare `.panel` — it only ever named `.marquee-panel`, `.spotlight-panel`, `.observer-panel`, and `.ledger-panel` individually. Every existing panel carries one of those, so nothing had exposed the gap; `#system-metrics` was the first bare `.panel` and rendered with the dark fill `rgba(15, 22, 34, 0.84)` under correct dark text, i.e. grey-on-grey and unreadable. Fixed at the root rather than by adding one more class to the allowlist:

```css
body[data-ui-theme="light"] .panel {
  background:
    linear-gradient(180deg, rgba(252, 253, 255, 0.92), rgba(245, 248, 253, 0.84));
  box-shadow: 0 18px 46px rgba(52, 80, 121, 0.1);
}
```

The named variants all carry `.panel` too and override it later in the file, so existing panels are untouched. The same trap applied to `.glance-card`, whose dark fill had only ever been masked by the strip's own light override; it now has its own light fill.

**Dead CSS removed.** The move retired `.telemetry-strip`, `.telemetry-strip__item`, `.hero-stage__brief`, `.control-center-head`, `.toolbar-copy`, `.toolbar-label`, and `.dock-status-stack` — 29 selector groups across the base rules, three media queries, and the light theme. `public/styles.css` goes from 3198 to 3061 lines net — 224 lines of dead rules removed against the new layout rules added. Mixed selector groups kept their live members; a guard refused the prune if any live selector group would have lost styling.

**Verified live** on `/app` and on archived session `MHC-BDCA34`, in dark and light, at 1440px and 390px — eight combinations, all passing: hero holds no Control Center, pulse, or glance card but still holds the theme toggle; `#system-metrics` is the last section inside `#additional-info` with all three cards reading real values (`Live`, `35 / 35`, `75%`); Receipt Spread sits inside `#observer-reports` above all 31 receipts reading `+6.5 s / 31 observers across 6.5 s`; no overflow inside any moved block; no console errors. `npm run check` clean, `npm test` **56/56**.

Residual horizontal page overflow of 36px at 1440px and 10px at 390px is **pre-existing and unrelated** — it comes from the decorative `.splash-scene` bleed, Leaflet tiles, and the off-canvas `#detail-drawer`, none of which this change touches.

**Unrelated bug spotted while verifying** — the hero lede printed the same clause twice. Root-caused and fixed in §6m below.

### 6m. Hero copy and a squeezed brand row — `hero-copy.patch`

Three fixes to the header, one of which was a bug I shipped in §6l.

**The headline** now reads `Check your mesh reach across the Bay Area.` — `APP_HEADLINE` in `.env` line 13 and in `.env.bayarea.example`.

**The duplicated sentence is fixed at the root.** `applyBranding()` splits `site.description` on the literal phrase `configured channel` and renders the resolved channel chip between the two halves ([public/app.js:1269](https://github.com/yellowcooln/meshcore-health-check/blob/main/public/app.js)). Our `APP_DESCRIPTION` never contained that phrase, so the split produced one part: the whole sentence became `#hero-description-prefix`, `suffix` came back empty, and the empty value hit a hardcoded fallback that printed `and watch observer coverage build in real time.` a second time. Both ends are corrected:

- The fallback is gone. `ui.heroDescriptionSuffix.textContent = (suffix || '').trimStart();` — a description with no marker now yields no suffix rather than prose that repeats whatever the prefix said.
- `APP_DESCRIPTION` carries the marker, so the chip lands inline where the channel is actually named instead of being stranded at the end of the line:

```
APP_DESCRIPTION=Generate a test code, send it to the configured channel and watch observer coverage build in real time from San Francisco to the North Bay, East Bay, and South Bay.
```

Rendered: `Generate a test code, send it to the ● #healthcheck and watch observer coverage build in real time from San Francisco to the North Bay, East Bay, and South Bay.` `.env.bayarea.example` gets a comment saying the phrase is load-bearing, since removing it silently reintroduces the bug.

**The title was squeezed into the left half of the row.** Two causes. `.brand-copy` is a flex item with no `flex-grow`, so once §6l made the lead panel full-width the title still claimed only its own content width; `text-wrap: balance` then split it into two short lines with most of the row empty to the right. It is now `flex: 1 1 clamp(260px, 100%, 520px)` with `text-wrap: pretty`, so the first line runs the full available width.

**A regression I introduced in §6l, and had not checked at phone width.** Moving the utility controls into the brand row needed `flex: 0 0 auto` to stop the brand copy squeezing them one-per-row — but at 390px that inverted the problem: the controls held their full width and crushed `.brand-copy` to about 90px, rendering the title one word per line and overlapping the eyebrow with the Light Mode button. The row can now reflow instead of one child always winning:

```css
.dock-brand { flex-wrap: wrap; }

@media (max-width: 720px) {
  .dock-brand .control-utility-actions {
    flex: 1 0 100%;
    justify-content: flex-start;
    margin-left: 0;
  }
}
```

Below 720px the controls take their own row, left-aligned under the title; above it they stay hard right. The `min-width: min(100%, 260px)` floor on the brand copy is what forces the wrap rather than letting it collapse again.

**Verified live** at 1440px in dark and light and at 390px: eyebrow on one line, title filling the width at 2 lines desktop / 3 lines mobile, controls on their own row on the phone with the theme toggle still reachable, and the lede reading once with the chip inline. `npm run check` clean, `npm test` **56/56**, the §6l layout audit still **ALL CHECKS PASSED** across all eight combinations.

### 6n. Header full width, controls on their own right-aligned row — `hero-fullwidth.patch`

§6m widened the title but left it sharing a flex row with the utility buttons, so it still stopped at 959 of 1398 available pixels and the buttons read as intermingled with the copy. The row-sharing was the problem itself: with both children on one line, either the buttons stacked one-per-row or they clipped the headline to the left half of the panel. There was no width at which both were right.

The controls now take their **own** full-width row, flush to the panel's right edge and above the eyebrow:

```css
.dock-brand .control-utility-actions {
  order: -1;
  flex: 1 0 100%;
  width: 100%;
  margin-left: 0;
  justify-content: flex-end;
}
```

`.brand-copy` reverts to a plain `flex: 1 1 auto` with no width floor, because nothing competes with it any more. The headline now measures **1270px on one line** at 1440px, up from 959px across two. Below 720px the same block keeps its own row but flips to `order: 0` and `justify-content: flex-start`, so on a phone the buttons sit under the title rather than above the eyebrow, which reads better in a narrow column.

**The pulsing dot before the channel name is gone.** `.dock-lede strong::before` painted a 0.62rem `var(--good)` circle with a glow and a 2.6s `pulse` animation, and `.dock-lede strong` was `display: inline-flex` with a `0.5rem` gap to seat it. That styling treated the channel as a live status indicator, but it is a word in a sentence — and `inline-flex` also stopped it wrapping with the surrounding text. Both the pseudo-element and the flex box are removed; the channel is now `display: inline` in the accent colour and mono face:

```css
.dock-lede strong {
  display: inline;
  color: var(--accent-strong);
  font-family: var(--font-mono);
}
```

The rule is scoped to `.dock-lede`, so the status dots elsewhere in the UI are untouched.

**Verified live** on `/app` and on the shared view of `MHC-BDCA34`, at 1440px in dark and light and at 390px. The share page carries five buttons in that row (`Light Mode`, `Install App`, `Bay Area MeshCore`, `Run Your Own Check`, `New Code`) and they wrap right-aligned without touching the title. `::before` on the channel computes to `none` on both pages. `npm run check` clean, `npm test` **56/56**, §6l layout audit **ALL CHECKS PASSED**.

### 6o. Utility controls as a compact right-hand stack — `hero-utility-stack.patch`

§6n put the controls on their own full-width row, which fixed the width of the headline but pushed the whole header down by a row — the buttons still consumed vertical space that belonged to the copy. They now sit as a narrow column pinned to the right edge and centred against the copy, so they take **no** vertical space of their own:

```css
.dock-brand .control-utility-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  flex: 0 0 auto;
  max-width: 172px;
  margin-left: auto;
  align-self: center;
}
```

Stacking rather than sitting in a row is what keeps them narrow enough for the headline to hold one line; being a side column rather than a row of its own is what stops them displacing anything. They are also smaller now — `padding: 5px 12px` and `font-size: 0.76rem` — since they are utilities beside the headline, not primary actions.

Two supporting changes were needed:

- `.hero-stage__lead .brand-copy` went from `flex: 1 1 auto` to **`flex: 1 1 0%`**. With basis `auto` the copy demanded its full content width, which forced the utility stack to wrap onto a line of its own regardless of what the stack's own rules said — that alone had grown the header from 246px to 296px.
- `.hero-stage__lead .brand-copy h1` went from `clamp(2.25rem, 4vw, 4.2rem)` to **`clamp(2.25rem, 3.5vw, 4.2rem)`** with `line-height: 0.98`. At 4vw this headline needed about 1180px but the column is 1117px once the stack takes its 172px, so it broke to a short second line. At 3.5vw it holds one line, and the longer share-page headline (`Observer coverage someone shared with you.`) fits too at 1102px.

Below 720px there is no room for a side column, so the block reverts to a wrapped row under the title with auto-width buttons.

**Net effect on the header block: 246px tall → 216px**, with the headline on a single line spanning 1117px of 1398px and the controls flush right. Verified live on `/app` and the shared view of `MHC-BDCA34`, at 1440px in dark and light and at 390px — on the share page all five controls stack right without touching the title. `npm run check` clean, `npm test` **56/56**, §6l layout audit **ALL CHECKS PASSED**.

One honest caveat: `3.5vw` is tuned so *this* headline holds one line at desktop widths. A materially longer `APP_HEADLINE` will wrap to two lines again — which degrades gracefully, but the number is copy-dependent rather than universal.

### 6p. Page width cap and top-aligned controls — `shell-width.patch`

**The header was not the thing spanning half the screen — the whole app was.** `.noc-shell` was `width: min(1480px, calc(100vw - 40px))`, centred, so every panel on the page sat inside a fixed 1480px column. On a 1440px laptop that reads as full width, which is why it never showed up in the earlier checks; on a 2560px monitor it is 58% of the screen and on a 3440px ultrawide it is 43%. The header only looked like the culprit because it is the widest single element in that column.

The cap is now `min(1860px, calc(100vw - 40px))`:

| Viewport | Shell before | Shell after |
| --- | --- | --- |
| 1440px | 1400px (97%) | 1400px (97%) |
| 1920px | 1480px (77%) | 1860px (97%) |
| 2560px | 1480px (58%) | 1860px (73%) |

This is a **page-wide** change, not a header one — Session Control, the coverage map, Observer Reports, and the metrics panel all widen with it. It is one number if you want it dialled differently; `1860px` keeps a comfortable margin at 1920px while stopping short of stretching body text across an ultrawide. The reading measures are unaffected because `.dock-lede` is still capped at `96ch` and `.metrics-panel__lede` at `72ch`.

**The utility stack now aligns with the top of the header content** rather than the middle of the row — `align-self: flex-start` in place of `align-self: center`, so the first button's top edge lines up with the eyebrow and the brand orb.

**Verified live** at 1920px and 1440px in dark and light and at 390px. At 1920px the shell measures 1860px with the hero panel spanning all of it and the headline holding one line at 1577px. `npm run check` clean, `npm test` **56/56**, §6l layout audit **ALL CHECKS PASSED**.

### 6q. The real cause of the half-width header — `hero-breakpoint.patch`

Your zoom observation is what found this, and it also shows §6p was treating a symptom. Browser zoom shrinks the CSS viewport, so at 100% zoom your laptop reports a **narrower** viewport than at 90% — the opposite direction from a `max-width` cap. A cap cannot make a layout worse as the viewport narrows. Something in a narrow-width media query had to be re-narrowing the header, and it was:

```css
@media (max-width: 1240px) {
  .hero-stage {
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  }
}
```

**This is my miss from §6l.** When the Control Center panel was removed the hero went from three children to one, and I rewrote the base `.hero-stage` rule to a single `minmax(0, 1fr)` column — but not this override. So from 721px to 1240px the hero was still a two-column grid with one child, and `.hero-stage__lead` landed in the `1.05fr` column: **52% of the shell**, exactly the half-width header you saw. Below 720px a separate rule already reset it to `1fr`, and above 1240px the base rule applied, which is why every check at 1440px and 390px passed while the entire middle of the range was broken.

The override is now `minmax(0, 1fr)`. I also removed three rules for elements that no longer exist in either page — `.hero-stage__action-rail` (two rules) and `.hero-band` / `.hero-actions-stack` — since they were the leftovers that made the stale override easy to miss.

**A width sweep now covers the whole range** instead of two spot checks. `.hero-stage__lead` width as a fraction of `.noc-shell`, measured live at 21 viewport widths from 390px to 2560px:

| Viewport | 390 | 720 | 860 | 1100 | 1200 | 1240 | 1320 | 1440 | 1920 | 2560 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lead / shell | 0.995 | 0.997 | 0.998 | 0.998 | 0.998 | 0.998 | 0.998 | 0.999 | 0.999 | 0.999 |

Every width is ≥ 0.995 — the header fills the shell everywhere. The residual fraction is the panel's own 1px border. The headline holds one line from 1100px up and wraps to two below that, which is correct behaviour rather than a squeeze.

**On §6p:** the 1480px → 1860px shell change stands on its own merits for a wide monitor, but it was not the cause of what you reported, and I should not have presented it as the fix without first testing the range between the two widths I had been checking. The sweep is now the check that would have caught it.

### 6r. Lede beside the buttons, Install App retired — `lede-inline.patch`

**The lede was a sibling of the brand row, not a child of the copy column.** `<p class="dock-lede lede">` sat directly under `.dock-brand`, so it started below everything in that row — including the utility button stack on the right — and began at the panel's left padding edge rather than under the headline. Moving it inside `.brand-copy`, immediately after the `<h1>`, puts it in the same flex column as the eyebrow and headline, so it slides up alongside the buttons and left-aligns with the headline instead of with the orb. Applied to both `public/index.html` and `public/share.html`.

Because the headline runs at `line-height: 0.98`, the lede lost the row spacing it used to inherit, so `.hero-stage__lead .dock-lede` gains `margin: 0.6rem 0 0`. The `96ch` measure cap is unchanged.

**Header height, dark mode at 1920px:** 216px → **191px**. The share page header came down from 209px to 191px on the same change.

**Install App is hidden, not deleted:**

```css
#install-app-button {
  display: none;
}
```

`app.js` still binds a click handler to that node at line 2216 and toggles it from a `beforeinstallprompt` listener at line 202, so removing the element from the markup would throw on load. An id selector also outranks the `.hidden` class that listener toggles, so the button stays hidden even when the browser offers an install prompt. The PWA manifest and service worker are untouched — reinstate the button by deleting this one rule.

**Watch out:** `server.js` line 955 reads `public/index.html` into `appHtmlTemplate` **once at boot**. HTML edits are not picked up by a reload — the app has to be restarted, the same trap as `data/observer.json`. CSS and `app.js` are served from disk and do reload. I lost a screenshot round to this before spotting it.

**Verified live** on `/app` and `/share/<uuid>` in dark and light at 1920px, 1440px and 390px, plus the 21-width sweep (all ratios ≥ 0.995, no regression from §6q). At 390px the buttons still wrap to a row underneath and the lede stays indented with the headline. `npm run check` clean, `npm test` **56/56**, layout audit **ALL CHECKS PASSED**.

### 6s. Lede spans the orb column — `lede-fullspan.patch`

§6r solved the vertical problem and created a horizontal one: putting the lede inside `.brand-copy` moved it up beside the buttons, but it inherited that column's left edge and so started indented past the logo instead of at the panel edge. A flex row can only give one or the other — the lede is either inside the copy column (indented) or on a line below the buttons (full width). It cannot start at the orb's left edge and stay in the top row.

**So the brand row is now a grid.** The lede goes back to being a direct child of `.dock-brand`, and placement is explicit:

```css
.hero-stage__lead .dock-brand {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  align-items: start;
  column-gap: 14px;
  row-gap: 0;
}
.hero-stage__lead .dock-brand > .brand-orb   { grid-area: 1 / 1; }
.hero-stage__lead .dock-brand > .brand-copy  { grid-area: 1 / 2; }
.hero-stage__lead .dock-brand > .dock-lede   { grid-column: 1 / 3; grid-row: 2; }
.hero-stage__lead .dock-brand > .control-utility-actions { grid-area: 1 / 3 / span 2 / auto; }
```

Column 1 is the orb, column 2 the eyebrow and headline, column 3 the utility stack. The lede spans **columns 1–2** on row 2, so it starts under the logo and runs to just short of the buttons; the stack spans both rows in column 3, so it stays top-aligned with the eyebrow. `row-gap: 0` because the lede's own `margin-top: 0.6rem` from §6r already provides the gap.

The rule is scoped to `.hero-stage__lead` — the bare `.dock-brand` flex rules and the `.dock-brand, .toolbar, .panel-header, …` shared group are untouched, so nothing else that borrows those classes changes.

**Phone override** (≤720px) drops to two columns and gives the stack its own row beneath the lede:

```css
.hero-stage__lead .dock-brand { grid-template-columns: auto minmax(0, 1fr); }
.hero-stage__lead .dock-brand > .control-utility-actions {
  grid-area: 3 / 1 / auto / -1;
  margin-top: 12px;
}
```

At 390px the lede now also spans under the orb rather than sitting indented, which is why the header got 13px shorter (321px → 308px) — one fewer wrapped line.

**Header heights, dark mode:** 191px at 1920px and 175px at 1440px, unchanged from §6r — this round moved the lede sideways, not down. **Remember the boot-time HTML template** (§6r): the app was restarted (pid 8772) to pick the markup up.

**Verified live** on `/app` and a shared result in dark and light at 1920px, 1440px and 390px, plus the 21-width sweep — all ratios ≥ 0.995, no regression from §6q. `npm run check` clean, `npm test` **56/56**, layout audit **ALL CHECKS PASSED**.

### 6t. Three-step instructions, channel QR, honest startup status — `three-step-qr.patch`

Three separate problems, one patch. **Run `npm install` after applying it** — it adds one runtime dependency.

#### The status said EXPIRED before anything had happened

`refreshTrackedSessions()` restores the code held in `sessionStorage` on load, and `renderSession()` printed `session.status.toUpperCase()` unconditionally. Come back a day later and the restored code is expired, so the first thing the page reported was **EXPIRED** — which reads as a fault when in fact nothing had been attempted yet.

An expired code that was never used carries no information, so it now shows `--`. An expired code that **did** run keeps its status, because there the word means something:

| Restored session | Status shown |
| --- | --- |
| expired, `useCount 0`, no `matchedAt` | `--` |
| expired, ran (`useCount 1`, `matchedAt` set) | `EXPIRED` |
| live, waiting for the message | `WAITING` |
| no session at all | `--` (was `Idle`) |

Verified against two real archived sessions on the live instance — `346ca710…` (MHC-3A1E0C, never used) renders `--`, `393ceef4…` (MHC-899466, `matchedAt 1787865162681`) still renders `EXPIRED`. The hardcoded `Waiting` in both HTML files is now `--` as well, so nothing stale flashes before the first paint.

#### Three numbered steps instead of one bare line

The single `<p id="session-instructions">` is now an `<ol class="session-steps__list">`:

1. `Step 1. Add the #healthcheck channel to your MeshCore companion.` — markup, with the channel name filled from `testChannel.name` at render time so it is not hardcoded to this deployment.
2. `Step 2. Send the code MHC-XXXXXX to the #healthcheck channel.` — from the server, replacing `Send ${session.code} to #${testChannelName}`.
3. `Step 3. Return here to see your results.` — markup.

On the **share page** these steps are wrong — the reader is looking at an archive, not running a test — so `renderSession()` substitutes `This is a saved result for code MHC-XXXXXX.` when `state.sharedSessionId` is set.

#### A channel QR that actually scans

The companion app imports a channel from `meshcore://channel/add?name=<url-encoded>&secret=<32 hex>`, per the [MeshCore QR code docs](https://docs.meshcore.io/qr_codes/) and the [MeshCore FAQ](https://github.com/meshcore-dev/MeshCore/blob/main/docs/faq.md). The name keeps its `#`, URL-encoded as `%23`.

The catch is the secret. A hashtag channel's key is not random — it is `sha256("#name")` truncated to 16 bytes — and you told me to leave `TEST_CHANNEL_SECRET` blank precisely because of that. So the server derives the same key the app would when the variable is empty, rather than emitting a QR with no secret:

```js
const testChannelInviteSecret = envTestChannelSecret
  || createHash('sha256').update(testChannelLabel).digest('hex').slice(0, 32);
```

Confirmed on this deployment: `sha256("#healthcheck")[:16] = 3ae59c2cda86744c75e68b3975a902ae`, byte-identical to the value currently in `.env`. Either way round the QR is the same.

Encoding uses **`qrcode-generator@2.0.4`**, chosen because it has **zero dependencies** — the widely used `qrcode` package pulls in a `yargs` tree for its CLI, which is a poor trade for one static image. The SVG is built **once at boot** (config cannot change at runtime) and served from `GET /channel-qr.svg` with a one-hour cache header. It carries its own white background rect, so it stays scannable on the dark theme; `.channel-qr` keeps that white plate in both themes deliberately, and `.channel-qr__note` hardcodes `#475569` rather than using `var(--muted)`, which would vanish against white in dark mode.

The QR is wrapped in an anchor pointing at the same `meshcore://` URI, so on a phone tapping it hands the channel straight to the app; the code is there for the desktop case. `testChannel` in `/api/bootstrap` gained `inviteUri` and `qrAvailable`, and the block hides itself if encoding ever fails.

**Verified by decoding, not by eye** — `verify-qr.py` rasterises the QR the browser renders at 4× and runs it back through OpenCV's detector:

```
expected URI : meshcore://channel/add?name=%23healthcheck&secret=3ae59c2cda86744c75e68b3975a902ae
decoded  URI : meshcore://channel/add?name=%23healthcheck&secret=3ae59c2cda86744c75e68b3975a902ae
anchor href  : meshcore://channel/add?name=%23healthcheck&secret=3ae59c2cda86744c75e68b3975a902ae
FAILURES: none
```

**Verified on a phone.** The open question was whether the companion app accepts a derived key for a hashtag channel it may prefer to derive itself. It does: the QR was scanned from a real handset and the channel was added, so the fallback path (*Add Channel → Join a Hashtag Channel* with `#healthcheck` typed in) is only a backstop. The ≤720px layout, which drops the plate under the steps at a rendered 116px CSS, was included in that test.

`npm run check` clean, `npm test` **56/56**, layout audit **ALL CHECKS PASSED**, 21-width sweep clean, and the app was restarted (pid 10124) for the HTML template.

### 6u. Steps first, Share where the sharing is explained — `three-steps-panel.patch`

Nine copy and layout changes to the session panel, plus one `.env` value. `.env` is not in the patch (it never is), so change `APP_DESCRIPTION` by hand:

```
APP_DESCRIPTION=Send a test code and watch your mesh coverage build in real time from all over the Bay Area.
```

`.env.bayarea.example` carries the same value and **is** in the patch.

#### The lede no longer has a slot for the channel chip

`applyBranding()` splits `APP_DESCRIPTION` on the literal phrase `configured channel` and drops a `<strong id="hero-channel">` chip into the gap. The new sentence does not contain that phrase, so the split produced no suffix and the chip was left trailing after a full stop — the lede rendered as *"…from all over the Bay Area."* then a bare **#healthcheck** on its own line.

Fixed by hiding the chip when there is no slot for it:

```js
const hasChannelSlot = suffixParts.length > 0;
if (ui.heroChannel) ui.heroChannel.hidden = !hasChannelSlot;
```

That alone did nothing, and the reason is the same trap that made me hide rather than delete the Install App button in §6r: `.dock-lede strong { display: inline }` outranks the `hidden` attribute's user-agent `display: none`. **My error — I set the attribute, shipped it, and only caught it because the screenshot still showed the chip.** The rule below is what actually hides it:

```css
.dock-lede strong[hidden] { display: none; }
```

The share page returns from `applyBranding()` before this line and keeps its chip, which it still needs.

#### Panel order and copy

| Was | Now |
| --- | --- |
| `Command Sequence` / `Session Control` | `Three Easy Steps!` (label removed) |
| steps below Active Code | steps and QR **first**, Active Code below |
| Step 1 ends at "MeshCore companion." | adds "You can use the QR code to add the channel." |
| Step 3 "Return here…" | "Return to this page to see your results." |
| Share sat with New Code / Copy | Share moved into a new `.session-share-invite` block that explains why you would use it |
| `Repeaters` | `Repeaters Found` (both pages) |
| Matched Message full width under both columns | bottom of the **second** column, inside `.health-pocket` |

The new invitation reads *"Want to show off your coverage or need some assistance troubleshooting? You can share your final results with someone."* with the Share button on its right at desktop widths, stacking beneath the text at ≤720px. The button keeps its `id="share-session"`, so the existing click binding is untouched.

Moving Matched Message into `.health-pocket` puts it directly under the Broker card — measured at 1440px it now starts at x=849 where the left column ends at x=800, so it is genuinely in the right-hand column rather than spanning both. On a phone the columns stack and it stays last, which is where it belongs. Its `border-top` was a hardcoded `rgba(255,255,255,0.06)` that all but vanished in light mode; it is now `var(--line)`.

Verified on the live instance in dark, light, and at 390px, plus the share page. `npm run check` clean, `npm test` **56/56**, layout audit **ALL CHECKS PASSED**, 21-width sweep clean, QR decode round-trip still clean.

#### The quick tunnel was revoked mid-session

While shooting these screenshots the public hostname stopped resolving. `/tmp/cf5.log` showed `Unauthorized: Tunnel not found` on every reconnect — Cloudflare had revoked the quick tunnel upstream, which is exactly the failure mode flagged in §7. The supervisor cannot recover from it because the hostname itself is gone, so I killed cloudflared, relaunched it, and got a new one:

```
https://properly-declined-manufacturers-queries.trycloudflare.com/app
```

`SITE_URL` was repointed and the app restarted so share links carry the right origin. **This will keep happening.** A named tunnel with a hostname you own is the fix, and it is still the open recommendation in §7.

### 6v. Panel rearrange — QR into the header, metrics into one table — `panel-rearrange.patch`

Seven changes, all markup and CSS. No server change, no restart needed for CSS but the HTML template is read at boot, so the app was restarted (pid 14311).

#### QR out of the step list

The QR was a side plate inside `.session-steps`, which made that block as tall as the plate and left dead space under Step 3. It is now a second child of the panel header inside a new `.command-panel__head` flex row, sitting immediately right of the heading, and shrunk from **116px to 84px** with the caption down to `0.56rem`. `.session-steps` loses its flex layout entirely — with nothing to sit beside, the list just takes the full width.

#### Where things went

| Element | Was | Now |
| --- | --- | --- |
| `#channel-qr` | side plate below the steps | in `.panel-header`, 84px |
| `#session-share-note` | loose paragraph under the code row | inside `.session-share-invite__copy`, directly under the invitation |
| New Code / Copy | 3-column button row beside Active Code | stacked, pinned right, `grid-template-columns: auto; justify-content: end` |
| Status, Message Hash | `.session-meta` block in the left column | first two cells of `.health-pocket__stats`, above Observers Reached |
| Matched Message | full-width footer under both columns | last cell of the same table, bottom right |
| `.metrics-panel__lede` filler | Control Center panel | deleted |
| `.hero-stage__pulse` (Live Surface + blue dot) | Control Center panel | deleted |

The stats table is now ten cells in two columns — Status, Message Hash / Observers Reached, Regions Reached / Sender, Repeaters Found / Longest Packet, Channel / Broker, Matched Message — so the message lands bottom right as asked. `.health-pocket .metric-card:nth-last-child(-n + 2)` still strips the bottom border from the final row, which now means Broker and Matched Message.

**One thing to check:** New Code and Copy are right-aligned to the **left column's** right edge (x=801 at 1440px), not the far right of the page where the header's utility buttons sit (x≈1345). The code row lives in the left column of a two-column layout, so matching the header's x would mean pulling those buttons out of the session column entirely. Say the word if that is what you meant.

`.session-meta` is now unused on both pages; its rules survive only inside shared selector groups, which is harmless. The dead `.message-preview`, `.hero-stage__pulse`, `.hero-stage__pulse-dot` and `.metrics-panel__lede` rules were pruned — 466 bytes of CSS gone.

#### Share page kept in step

The share page got the same treatment for consistency: Repeaters Found, Status and Message Hash in its stats table, Matched Message bottom right, Copy and Share stacked right. Its own filler copy — a `Shared Surface` pulse block with the same blue dot, and a "Review the retained session…" lede — was removed too, since leaving one page decorated and the other stripped would look like an oversight.

#### `verify-layout.py` needed updating

The audit asserted `pulseInMetrics` — that the Live Surface block had **moved into** the Control Center panel, which is what §6l was about. Deleting the block turned that into a guaranteed failure, so the check was inverted: `pulseAnywhere` must now be false on every page and width. That is a stronger assertion than the one it replaced.

`npm run check` clean, `npm test` **56/56**, layout audit **ALL CHECKS PASSED**, 21-width sweep clean. Verified in dark, light, 390px, and on the share page.

### 6w. QR back beside Step 1, right-aligned — `qr-realign.patch`

Four changes. §6v moved the QR into the panel header to reclaim the dead space under Step 3; that traded one awkward gap for another, since an 84px plate next to a 30px heading left the heading floating in the middle of a tall row.

- **Caption removed.** The `.channel-qr__note` span ("Scan to add the channel") is gone from the markup and its rule pruned from the CSS. Step 1 already says "You can use the QR code to add the channel", so the caption was repeating instruction copy at `0.56rem` where it read as clutter.
- **QR back into `.session-steps`**, after the `<ol>`. `.command-panel__head` is retired and `.session-steps` becomes `display: flex; align-items: flex-start; justify-content: space-between`, so the plate's top edge lands on Step 1's top edge and its right edge on the column's right edge. Measured at 1440px: QR top **269**, Step 1 top **269**; QR right **801**, New Code right **801**, Copy right **801**, Share right **801**. Four elements on one vertical line.
- **Plate padding** evened out to `6px` now that there is no caption to sit below the code. The code itself stays 84px and still decodes — `verify-qr.py` round-trip clean.
- **"Whole-system telemetry" → "System Telemetry"** on both `index.html` and `share.html`, plus the CSS comment that named it.
- **Invitation copy** now ends at "assistance": *Want to show off your coverage or need some assistance? You can share your final results with someone.*

The `≤720px` override still flips `.session-steps` to a column, so on mobile the QR drops below Step 3 rather than squeezing beside it. The panel is **88px shorter** at 1440px than it was in §6v.

`npm run check` clean, `npm test` **56/56**, layout audit **ALL CHECKS PASSED**, 21-width sweep clean, QR decode clean. Verified in dark, light, 390px, and on the share page.

### 6x. CI, and the `.env` leak it exposed

The suite passed 56 of 56 on a clean checkout of the same commit and failed 9 of 56 in the live working tree. No code differed between the two runs.

`server.js` reads `<APP_DIR>/.env` and fills in every variable that is not already in `process.env`:

```js
const localEnv = parseEnvFileLoose(localEnvPath);
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}
```

Each test file assigns the handful of variables it cares about, so the live Bay Area `.env` quietly supplied everything else. `SITE_URL=https://healthcheck.sonomamesh.com` rewrote the `og:url` and `og:image` tags that `api.test.js` asserts are derived from the request host, and `REGIONS_FILE`, `UPLINK_CODES_FILE` and `MAP_OBSERVER_SCOPE=directory` fed real boundaries and the 786-entry observer store into the path-distance and observer-metadata tests. Upstream CI never saw any of this, because CI has no `.env` — the bug was invisible precisely where it would have been caught.

The fix is a single opt-out honoured by the loader:

```js
const skipEnvFile = process.env.MESH_HEALTH_SKIP_ENV_FILE === 'true';
const localEnv = skipEnvFile ? {} : parseEnvFileLoose(localEnvPath);
```

`test/support/isolate-env.js` sets that flag and, belt-and-braces, deletes the keys a live `.env` would otherwise inject. It is imported first by all eight test files, so a bare `node --test` behaves the same as `npm test`; both Playwright `webServer` commands set the flag too.

Three smoke specs were asserting a UI that no longer exists — genuine drift from §6q and §6r, not flakes:

| Was | Now |
| --- | --- |
| `When each observer saw it` visible on load | panel sits inside the collapsed section, so the spec opens it and asserts the label flips to `Hide Additional Information` |
| `changing the observer selection...` unchecks a box and expects a new code | picker is gone; the spec asserts zero checkboxes, a read-only pill list, and that the code is **not** regenerated |
| `#receipt-timeline`, `#observer-allowlist` | `#receipts`, `#observer-targets` |

`.gitlab-ci.yml` mirrors `.github/workflows/ci.yml`, which stays in place for the GitHub upstream: `syntax` and `unit` run in parallel on `node:22-bookworm`, then `smoke` on `mcr.microsoft.com/playwright:v1.62.1-noble` pinned to the Playwright version in `package.json`, so no browser download step is needed. The unit job fails outright if a `.env` is ever present in CI, and emits a JUnit report via a new `npm run test:ci` so failures surface in the merge-request widget. Smoke is `allow_failure: true` — a flaky headless run should not block a docs-only commit.

First pipeline on GitLab shared runners: **success in 111 s**, syntax 35 s, unit 45 s, smoke 67 s, with GitLab's test report reading 56 total, 56 passed.

### 6y. One button coat, counter markers, and the veil over light mode — `step-markers.patch`

Six changes to the session panel, one of which turned out to be a rendering bug rather than a taste call.

**Buttons.** `New Code` was the only control wearing `.primary-button`; Share, Copy, the theme toggle, the external link and the drawer's Close all wore `.ghost-button`, a near-transparent 1px outline that read as decoration. Rather than reclassing eleven elements across two pages, `.ghost-button` now shares the `.primary-button` declaration blocks in both themes, and `.panel-lens` keeps the quiet paint on its own. The header utilities keep their smaller `5px 12px` padding from §6t on purpose — the paint matches, the footprint stays subordinate to a real action.

**Placeholders.** `Message Hash` and `Sender` rendered the word `Pending` while `Observers Reached`, `Regions Reached`, `Repeaters Found` and `Longest Packet` rendered `--`. All four now render `--`, including in the drawer. `Status` is the interesting one: it showed `WAITING`, which merely repeats the headline sitting directly above it, so the rule that suppressed a stale `EXPIRED` on arrival is now the general one — a status is shown once the code has actually been used, and reads `--` before that.

**Steps.** The numbering lived in the sentences as literal `Step 1.` / `Step 2.` / `Step 3.` text, with step 2's prefix baked into the `instructions` string the API returns. A CSS counter on `.session-steps__list` draws the markers instead, as a 1.6rem disc with `border-radius: 999px`, so the copy carries no numbering to keep in sync and the marker is a target the eye can land on. Each step gets `padding-left: 2.35rem` with the marker absolutely positioned in the gutter, which also gives wrapped lines a hanging indent.

The green is a theme token, not a literal: `--step-ink` is `#4ade80` on the dark palette and `#146c43` — the site's own success green, darkened for contrast — on the light one, over a `--step-fill` tinted from `#198754`.

**Emphasis.** The channel in step 1 was already `<strong>`; the code in step 2 was not, because that sentence is assigned with `textContent`. `renderInstruction()` escapes the sentence and the code separately, then wraps the code in `<strong>` — both halves are escaped before anything reaches `innerHTML`, since the sentence comes from the server and the code from the session.

**Copy.** "You can share your final results" → "Share your final results."

**And the actual reason light mode looked washed out.** The muted greys were a suspect but not the culprit. `.panel::before` draws the panel's gloss as an absolutely positioned pseudo-element with `inset: 0` and no `z-index`, and a positioned pseudo-element paints *after* its parent's in-flow text. In dark mode that overlay is `rgba(255, 255, 255, 0.045)` and invisible; the stock light theme sets it to `rgba(255, 255, 255, 0.6)`, so every word inside every panel was sitting under a 60% white scrim. The Bay Area light palette now overrides `--panel-overlay` to a hairline — the panel is already near-white, so the sheen had nothing to add.

The tokens were also a step too pale on their own and were darkened alongside it: `--muted` `#5b6b82` → `#44515f`, which lifts labels and notes from 5.4:1 to 8.1:1 on white. One specificity bug surfaced while checking: `body[data-ui-theme="light"] .hash-link` (0,2,1) outranks `.hash-link.pending` (0,2,0), so an unfilled hash rendered in link blue while every other placeholder was ink.

A new smoke test guards the lot: three counter markers with `border-radius: 999px`, no `Step N` left in any step's text, the channel and the code both emphasised, the three fields at `--`, and one shared paint across the four controls.

### 6aa. The CoreScope refresh moved inside the app

The daily seeding pass was the last piece of this deployment that cost money to keep running, and none of that spend bought judgement. The work is a fetch, a diff, a file write and a health check. The only reason it needed an agent was that the write happened *outside* the Node process that owns the profile store, so the process had to be stopped or it would clobber the file — which meant a supervisor kill, a child kill, a write, a restart and a re-verification of both the local port and the public hostname, with roughly 30 s of downtime every morning.

Running the pass in-process removes the reason, not just the symptom.

**Script, made portable and machine-readable.** `seed-observers.py` had four absolute sandbox paths baked in, which made it unusable on any other host. They now default to the repo the script sits in and honour the app's own variable names, so `server.js` can spawn it with its own environment and a relocated deployment needs no edits:

```python
CORESCOPE = (os.environ.get("CORESCOPE_URL", ...) or "https://corescope.stonekitty.net") + "/api/nodes?limit=5000"
GEOJSON   = _app_path("REGIONS_FILE",   "regions/us-ca-bay-area.geojson")
STORE     = _app_path("OBSERVERS_FILE", "data/observer.json")
BOOTSTRAP = os.environ.get("SEED_BOOTSTRAP_URL") or f"http://localhost:{os.environ.get('PORT', '3090')}/api/bootstrap"
```

A `--json` flag adds one `SEED_JSON {...}` line after the human report: located before/after, the labels of any newly located uplink observers, hash widths recorded/changed/cleared with names, final profile counts, and the backup path. The app parses that instead of scraping prose. The script also prunes its own backups to the newest `SEED_BACKUPS_KEEP` (14) — a daily pass would otherwise leave one `observer.json.bak-*` per day forever.

**Server side.** `runObserverReseed(trigger)` flushes the debounced write so the script reads a file that matches memory, spawns `python3 seed-observers.py --write --json`, then reloads the file into the same `Map` it would otherwise have fought:

- **the file wins for `lat`, `lon` and `hashBytes`** — the three fields the script owns. That includes its deliberate erasures: a position outside the region boundary is purged, and a width CoreScope no longer confirms from the node's own advert is cleared.
- **memory wins for `name` and `uplink`**, which are learned here from adverts and MQTT topics and are not CoreScope's to overwrite.
- the merge is then written back once through the normal debounced path, and `broadcastSnapshot(true)` pushes the new directory to connected clients.

One subtlety worth recording: the first implementation compared whole profile objects with `JSON.stringify` and reported **439 of 805 profiles changed** on a pass that changed nothing. The merge normalises absent values to `''`/`null` where the file simply omits the key, so almost every profile compared unequal. Comparing the five persisted fields individually fixed it — two consecutive passes now report `changed 0`.

**Schedule.** `OBSERVER_RESEED_ENABLED=true` and `OBSERVER_RESEED_HOUR=4` (local). The check runs every ten minutes and fires once per calendar day, and the last completed day key is read back from `data/reseed-log.jsonl` at boot, so a restart after the hour neither re-runs the pass nor skips it. Never gate this kind of thing on exact-minute equality.

**Boot pass on a region change (added after the Mariposa/Alpine expansion).** A boundary edit only reaches observer positions through a seeding pass, so widening the map used to wait up to a day. That is not hypothetical: today's 04:00 pass ran against the 28-county file and discarded both Kern repeaters, `TEH - Stallion Springs` and `The Dale Repeater`, because Kern was still outside the boundary. `computeRegionFingerprint()` hashes `REGIONS_FILE` **and** `UPLINK_CODES_FILE` — a code moved between the `codes` and `outOfArea` blocks changes which observers are in area, and re-running a pass that turns out to change nothing is cheaper than reasoning about which edits matter — and `loadLastReseedFingerprint()` reads the newest `ok: true` line out of `reseed-log.jsonl`. When they differ, `startRuntime()` arms one pass `OBSERVER_RESEED_BOOT_DELAY_MS` (60 s) after boot.

Four deliberate choices, each of which could have gone the other way:

- **The clock is not consulted.** The trigger is the edit, so it fires whatever time the deploy lands. It does still respect `OBSERVER_RESEED_ENABLED`, which keeps CI, the smoke run and sandbox copies from pulling CoreScope on every boot.
- **A boot pass does not claim the day key.** `runObserverReseed()` now guards `reseedLastDayKey = dayKey` with `trigger !== 'boot'`, so a deploy cannot suppress the day's scheduled run. `manual` and `api` keep their old behaviour.
- **Only successful passes count.** The fingerprint is written on both outcomes for debugging, but `loadLastReseedFingerprint()` requires `ok`, so a failed boot pass is retried on the next restart instead of being marked done.
- **An unreadable input yields `null`, not a new hash.** Folding the `ENOENT` into the digest would make every boot look different and fire a pass each time.

The timer is `unref()`d so it can never hold the process open, and `GET /api/admin/reseed` reports `regionFingerprint`, `lastSeededFingerprint` and `bootPassPending`. Verified with a real run rather than only in tests: first boot logged `region inputs changed (none recorded -> af262789ab4e3700); boot pass in 3s`, the pass landed as `trigger: "boot"` with `lastDayKey` still `null`; a second boot on the same files did not arm. `test/reseed-fingerprint.test.js` covers the five behaviours above with a stub seed script run through `/bin/sh`, so the suite needs neither python3 nor CoreScope.

**Optional external trigger.** With `ADMIN_TOKEN` set, `POST /api/admin/reseed` runs the same pass and `GET /api/admin/reseed` returns the last result; both authenticate on an `x-admin-token` header compared with `timingSafeEqual`, and both 404 while the token is blank, which is the default. That covers host cron, a CI schedule, or a Cloudflare Workers cron trigger — free-plan Workers allow 5 cron triggers per account at 10 ms CPU each ([limits](https://developers.cloudflare.com/workers/platform/limits/)). None of them earn their place here: a Worker can only make an HTTP request, so it still needs this endpoint, and an app that can be poked on a schedule can run its own timer instead of exposing an authenticated route to the internet.

**Measured.** `POST` returns in **~800 ms**. The site answered `200` locally and publicly throughout, with no restart and no supervisor involvement. A second pass immediately after the first: `changed 0`, `located 24 -> 24 of 36`, `widths +0 ~0 -0`.

**What replaced the daily task.** One weekly agent run (Mondays 08:00 America/New_York) that only reads. It confirms a scheduled pass landed on each of the last seven days, checks both hosts answer 200 and that the endpoint still reports `enabled: true`, looks for duplicate rendered hash prefixes, and notifies only when an observer newly appears on the map, a hash width moves, a day is missing, an entry failed, or a host is down. A quiet week ends silently. That is one seventh of the runs and none of the restart risk.

### 6z. Merging upstream v1.3.8 and giving the fork a version of its own

Upstream cut **v1.3.8** on 27 August 2026 (commit `8bab150`); this fork branched from `b478e83`, which is tag `v1.3.7`. The delta is small — 12 files, +99/−11 — and fetching it anonymously works from a sandbox with no GitHub credentials:

```bash
git fetch --no-tags https://github.com/yellowcooln/meshcore-health-check \
  refs/tags/v1.3.8:refs/tags/upstream-v1.3.8
```

**Merged, not rebased, and the reason is the push path.** Commits reach GitLab here through the Commits API, not `git push` — the sandbox cannot authenticate a git transport. That API can only append commits to a branch: it cannot force-push and it cannot write a two-parent merge commit. A real rebase would rewrite every local SHA and the remote would then need a force-push it will never get. So local history has to stay linear and byte-identical to the remote, and the upstream delta lands as one ordinary commit that names its base in the message (`upstream base: v1.3.8 (8bab150)`). The provenance is in the history either way: the fork still contains upstream's `b478e83` with its original authorship.

**Version scheme.** `package.json` now reads `1.3.8+bayarea.1`. That is SemVer *build metadata*, chosen over the two obvious alternatives:

| Candidate | Why not |
| --- | --- |
| `1.3.8-bayarea.1` | A hyphen makes it a *pre-release*, which sorts **below** plain `1.3.8`. This build is upstream 1.3.8 plus work, not a release candidate for it. |
| `2.0.0` | Collides with whatever upstream calls its own next major, and claims a lineage the fork does not have. |

`+bayarea.1` states the two facts that matter — the upstream base, and which fork build sits on top of it — and the counter after the `+` increments independently of upstream. When the next upstream release is merged the base moves and the counter resets: `1.3.9+bayarea.1`.

**Docker compatibility.** A Docker tag must match `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`, so `+` is illegal and `docker build -t app:1.3.8+bayarea.1` fails outright. Rather than keep two hand-maintained version strings, a new `lib/version.js` derives one from the other:

```js
export function dockerTag(version) { /* 1.3.8+bayarea.1 -> 1.3.8-bayarea.1 */ }
export function isLegalDockerTag(tag) { /* DOCKER_TAG_PATTERN.test(tag) */ }
```

`npm run docker:tag` prints it, `docker-compose.yml` pins `image: bayarea-mesh-health-check:${APP_IMAGE_TAG:-1.3.8-bayarea.1}`, and a unit test fails if the compose default ever drifts from `dockerTag(package.json.version)`. The hyphen form is only ever an image tag; nothing in the app reports it as its version.

**`CARTO_API_KEY` → `CARTO_BASEMAP_KEY`.** Upstream added its own keyed-basemap support in 1.3.8 and named the variable `CARTO_BASEMAP_KEY`; this fork shipped the same feature first (§6h) under `CARTO_API_KEY`. Upstream's name wins as canonical — future merges are cheaper if the config surface matches — and the old name is kept as a read fallback so a `.env` written before the merge keeps working:

```js
const CARTO_BASEMAP_KEY = envValue('CARTO_BASEMAP_KEY', '') || envValue('CARTO_API_KEY', '');
```

The fork's richer implementation survives: the server still resolves per-theme tile URLs and keys `light_all` as well as `dark_all`, which upstream does not, and `MAP_TILE_DARK_URL` / `MAP_TILE_LIGHT_URL` still override both. What was adopted is upstream's **behaviour when no key is set** — both themes now fall back to OpenStreetMap rather than requesting a CARTO tile that comes back watermarked. The boot warning changed to match: `[web] no CARTO_BASEMAP_KEY set - the coverage map falls back to OpenStreetMap tiles`.

`/api/bootstrap` publishes the basemap block twice: at the top level, where upstream put it, and under `site.map`, where this fork already had it and where the client reads it. It is a seven-field object built once per response and shared by reference, and having both shapes available means the next merge does not have to move a field the client depends on.

**Node 26.** Upstream's `Dockerfile` moved to `node:26-slim`; `.gitlab-ci.yml` and `.github/workflows/ci.yml` follow it to `node:26-bookworm` and `node-version: 26`. The sandbox that produced this work runs Node 20, so CI is the only place the 26 toolchain is actually exercised — if a pipeline breaks on a syntax or API difference, the honest fix is to drop the CI images back to 22 and note it, not to guess.

**Tests.** A new `test/basemap-key.test.js` boots two additional server instances in one file — cache-busting the `server.js` import URL so each picks up a different environment — and asserts that a legacy-only `CARTO_API_KEY` still keys both tile URLs, and that a keyless deployment serves OpenStreetMap for both themes with `darkBasemapAvailable: false`. It also pins the version scheme itself: the version must match `\d+\.\d+\.\d+\+bayarea\.\d+`, its base must be `1.3.8`, `dockerTag()` must produce a legal tag, and compose must pin exactly that tag. Two smoke tests adapted from upstream's watch the wire instead of the payload — one asserts the dark map requests `dark_all` with `key=`, the other that a keyless bootstrap produces OpenStreetMap requests and zero CARTO requests. Unit suite 61 passing, smoke 10.

**One rendering consequence.** The footer note inherits `.small-note`, which is `text-transform: uppercase`, so the new version rendered as `VERSION: V1.3.8+BAYAREA.1`. SemVer build-metadata identifiers are case-sensitive, so that prints a string that is not the one in `package.json`. `.site-footer .small-note` now opts out of the transform; the repo slug beside it reads better in its own case too.

**Still pointing upstream.** The footer's version link is `${REPO_URL}/blob/main/CHANGES.md` with `REPO_URL` hardcoded to upstream GitHub, so it now links to a changelog that does not contain a `v1.3.8+bayarea.1` section. Repointing it at this fork's GitLab copy only helps once that project is public — while it is private the link redirects visitors to a sign-in page, which is worse than an incomplete changelog. It is bundled with the visibility decision in §8.

## 7. Deployment

Nothing region-specific here, but for your setup: Docker Compose on port 3090 behind Cloudflare, `TRUST_PROXY=1`, Turnstile keys set since it'll be internet-facing, and keep `./data` mounted so observer profiles, activity history, and share links survive rebuilds.

Host choice matters more than it looks. **Vercel cannot run this app** — it needs one long-lived process holding a persistent MQTT subscription plus in-memory session/observer `Map`s and an in-process WebSocket server, while Vercel pauses instances between requests, caps execution (300 s Hobby / 800 s Pro), and tells you to keep shared state in an external store ([Fluid compute services](https://vercel.com/kb/guide/vercel-services-fluid-compute), [function limits](https://vercel.com/docs/functions/limitations), [WebSockets](https://vercel.com/docs/functions/websockets)). Chosen path: self-hosted Docker behind a named Cloudflare Tunnel at `healthcheck.bayareameshcore.org` — step-by-step in `bay-area-deploy-cloudflare-tunnel.md`, with the `cloudflared` sidecar in `docker-compose.tunnel.yml`. Fly.io or Render also take the tree unchanged if you'd rather not run hardware.

### Handling the GoMesh credential

The verified config is committed in `.env.bayarea.example` with `MQTT_USERNAME=example_user` and `MQTT_PASSWORD` deliberately left **blank**. The password is not recorded in this document or in any tracked file, by design — `server.js` passes it straight through as a static MQTT username/password, so anything holding it is a plaintext secret.

Recommended handling:

```bash
cp .env.bayarea.example .env          # .env is already gitignored
# then set the password in .env, or keep it out of the file entirely:
MQTT_PASSWORD=$(cat /run/secrets/gomesh_mqtt) docker compose up -d
```

Two operational notes. First, the credential currently in use has been shared over chat, so **rotate it before this goes internet-facing**. Second, ask the operator for an account issued specifically to this deployment rather than a shared one — a shared credential means any future rotation silently breaks whichever other tools were using it.

Validate with:

```bash
npm run check && npm test
docker compose up -d --build
curl -s http://localhost:3090/api/bootstrap | jq '.observers | length'
npm run test:smoke
```

Expected startup log, given the verified config:

```
[regions] loaded 23 region boundaries
[mqtt] subscribed meshcore/#
```

One `[mqtt] subscribed` line, not nine — the single-topic grant replaced the per-city list. If you see `meshcore/BOS/#` instead, `MQTT_TOPIC` didn't load. Within a few minutes `/api/bootstrap` should report roughly 30-plus active observers and a `regionHierarchy` populated with the groups above.

---

## Change checklist

**Done / verified**

- [x] Whole-system telemetry (Control Center, Live Surface, Transport, Node Count, Signal Quality) moved to the bottom of `Show Additional Information`; theme toggle deliberately kept in the hero — §6l
- [x] Receipt Spread moved into Observer Reports above the receipt list; the duplicate `#receipt-spread-note` removed — §6l
- [x] Light mode now fills a bare `.panel` and `.glance-card`, closing a trap that rendered the new panel grey-on-grey — §6l
- [x] Headline reads `across the Bay Area`; hero lede no longer prints the same clause twice, and the hardcoded suffix fallback that caused it is removed — §6m
- [x] Brand row reflows: title uses the full width on desktop, utility controls take their own row below 720px — fixes a §6l regression at phone width — §6m
- [x] Headline uses the full panel width (1270px, one line at 1440px); utility controls sit on their own right-aligned row — §6n
- [x] Pulsing status dot removed from before the channel name in the hero lede — §6n
- [x] Utility controls are a compact 172px stack centred on the right edge, taking no vertical space; header block 246px → 216px — §6o
- [x] Page shell widened from 1480px to 1860px — the whole app, not just the header, was boxed into a centred half-screen column — §6p
- [x] Utility control stack top-aligned with the eyebrow instead of centred in the row — §6p
- [x] Stale two-column `.hero-stage` override at ≤1240px removed — the header was 52% of the shell from 721px to 1240px, a §6l miss; verified full width across 21 viewport widths — §6q
- [x] Lede moved inside `.brand-copy` so it sits under the headline beside the buttons; header 216px → 191px — §6r
- [x] Install App button hidden via `#install-app-button { display: none }` (node kept: `app.js` binds to it) — §6r
- [x] Brand row converted to an explicit grid so the lede spans the orb column while the utility stack holds the top row — §6s
- [x] Startup status shows `--` instead of a misleading `EXPIRED` for a restored, never-used code — §6t
- [x] Instructions rewritten as three numbered steps; share page shows a saved-result line instead — §6t
- [x] Scannable `meshcore://channel/add` QR served from `/channel-qr.svg`, key derived when `TEST_CHANNEL_SECRET` is blank; decode verified with OpenCV — §6t
- [x] Scan the channel QR with the companion app on a real phone — tested by Tim and it accepts the derived hashtag key, so no fallback to *Join a Hashtag Channel* is needed — §6t
- [x] Session panel leads with the three steps and the QR; Active Code sits below — §6u
- [x] Share button moved beside the sentence that explains sharing; Matched Message moved to the foot of the second column — §6u
- [ ] `APP_DESCRIPTION` must be set by hand on any other deployment — it is not in the patch — §6u
- [x] Named Cloudflare tunnel live at `healthcheck.sonomamesh.com` after nine quick-tunnel revocations in eleven hours; tunnel `bayarea-mesh-health-check`, proxied CNAME in zone `sonomamesh.com`. Requires `protocol: http2` and a **quoted** `edge-ip-version: "4"`. Full rebuild notes in the deployment doc appendix — §6u, §7
- [x] QR moved into the panel header at 84px; steps no longer share a row with it — §6v
- [x] Status, Message Hash and Matched Message folded into the one stats table — §6v
- [x] Placeholder marketing copy and the Live Surface pulse removed from both pages — §6v
- [ ] Confirm whether New Code / Copy should align to the page edge rather than the left column edge — §6v
- [x] QR aligned to the column's right edge on Step 1's baseline, caption dropped — §6w
- [x] Telemetry panel renamed "System Telemetry" on both pages — §6w
- [x] Tests wired to GitLab CI and green on shared runners: 56 unit, 7 Playwright smoke, 111 s end to end. A live `.env` was leaking into the unit suite via server.js's env-file loader — 9 failures in the working tree, 0 on a clean checkout; fixed with `MESH_HEALTH_SKIP_ENV_FILE` — §6x
- [x] Source pushed to GitLab as private `tmcgee/bayarea-mesh-health-check`, four commits: upstream import at `b478e83`, the 15 MB `us-places.geojson` split out to stay under the API payload limit, the Bay Area adaptation, then `docs/`. `git push` cannot authenticate through the sandbox proxy — it opens a raw CONNECT tunnel for the git smart-http endpoints, so no credential is injected; built via the Commits API with `gitlab-push.py` instead. Remote tree verified blob-for-blob against local HEAD, 69 files, no `.env`. Cloudflare account, zone and tunnel IDs appear only as placeholders, in every commit — the first attempt carried them verbatim and the project had to be purged and rebuilt, because the Commits API cannot force-push over history. **Safe to make public.**
- [x] Broker endpoint identified: `wss://mqtt.gomesh.dev:443/mqtt` — WebSockets/TLS on 443, not 1883/8883
- [x] Credentials verified: `example_user` returns CONNACK 0 and **SUBACK granted on `meshcore/#`**
- [x] Live feed confirmed: 2,400 messages / 34 observers / 12 IATA codes in 270 s
- [x] `MQTT_TOPIC=meshcore/#` chosen — broad grant, so no per-city list needed
- [x] `regions/us-ca-bay-area.geojson` built and fitted to the observed IATA codes (28 counties)
- [x] `.env.bayarea.example` written with the verified MQTT block
- [x] Test channel set to the hashtag channel `#healthcheck`, key derived (`3ae59c2c…02ae`) and confirmed to load as channel hash `02`
- [x] `EXTERNAL_LINK_URL` → `.org`, `CORESCOPE_URL` → `https://corescope.stonekitty.net`
- [x] Boundary file rebuilt from Census TIGERweb — the earlier decimated geometry was dropping shoreline and island nodes out of their own counties
- [x] `data/observer.json` seeded from CoreScope: 636 in-area nodes merged, 18 out-of-area discarded, 19 out-of-region coordinates purged; located uplinks 10/37 → 21/33, map markers 0 → 8
- [x] `REQUIRE_REGION_MATCH=true` added so Orlando/Philadelphia adverts can't re-pollute the map
- [x] Theme matched to bayareameshcore.org (`public/theme-bayarea.css`, both light and dark) and icon recoloured
- [x] Signal-quality regression fixed: GoMesh publishes `SNR`/`RSSI` uppercase as strings, so telemetry never reached the receipts; case-insensitive extraction added plus two regression tests (`npm test` now 43/43)
- [x] Coverage map scope: `MAP_OBSERVER_SCOPE=directory` wired through `renderHtmlTemplate` → `data-map-observer-scope` on `<body>`, so the map plots the located directory (22 markers) instead of the 10-node scoring target (8 markers)
- [x] Uplink-code region fallback: `UPLINK_CODES_FILE=regions/us-ca-uplink-codes.json` + `REGION_FALLBACK=uplink-code` place the 13 coordinate-less observers into region groups read-only, and the out-of-area codes (`MCO`/`PHL`/`MCI`; `BFL` removed 2026-09-10) are excluded from the directory unconditionally (`npm test` now 50/50)
- [x] Coverage map pulled back out of the collapsed section: it now has its own always-visible full-width row directly above the Show Additional Information toggle, and the inner grid dropped the `map` area so it doesn't reserve an empty column (§4)
- [x] Startup placeholders: a session with no receipts now reports `healthMeasured: false` / `healthLabel: WAITING`, and the UI shows `Waiting` and `--` in the default text colour for the score, Observers Reached, and Repeaters instead of a red POOR / 0% / 0 / 10 (§6d, `npm test` now 51/51)
- [x] Full run against GoMesh: 23 regions loaded, `meshcore/#` subscribed, 30-32 active observers, `npm run check` clean, `npm test` 43/43 with `REQUIRE_REGION_MATCH=false REGIONS_FILE= SITE_URL=` (the suite's fixtures are Boston coordinates, so the Bay Area `.env` legitimately fails 9 of them)
- [x] Health percentage denominator: replaced by `OBSERVER_TARGET_MODE=active` — the denominator is now the scoring-eligible active set snapshotted at session creation, unioned with anyone who actually reported, so it neither caps at a stale roster nor pins to 100%. A **Regions Reached** metric was added alongside it (§6e). A follow-up (§6f) stopped the region chips from silently redefining the target and added `OBSERVER_MIN_SCORING_SET=3`, so a one-observer target reports `1 / 1` but no grade instead of `100% VERY HEALTHY`. The observer checkboxes were then removed outright (§6g) — the list is read-only and the region chips are a pure display filter — and §6h stopped excluding coordinate-less observers from the target, which had been silently discarding 13 of 35 live observers (`npm test` 56/56)
- [x] Observer prefix widths: each observer now shows the width its own advert confirms — 1, 2, or 3 bytes — instead of a single global 1-byte label, which removes the `69` and `E4` collisions from the directory (§6j). §6k extended the same rule to the receipt cards, where `observerHash` had frozen at packet time
- [x] Observer Reports de-duplicated: the `Timeline / Arrival order` sub-panel is gone and its arrival order, offset, and position track now live in each receipt card above the Signal bar; path distance legs render one per line (§6k)

**Remaining**

- [ ] Close the coordinate gap: 13 of 34 active observers still publish no position. They now land in a region *group* via their uplink code (§6c), but a group is not a county and never a map marker — the fix is to get those nodes advertising a position
- [ ] Reclassify `regions/us-ca-uplink-codes.json` as codes are actually observed: 21 of the 31 in-area entries are still `"confidence": "anticipated"`, and any code in neither block is logged once rather than excluded
- [x] Rotate the shared credential — closed as won't-do: Tim confirmed the shared GoMesh MQTT credential is fine for this deployment, so no separate account is being requested. `MQTT_PASSWORD` still lives only in the uncommitted `.env` (the repo carries placeholders)
- [ ] Confirm `#healthcheck` isn't already used locally for something else, then announce it
- [x] Set the real `SITE_URL` origin — `SITE_URL=https://healthcheck.sonomamesh.com`, the pinned named-tunnel hostname
- [x] Regenerate `image1-3.png` screenshots from this deployment — `regen-readme-shots.py` captures them from archived session MHC-BDCA34 (100%, 31/31 observers, 8/8 regions): the result card, the receipt spread with two receipt cards and their estimated paths, and the coverage map with 22/22 mapped observers. Regenerating exposed a real defect, now fixed: upstream's decorative `.splash-scene__badge` pills sit at `z-index: 0` behind the translucent hero, so "Adaptive mesh" bled through underneath the header buttons as illegible ghost text. They are hidden in `theme-bayarea.css`
- [x] Re-run `seed-observers.py` periodically as CoreScope learns new nodes — now **in-process**: `OBSERVER_RESEED_ENABLED=true` runs the pass daily after `OBSERVER_RESEED_HOUR` with no restart, no outage and no credits (§6aa). The paid daily agent task is deleted; a weekly agent run reads `data/reseed-log.jsonl` and pages only on a real change or a missed day. Previously scheduled daily at 04:15 America/New_York (`15 8 * * *` UTC). The task dry-runs first and only writes when CoreScope has gained a position for a directory observer that lacks one, plus one unconditional refresh on Sundays.

  **Why a live per-request lookup is not worth it.** CoreScope has no per-key route: `/api/nodes/<pubkey>` 404s, and `?public_key=` / `?key=` are silently *ignored* — both return the default 50-node page, so a naive lookup would appear to work and hand back the wrong node. `?search=` matches the name field only; the full key, a 12-char prefix, and a 6-char prefix all return `total: 0`. The only usable query is the whole list, `/api/nodes?limit=5000` (799 nodes, 595 KB, ~0.45 s TTFB, `cache-control: no-store`), which is a bulk refresh rather than a lookup.

  It would also gain nothing today. Of the 13 directory observers with no coordinates, 10 do not exist in CoreScope at all and the remaining 3 carry `lat/lon: null` or `0,0`:

  | Observer | Uplink | In CoreScope | Position |
  | --- | --- | --- | --- |
  | Marsh-MQTT | SJC | yes (companion) | `null, null` |
  | Nullrouten 📎 | SJC | yes (repeater) | `0, 0` |
  | Pilsner G3 | SQL | yes (repeater) | `0, 0` |
  | AC3Tree, BerryRPT, BlorkoBot, Diablo Yagi, MorroBay Rptr, SRV Mesh Recon, armooo, bot-drycreek, lutin, mk-logger | SJC/OAK/STS/APC/PRB/SBP | no | — |

  Key formats are not the problem — both sides are 64-hex and all 22 located observers match a CoreScope node. These 13 are mostly MQTT bridge clients and logger bots: software uplinks that never advertise a position, which is exactly why they resolve through the uplink-code fallback (all 13 report `regionSource: "uplink-code"`). CoreScope has the same gap network-wide, with no usable position for 145 of its 799 nodes.

  **Ordering hazard for an external write — since removed.** `observer.json` is read once at boot into an in-memory `Map` (`server.js` ~line 894), and `writeObserverNamesFile()` serialises that Map back over the file, debounced 250 ms after any learned advert metadata. Writing the file from outside is therefore clobbered by the next advert, which forced the whole stop-the-supervisor, kill-the-child, write, restart, re-verify sequence and a ~30 s outage every morning.

  **The refresh now runs inside the app (§6aa),** which removes the hazard rather than working around it, and with it the daily agent task. `OBSERVER_RESEED_ENABLED=true` runs the pass once a day after `OBSERVER_RESEED_HOUR` (local time, checked every ten minutes so a restart cannot make the day skip): flush the debounced write, spawn `seed-observers.py --write --json`, reload the file into the same `Map`, reconcile. ~800 ms, no restart, no downtime, no credits. One weekly agent run reads `data/reseed-log.jsonl` and pages only when something user-visible moved.
- [ ] Turnstile keys + DNS/reverse proxy
- [ ] Leave `KNOWN_OBSERVERS` blank, curate later once always-on hilltop sites are known
- [ ] Announce the channel on the Bay Area MeshCore Discord

---

## Appendix: other regional deployments (probed 2026-08-27)

Four live instances confirmed by reading each site's `/api/bootstrap`:

| Deployment | Version | Broker reported | `MQTT_TOPIC` in use | Active observers | Region file |
|---|---|---|---|---|---|
| [healthcheck.bostonme.sh](https://healthcheck.bostonme.sh/) (origin) | 1.3.8 | `mqttmc01.bostonme.sh:443` | `meshcore/#` | 43 | 5 US states, groups New England / Mid-Atlantic |
| [healthcheck.ukmesh.com](https://healthcheck.ukmesh.com/) | 1.3.7 | `mqtt.ukmesh.com` | `meshcore/+/+/packets`, `.../status`, `.../internal` | 20 | 7 UK regions, group England |
| [health.mwmesh.com](https://health.mwmesh.com/) | 1.3.7 | `MWMesh Broker` | `meshcore/#` | 40 | 13 counties, grouped by state (Idaho, Utah) |
| [health.chicagooffline.com](https://health.chicagooffline.com/) | 1.3.6 | `mosquitto:1883` | `meshcore/#` | 8 | none configured |

Two takeaways for the Bay Area build:

1. **Nobody filters by IATA prefix.** Three of four subscribe to `meshcore/#` and let the GeoJSON region filter do the geography; UK uses the `meshcore/+/+/packets` wildcard. Per-city topic lists are a workaround for a broker that won't grant a broad read, not the normal pattern — and since GoMesh does grant `meshcore/#`, this deployment follows the same pattern.
2. **Chicago co-locates its own broker** (`mosquitto:1883` — an unencrypted service name inside the Compose network, not a public host). That's the fallback if GoMesh read access stalls: run a local Mosquitto in the same Compose project, bridge it to GoMesh, or have Bay Area observers publish a second copy to it.

The MWMesh region file is the closest structural match to `us-ca-bay-area.geojson` — counties as features, grouped one level up.

Five forks exist on GitHub; only [Colorado-Mesh/meshcore-reach-check](https://github.com/Colorado-Mesh/meshcore-reach-check) is renamed rather than a plain copy, and no public Colorado deployment answered at any guessed hostname.
