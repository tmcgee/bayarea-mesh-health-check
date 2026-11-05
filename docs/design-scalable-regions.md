# Design: regions built from a shared scope tree

Status: draft for review, 2026-10-30 (revised the same day: place-code IDs, Central Valley decision; revised 2026-11-01: no region in links). Not scheduled. Targets 1.2.0 (revised 2026-11-03: a setup break, released as a minor version by decision, as 1.1.0's scope-file change was). Nothing here is built.

## 1. Problem

`regions/us-ca-bay-area.geojson` (544 KB, 32 features) holds three different things in one hand-edited file:

1. Geometry: county outlines from Census TIGER.
2. Hierarchy: each feature's `group` and `parentRegion` (Sonoma → North Bay → Bay Area).
3. Coverage: which counties exist at all. Observers outside them are never shown or scored.

Growing the mesh's reach (more of California, Nevada, Arizona, Oregon, the whole west coast, British Columbia) means hand-editing all three, and the app's fixed three levels (parent region → region → subregion) will not fit other communities' trees.

## 2. Goals and non-goals

Goals:

- Hierarchy and coverage come from a shared, community-maintained MeshCore scope tree, pinned by commit, with no app-side table to keep in step.
- Geometry comes from a shape library we own, keyed by stable IDs, built by a script from national public sources.
- Hierarchy of any depth; level names come from the tree.
- Adding a state or province is a pin bump plus, at most, a library rebuild.
- Several trees can be loaded (for example a US tree and a Canadian one).

Non-goals:

- Deriving boundaries from observer positions. Points cannot draw a border, and the boundary decides which observers are in, so it would be circular. Observers keep deciding which places appear (a place with no observers gets no chip or outline), as today.
- Fetching anything at boot. Network dependence and a bad remote file at startup were rejected earlier.
- Changing MQTT ingest. `MQTT_TOPIC=meshcore/#` already receives every uplink; reach is decided by the region inputs, not by the subscription.

## 3. The source: MeshCore-Regions-North-America

[bayareameshcore/MeshCore-Regions-North-America](https://github.com/bayareameshcore/MeshCore-Regions-North-America) was created 2026-10-29 to coordinate one tree for North America. State on 2026-10-30:

- main: `README.md` and `regions.yaml` (36,041 B), copied from [matkam/meshcore-settings](https://github.com/matkam/meshcore-settings). No generated JSON on main.
- [PR #1 "Add NV"](https://github.com/bayareameshcore/MeshCore-Regions-North-America/pull/1) (open, Ben Allfree / MeshEnvy): root `us`, states directly under it, Nevada's 17 counties under an `imw` (Intermountain West) place, 49 `placeholder: true` state slots, census regions and `pnw`/`inw` as opt-in tags, a build script, a generated `data/regions.json` (66,709 B, format 2, 139 places: 90 real, 49 placeholders, 6 tags) and `data/us-states.geojson` (96,036 B).
- [Issue #2 "Goal and schema definition"](https://github.com/bayareameshcore/MeshCore-Regions-North-America/issues/2) (open): asks for the goal and schema to be written down first; floats ISO 3166 codes for top levels and firmware limits (8 levels, 29-30 byte names, 32 names per repeater).

What the schema already gives us (format 2, same as matkam's, so the JSON-not-YAML decision stands):

- Codes unique across the whole file, enforced by the validator (`humboldtnv` beside California's `humboldt`). Codes are flat on the node, so this is the namespace rule we need.
- Ragged nesting with `levels` by depth and a per-place `kind` override.
- `outline`: a shape name, or a list, that a place claims.
- `placeholder: true` for slots no community has adopted.
- `tags`: scope names directly under the root that places opt into.

Gaps, relative to this design:

| Gap | Effect here | Handling |
|---|---|---|
| Nevada places have `lat`/`lon` only, no `outline` | No polygon, so no observer can fall inside | Library fallback by kind + name within state (§5.2); propose outlines upstream |
| Outline names are bare county names ("Nevada" = Nevada County CA; "Humboldt" exists in CA and NV) | Ambiguous across states | Resolve names within the place's state ancestor (§5.2) |
| Single root `us` | British Columbia does not fit | Load several trees (§5.7); raise on issue #2 |
| No LICENSE file; YAML says `license: MIT` | Attribution basis is thin | Ask upstream for a LICENSE before adopting |
| PR unmerged, schema unsettled, codes may be renamed | Pinning now could pin a draft | Adopt only after merge and a schema decision (§9) |
| Generated JSON exceeds our 65,536 B loader cap | App fails at startup today | Raise the cap (§5.6) |

## 4. Current touch points

| Area | Today |
|---|---|
| Boundaries | `REGIONS_FILE` GeoJSON, `loadRegionBoundaries()` in `server.js`, properties `name` / `group` / `parentRegion` |
| Hierarchy | `regionGroupParents` built from features; three fixed levels |
| Scope tree | `MESHCORE_REGION_SCOPES_FILE` = matkam `regions.json` @`7ec46658`, `lib/meshcore-scopes.js`, `scopeForSubregion()`, 73 names recognised; drift check `scripts/check-scopes.js` with `PINNED_SHA256` |
| Uplink codes | `regions/us-ca-uplink-codes.json`: `codes` map airport code → group name; `outOfArea` excludes |
| Stored names | `data/observer.json` holds each observer's `region` / `regionGroup` by display name |
| Links | Carry no region (1.1.0 decision): shared links open on All and the address bar is never rewritten for a region |
| Locator | `GET /api/region-locator`, simplified to ~310 KB |
| Reseed | `computeRegionFingerprint()` hashes `REGIONS_FILE` and `UPLINK_CODES_FILE`; the user fires `POST /api/admin/reseed` |

## 5. Design

Three inputs replace the boundary file:

1. One or more scope trees (format-2 `regions.json`), pinned by commit and SHA-256, shipped verbatim. Not ours.
2. A shape library, ours, built by a script, keyed by stable ID.
3. A local overrides file, ours, for any deliberate difference from the tree. It starts empty (decision 2026-10-30: follow the tree's single `centralvalley`) and should stay that way by taking differences upstream.

### 5.1 Shape library

- File: `regions/shapes/*.geojson`, one per country/state, so a rebuild touches only what changed.
- Feature IDs: `us-<state FIPS><county FIPS>` (Sonoma `us-06097`), `ca-<SGC census division>` for Canada (BC regional districts are census divisions). Properties: `id`, `name`, `kind` (`county`, `regional district`, `custom`), `state` (`us-ca`, `us-nv`, `ca-bc`).
- Sources: US Census [cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html), county 1:500k (public domain); Statistics Canada [boundary files](https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/index2021-eng.cfm), census divisions, under the [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) (attribution in NOTICE).
- Build: `scripts/build-shapes.js` downloads at build time only, simplifies to a fixed tolerance, rounds to 5 decimals (~1 m), and writes the files plus a manifest with the source URL, vintage and SHA-256. The app never downloads.
- Custom shapes (`kind: custom`, ID `custom-<slug>`) for sub-county places, such as a Tahoe basin or a split of a very large county (San Bernardino, Nye). Hand-drawn, reviewed like code.
- Size: today about 17 KB a county at current detail. California + Nevada (75 counties) ≈ 1.3 MB; the western US (about 400 counties) ≈ 7 MB at the same detail. Only shapes claimed by loaded trees are read into memory; the rest stay on disk.

### 5.2 Resolving a place to shapes

For each non-placeholder place, in order:

1. `outline` names are resolved within the place's state ancestor (the nearest ancestor with `kind: state`, or one whose `aliases` contain `us-xx`). "Nevada" under California is Nevada County CA; "Humboldt" under `nv` is Humboldt County NV.
2. If no `outline`, and `kind` is `county` (or `regional district`), match `name` against library names in that state ("Washoe County" → `us-32031`). This covers PR #1's Nevada without changing the tree.
3. An overrides entry may name shape IDs explicitly.
4. Otherwise the place's geometry is the union of its children's. A place with no geometry at any depth is point-only: listed, never used for containment, and logged once.

Every resolution is logged at boot with a count ("90 places, 81 with shapes, 9 point-only"), and the check script (§8) fails on any outline name that resolves to zero or more than one shape.

### 5.3 Coverage and assignment

- Coverage is the union of the geometry of every resolved place in every loaded tree, optionally narrowed by a `coverage` list (open question 6). An observer outside it is never shown or scored (the existing rule, unchanged), and `outOfArea` uplink codes still exclude unconditionally.
- An observer is assigned to the deepest place whose geometry contains its position. Ties (overlapping custom shapes) go to the smaller area. A bounding-box check runs before point-in-polygon, so cost grows with the number of nearby shapes, not with the size of the library.
- An assignment is stored as the deepest place's own code only (`sonoma`), never as a path or a name. Codes are unique across a whole file (and, per §5.7, across loaded trees), so the code alone identifies the place. The path (`bayarea` → `northbay` → `sonoma`) is worked out at boot from the loaded tree, so a change above the place does not touch stored data.
- Why not a path: the two candidate sources disagree above the state. matkam's root is `us / west / california` (not selectable); MeshCore-Regions-North-America PR #1 has root `us` with `california` as a selectable state place. Below the state the two California trees carry the same 70 codes (checked 2026-10-30 against matkam `7ec46658` and PR #1 `08eca3db`). A stored path would change on the switch; a stored code does not.

### 5.4 Any-depth hierarchy

- The three fixed levels become a path, derived at boot from each place's code (§5.3). The UI shows one chip row per level actually present below the current selection, labelled from `levels[depth]` or the place's `kind`. Root tokens are not selectable, as the tree says, and are treated exactly like the tree's other non-place levels, so the matkam root `us / west / california` and the North America root `us` (with `california` as a place) need no special case; the switch only adds a California level above Bay Area.
- Scoring (`scopeScores`, `scoreForSelectedScope`) works on "observers whose path starts with P", which is the same at every depth.
- Only places that hold observers appear, so a 400-county library never puts 400 chips on screen.
- Map: one outline per place on the selected level, 2px, colours from bayareameshcore.org, layout unchanged.

### 5.5 Identifiers

- A place's own code is the ID everywhere: `data/observer.json`, the uplink codes file, the locator. Names are display only, so a rename upstream changes labels, not data. Only a code rename (for example `california` → `us-ca`, if issue #2 adopts ISO forms) changes an ID; a small `renamed` map in the overrides file can carry old codes to new ones for one minor version.
- Links and the address bar carry no region (decided 2026-10-30, kept here), so codes never appear in a URL and nothing about links changes in 1.2.0.
- `us-ca-uplink-codes.json`: `codes.<AIRPORT>.group` becomes `codes.<AIRPORT>.place` (a code). Version 2 of that file.

### 5.6 Scope recognition

- Recognised names = every non-placeholder place code + every tag. Placeholders are not on hardware and are skipped.
- Raise `MAX_FILE_BYTES` from 65,536 to 1 MiB per tree; keep `MAX_NAMES` (1024) as a per-tree ceiling with a clear startup message.
- Cost: recognition tries each name's key against each scoped packet (an HMAC per name). 73 names today; a full US tree could reach several hundred. Limit the candidate set to names on chains that hold coverage (places with shapes, their ancestors, and the tags they carry), and measure before and after on a captured packet set.

### 5.7 Several trees

- `MESHCORE_REGION_SCOPES_FILE` accepts a comma-separated list. Each tree keeps its own root.
- Codes must be unique across loaded trees, because the node's table is flat. A collision is logged and the later tree's place is dropped (not fatal), and the check script fails on it.
- This is how British Columbia would join, unless issue #2 moves to a multi-root North America tree, in which case one file again suffices.

### 5.8 Overrides

`regions/region-overrides.json`, ours, small, reviewed like code. Allowed operations only:

- `regroup`: insert a local grouping level between a place and its children, with a `reason` and a link to the upstream issue that would remove it. Not used at first: the San Joaquin Valley North / South split is dropped in favour of the tree's `centralvalley`.
- `shapes`: explicit shape IDs for a place.
- `exclude`: drop a place from coverage.

- `renamed`: old code → new code, read only for stored data, for one minor version.

Each override is logged at boot. The file ships empty. The unposted draft issue to rename `centralvalley` to `sanjoaquinvalley` is a naming question for upstream, not an override.

### 5.9 Failure behaviour

Unchanged in spirit: a missing or invalid input disables region detection with a warning rather than crashing, and the check script catches problems before release. Startup logs one line per input with its SHA-256, so a deployed box can be compared to the pin.

### 5.10 Reseed

`computeRegionFingerprint()` hashes every tree, the shape manifest, the overrides file and the uplink codes file. Any change to them flags a reseed; the user fires `POST /api/admin/reseed`, as now.

## 6. What changes for users

- Chips follow the tree: Bay Area → North Bay → Sonoma, and so on. The San Joaquin Valley parent with its North and South regions becomes the tree's single Central Valley with eight counties directly under it (San Joaquin, Stanislaus, Merced, Madera, Fresno, Kings, Tulare, Kern). The same eight counties, so no observer changes county; only its grouping and labels change.
- Alpine stops being its own chip: its observers sit in Eastern Sierra, the tree's deepest place there.
- San Francisco, Peninsula and South Bay are single-county places directly under Bay Area in the tree, as today's one-subregion groups are in effect, so they read the same.
- Coverage widens to every county the loaded trees claim. Places with no observers stay invisible.
- UI copy says "heard", never "seen"; level labels come from the tree ("county", "area"), not "subregion".

## 7. Versioning

1.2.0: the boundary input and the uplink codes format change. Strictly that breaks setups, but it is released as a minor version by decision (nobody else runs the app), as 1.1.0's scope-file change was. Released as `v1.2.0+upstream.A.B.C` after approval, with a reseed.

## 8. Checks and tests

- `scripts/check-scopes.js` generalised: per-tree pin (`PINNED_SHA256` per file), drift report against upstream, resolution report (§5.2), cross-tree collisions.
- `scripts/check-shapes.js`: manifest SHA-256s match the files; IDs unique; no self-intersecting rings.
- Unit: resolution rules (state-scoped names, kind + name fallback, children union, point-only), deepest-place assignment, path scoring, override operations, placeholder and tag handling, size cap.
- Equivalence test for phase 1: today's matkam tree + library (overrides empty) must assign every observer in a fixture to the same county as today's GeoJSON. Grouping is expected to differ in exactly two places, and the test asserts exactly those: the eight Central Valley counties (parent San Joaquin Valley and regions North / South become `centralvalley`), and Alpine, which the tree has no county-only place for, so Alpine observers land in `eastsierra` (Alpine, Inyo, Mono) rather than an Alpine subregion. The other 23 features map one to one (checked 2026-10-30 against matkam `7ec46658`).
- ID stability test: the same fixture loaded under a matkam-shaped root and a North-America-shaped root (a made-up two-state tree, not PR #1's file, which has no LICENSE yet) must store identical codes.
- Smoke: chip rows at depth 1-4, the URL never changing, the 390px layout. The "Valley" fixtures move to codes.

## 9. Phases

0. Upstream (drafts only, posted with approval): on issue #2, ask for a LICENSE file, outlines (or `kind: county` + state-resolvable names) for Nevada, committed `data/regions.json` on main, and how Canada is meant to fit. Wait for PR #1 to merge and the schema to settle.
1. Shape library and resolver, fed by today's pinned matkam tree with no overrides, producing today's 32 county assignments. Internal only until phase 2 ships; proves equivalence.
2. Any-depth hierarchy and code IDs: chips, scoring, uplink codes v2, observer.json migration. These ship together as 1.2.0, so phase 1 is never released on its own.
3. Switch the pin to MeshCore-Regions-North-America at a merged commit. California + Nevada shapes in the library.
4. Several trees and Canadian shapes, when a BC tree exists.

Phases 1 and 2 do not depend on the new repo, so they can proceed while its schema settles.

## 10. Open questions

1. Will MeshCore-Regions-North-America commit generated JSON on main, as matkam does, and keep it CI-checked?
2. Will codes move to ISO 3166-2 forms (`us-ca`)? That would rename every state code; better to know before phase 3.
3. Should Nevada be organised by population centre (Reno/Carson, Vegas, Elko) rather than county, as Ben suggests? If so its places need custom shapes, not counties.
4. Should backbone tags (for example `#pnw-reno`) be shown at all? They are scopes, not places, so this design recognises them but does not draw them.
5. Decided 2026-10-30: follow the tree's single `centralvalley`; no override.
6. Coverage width. The matkam tree claims all 58 California counties; today's boundary has 32 features (33 counties). If coverage is every place with shapes (§5.3), phase 2 widens it to the whole state, including Southern California. Options: accept it (places with no observers stay hidden anyway), or add a `coverage` list of place codes to the overrides file (for example `norcal`, `sacramentofoothills`, `sierranevada`, `bayarea`, `centralcoast`, `centralvalley`). That list would be the one deliberate, reviewable statement of reach, which is configuration rather than geometry.

## 11. Standing rules this design keeps

Observers outside the boundary are never shown or scored; region outlines stay 2px; colours match bayareameshcore.org and the map layout stays; no network fetch at boot; MQTT ingest, broker resubscribe and droplet config are untouched; the user fires reseeds; nothing is posted upstream without approval.
