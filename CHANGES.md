# Changes

Versions of this fork carry the upstream release they are built on plus a
Bay Area build identity: `1.3.8+bayarea.1` is upstream `v1.3.8` with the Bay Area
adaptation applied. Sections named `vX.Y.Z` alone are upstream's own releases.

## v1.3.8+bayarea.19

- regional test channels. `#healthcheck` stays the promoted channel; a code sent
  to `#<region>-healthcheck` (e.g. `#slo-healthcheck`), where `<region>` is any
  of the 73 scope names, is now heard too. The server cannot read a channel it
  has no name for (a packet carries only a 1-byte hash of the key), so every
  valid name is built at start-up from `MESHCORE_REGION_SCOPES_FILE`; 73 names
  over 66 hash bytes, the 2-byte MAC settles the seven shared bytes. Other
  channels, and names off the list, are still dropped unread. New
  `REGIONAL_TEST_CHANNELS` (default on; off without scope names).
- intended versus heard scope. A session on a regional channel carries
  `intendedScope` (`#slo`) and `scopeCheck` {verdict `as-intended`, `mixed`,
  `not-as-intended`, `unrecorded` or `waiting`; per-copy counts; other names
  heard}. Shown as an `Intended scope:` line under `MeshCore scope:` on the
  dashboard and share page; null and hidden on `#healthcheck`. Display only.
- step 1 adds "Testing a region? Send to #region-healthcheck instead, for
  example #slo-healthcheck" with a collapsible list of region names, from the
  snapshot's `testChannel.regional`.
- service worker cache `mesh-health-check-pwa-v7-bayarea`.

## v1.3.8+bayarea.18

- repeater scope evidence, passive, display only. Two sources from the packets
  in-area observers already publish: the default scope a node's own flood
  adverts carry (`region default`), and the hops in the path of a scoped flood
  packet, which each repeated that scope. Firmware before v1.10 repeats scoped
  packets without checking, so a forwarding hop is evidence, not proof. Hops
  are hash prefixes; candidates are repeaters whose adverts were heard here.
  Kept 7 days in `data/meshcore-scope-evidence.json` (new
  `MESHCORE_SCOPE_EVIDENCE_FILE`), written at most every 30 s. New public
  read-only route `GET /api/meshcore-scope-evidence` (`?all=1` also lists
  advertisers heard without a scope); the snapshot carries
  `scopeEvidence {retentionDays, advertisers, scopedAdvertisers, forwarderHops}`
  and the Observer Reports panel a `Repeater scopes:` line with a link to the
  route. Out-of-area observers contribute nothing. Never changes scoring.
- `mqtt` 5.15.2 to 5.16.1 (`package.json` `^5.16.1`). 5.16.0 fixes six
  broker-side advisories (four High, all reached through MQTT 5; this app
  connects with the library default, MQTT 3.1.1) and drops `number-allocator`
  and `js-sdsl`. Its behaviour changes do not touch this app: it never reads
  negotiated values back off `options`. 5.16.1 reconnects instead of ending a
  client whose stream is already destroyed.
- service worker cache `mesh-health-check-pwa-v6-bayarea`.

## v1.3.8+bayarea.17

- MeshCore routing scope recognition, ported from upstream `7b0fb8b9`,
  `61445069`, `70350c0d` and `ca02b86d`. Each matched receipt records its
  scope: a configured name, `Ambiguous: a or b`, `Scoped, name not listed`,
  `Unscoped`, or `Scoped (name matching off)`. The Observer Reports panel shows
  a `MeshCore scope:` summary with the observer count per label, and each
  receipt card a `Scope:` line. Scopes are kept in retained share results.
  New `MESHCORE_REGION_SCOPES_FILE` reads JSON, not upstream's YAML, so no new
  dependency. `regions/us-ca-meshcore-scopes.json` ships the 73 names of the
  California tree in matkam/meshcore-settings (`us`, `west`, `california`, then
  regions, areas and counties such as `bayarea`, `northbay`, `sonoma`).
  Upstream's change to expire a session on `seenAt >= expiresAt` was not taken.
- region groups renamed to the same tree; boundary and geometry unchanged.
  `Sacramento Valley` is now `Sacramento Foothills` without Butte, which is
  `North California`; `Sierra Foothills` is now `Gold Country` without Alpine,
  which is `Eastern Sierra`. `San Joaquin North` and `San Joaquin South` stay
  separate. The re-seed fingerprint changes, so the first boot re-seeds.
- `express` 5.2.1 to 5.3.0 (`package.json` `^5.3.0`), bringing
  `content-disposition` 2.0.1. `npm audit` reports 0 vulnerabilities.
- new GitLab CI `audit` job: fails on a moderate or worse advisory in
  production dependencies; dev-dependency advisories are printed only.
- service worker cache `mesh-health-check-pwa-v5-bayarea`.

## v1.3.8+bayarea.16

- new public, read-only `GET /api/reseed-status`, so a deploy's boot re-seed can
  be confirmed without `ADMIN_TOKEN`. It reports `enabled`, `hour`, `running`,
  `bootPassPending`, the boot-time region fingerprint, the last seeded
  fingerprint, `upToDate`, and the last pass: counts plus observer names
  (`newlyLocated`, `stillUnlocatedNames`, hash-width `changed` and `examples`,
  each capped at 200). File paths, `dayKey`, and a failure's `error` and
  `stderr` stay on the admin route. It cannot start a pass.
- `seed-observers.py` writes `stillUnlocatedNames` into its summary. Uplinks
  CoreScope places outside the boundary are counted in `stillUnlocatedOutside`
  and never named.
- dependency security update, lock file only (`package.json` unchanged):
  `body-parser` 2.3.0 to 2.4.0 (high: denial of service via trailing bytes after
  a compressed request body), `proxy-addr` 2.0.7 to 2.0.8 (critical: IP spoofing
  through an IPv4-mapped IPv6 trust subnet), `qs` 6.15.2 to 6.17.0 and
  `ip-address` 10.4.0 to 10.7.5 (moderate), with `content-type` 2.1.0 and
  `iconv-lite` 0.7.3. `npm audit` reports 0 vulnerabilities.
- from upstream `6126ea28`, adapted: once a message has landed, a code whose
  receipts carry no RSSI/SNR shows `Signal data unavailable.` instead of
  `Awaiting telemetry.`. The fork keys this on its own `healthMeasured`.
- from upstream `dc3fe057`: CARTO map tiles are requested with
  `referrerPolicy: 'strict-origin'`, so a website-restricted CARTO key receives
  the site origin and never the page path or query. The page-wide
  `Referrer-Policy: no-referrer` is unchanged and OpenStreetMap tiles still send
  no referrer.
- from upstream `9efe04a0`: the service worker no longer lets a failed,
  redirected or HTML response replace a good cached script or stylesheet, serves
  the cached copy on a 500/502/503/504, falls back to the dashboard shell only
  for page navigations (an offline script request now fails rather than receiving
  HTML), and treats cache storage errors as best effort. Cache name moves to
  `mesh-health-check-pwa-v4-bayarea`, so installed apps fetch the new worker.
- tests: `test/sw.test.js` (24 cases, adapted from upstream; 18 fail against the
  previous worker), five reseed-status cases, a signal-label smoke test, and
  referrer assertions on both basemap smoke tests.

## v1.3.8+bayarea.15

- Placer moves from Sierra Foothills to Sacramento Valley. All 22 of its active
  CoreScope repeaters sit west of longitude -121.0 (Roseville, Rocklin, Lincoln,
  Granite Bay), which is the Sacramento metro rather than the foothills. El
  Dorado stays in Sierra Foothills.
- Butte, Sutter and Yuba are added to `regions/us-ca-bay-area.geojson` in
  Sacramento Valley, taking the file from 30 to 33 counties. An observer outside
  the boundary is excluded without notice, and CoreScope now hears 14 repeaters
  in Butte (Chico) and 1 in Yuba. Sutter has none but is the only link between
  Yolo and Butte.
- geometry is TIGERweb `State_County` layer 1, GEOIDs 06007, 06101 and 06115.
  Every border with an existing county, or with one added earlier in this pass
  (order Sutter, Yuba, Butte), uses that neighbour's own vertices, so all seven
  new borders cancel in the dissolve: Sutter with Placer 19 segments, Sacramento
  6, Yolo 189; Yuba with Placer 52, Sutter 177; Butte with Sutter 8, Yuba 201.
  Every other edge is reduced with RDP at 0.0003 degrees, with junction vertices
  pinned. Sutter 586, Yuba 596, Butte 658 vertices, all wound clockwise, zero
  overlap with any county. The other 30 features are byte-identical apart from
  Placer's `group`. The file goes from 21,196 to 23,036 vertices.
- served outlines: Sacramento Valley goes from 1,142 vertices to 2,460 in one
  valid ring, and Sierra Foothills from 1,274 to 1,203 in one valid ring. The
  other regions are unchanged.
- no observer in the production directory changes region. Of CoreScope's
  located nodes, 27 move from Sierra Foothills to Sacramento Valley (Placer),
  and 15 that were outside every county now resolve (14 Butte, 1 Yuba).
- uplink code `AUN` (Auburn, Placer's county seat) moves from Sierra Foothills
  to Sacramento Valley in `regions/us-ca-uplink-codes.json`, so an Auburn
  observer lands in the same group whether or not it publishes a position. It
  stays `anticipated`.
- a changed `REGIONS_FILE` changes the region fingerprint, so the first boot on
  this release arms one observer re-seed pass 60 s after start.
- the comment above `dissolveRings` gives the new cancelling count, 17,524 of
  22,996 segments.
- checks: `npm run check` clean, `npm test` 80/80, `npm run test:smoke` 37/37.

## v1.3.8+bayarea.14

- the dashboard kept a laptop's GPU busy while idle. Three decorative CSS
  animations ran forever (`drift` on `.screen-glow` and `.splash-scene__mesh`,
  `pulse` on `.brand-orb::after`) under 12 panels with
  `backdrop-filter: blur(26px) saturate(140%)`, so every animation frame made
  the compositor re-blur each panel. Measured over 30 s idle in Chromium at
  1512x982, DPR 2, with the production observer directory (35 markers), mean
  of 3 rounds: total browser CPU 101.9% of one core before (GPU process 98.3%,
  11 frames/s reached), 4.7% after (GPU process 1.1%, 60 frames/s).
- the three decorative animations are gone; each element keeps its resting
  position. The status-pill dot `pulse` and the heard-marker `pulseRing` run 3
  times instead of `infinite`. Animations alone took the load to 12.4%.
- `backdrop-filter` is removed from `.command-dock`, `.toolbar`, `.hero-panel`,
  `.glance-card`, `.panel`, `.detail-drawer` and `.splash-scene__badge`, taking
  the load from 12.4% to 4.6%. The panels were already 86% to 88% opaque
  (`--panel`), so the blur behind them barely showed: before/after screenshots
  differ on 0.17% of pixels in dark mode and 0.14% in light, nearly all of it the
  random session code.
- each poll and socket snapshot called `setLatLng`, `setIcon` and `bindPopup` on
  every map marker, rebuilding each icon's DOM and restarting its animation every
  5 s. A marker is now touched only when its position, heard state or popup HTML
  changes.
- the receipts list was emptied and rebuilt on every render, even while
  collapsed inside Additional Information. It is now built off-DOM and swapped in
  with `replaceChildren` only when its markup differs (`commitReceiptList`).
  Clicks are delegated from `document`, so no listeners are lost. With the two
  marker and receipt changes, idle DOM mutations fall from 126.4/s to 26.0/s; the
  CPU difference while idle is within noise.
- `render()` returns early while `document.visibilityState` is `hidden`, keeping
  the snapshot current; the existing `visibilitychange` handler renders on
  return. The 1 s code-life clock is unchanged.
- not changed: `sw.js` and its cache name. `.css` and `.js` are served
  network-first, so open tabs pick up the new styles on the next load. No server,
  data or API change.
- tests: `outlineFraming()` in the dashboard smoke suite now treats a zero-size
  outline as not inside the map. Without the blur the map's pan momentum runs at
  full frame rate and carries the Europe outline wholly off-screen, where Leaflet
  clips it to an empty path whose zero-size box passed the "inside" check, so
  "a region chip zooms to the region outline, a county chip to its observers"
  failed on its last assertion though the map had not snapped back. The previous
  build passed only because the starved compositor cut the pan short; the
  corrected test passes on both builds.
- checks: `npm run check` clean, `npm test` 80/80, `npm run test:smoke` 37/37.
- nothing in this release touches the boundary file, so the region fingerprint
  is unchanged and the first boot arms no observer re-seed.

## v1.3.8+bayarea.13

- region outlines are 2px, down from 3px: `.region-shape` goes from `stroke-width`
  6 to 4, of which the half inside the boundary shows. Two neighbouring outlines
  now make a 4px band along a shared border, not 6px. An outline with no
  neighbour (a coast, the edge of the area) shows about 2.5px, because of the
  mask below.
- a dark hairline of map showed between two neighbouring outlines, often but not
  always, at either width. It is not the data: the served outlines have no gap
  and no overlap between regions, and 96% to 99.9% of each shared land border
  matches its neighbour to within 1 m (median deviation 0.00 m). It is two things at
  draw time. Leaflet simplifies each polygon on its own, at a 1px tolerance, so
  the two copies of a shared border are not quite the same line: at zoom 7 that
  leaves 203 px2 of gap and 185 px2 of overlap along 1,647 px of shared border,
  against 0.0 and 0.0 at tolerance 0. And each outline was clipped to its own
  polygon, and the two clip edges on one line are antialiased separately, so each
  covers part of a boundary pixel and neither all of it: along a diagonal border
  the weakest pixel was 0.786 of full stroke colour, with the geometry exact.
- each outline is now masked, not clipped: the mask is the polygon plus its own
  outline stroked 1px wide (`REGION_MASK_GROW_PX`), so it reaches 0.5px past the
  boundary. Neighbours overlap by a pixel and no pixel is left bare. The mask is
  a `<mask class="region-mask">` with id `region-mask-N`, kept in step with the
  outline's `d` by the same observer the clip used; `clipToInnerStroke` is now
  `maskToInnerStroke`. Before this, in a browser against the live map, the seam
  was gone in the blocks sampled with the mask in place of the clip; this build
  is covered by the tests below.
- not changed: Leaflet's simplification tolerance stays at 1px. Tolerance 0 cost
  nothing measurable (4.6 ms against 4.5 ms to re-project every outline at zoom
  7) but makes the outline paths about 13 times longer (85,111 characters against
  6,294) and, with the mask, is not needed. `shape-rendering: crispEdges` was
  tried and did not help. No server, data or API change.
- tests: new smoke test, at 1440 and 390px, for two same-status triangles
  sharing a diagonal border, sampling the pixels along it: weakest coverage 0.786
  on the previous code, 1.0 now, and 0.787 again with `REGION_MASK_GROW_PX` set
  to 0. The axis-aligned squares in the existing outline test fall on the pixel
  grid and could not show this. That test now checks each outline's `mask` (and
  that it has no `clip-path`), that masks are released with their outlines (3
  masks for 3 outlines, 1 after selecting one region), and probes 1px inside an
  outline, the middle of the 2px stroke, where it probed 1.5px, the middle of the
  3px one.
- checks: `npm run check` clean, `npm test` 80/80, `npm run test:smoke` 37/37.
- nothing in this release touches the boundary file, so the region fingerprint
  is unchanged and the first boot arms no observer re-seed.

## v1.3.8+bayarea.12

- Sierra Foothills drew as three shapes on the coverage map, and San Joaquin
  South carried stray lines through its interior. The server builds one outline
  per region by deleting every county border that two counties of the same region
  trace in opposite directions, so a border only disappears where both sides
  agree exactly. Seven counties in `regions/us-ca-bay-area.geojson` did not:
  Mariposa, Alpine, Fresno, Madera, Kings, Tulare and Kern were each simplified
  on their own, so their borders with neighbours kept different vertices, up to
  about 300 m apart, and they wound counter-clockwise where the other 23 wind
  clockwise. None of their borders cancelled. Mariposa and Alpine were the
  visible ones: their borders with Tuolumne, El Dorado, Amador and Calaveras
  cut them off from the rest of the region.
- each of the seven is now wound clockwise and every border it shares with an
  already-consistent neighbour uses that neighbour's own vertices, fitted in the
  order Fresno, Madera, Tulare, Kings, Kern, Mariposa, Alpine so each was fitted
  to counties already settled. The other 23 features are unchanged. No vertex
  moved more than 86 m (Mariposa) and no county's area changed by more than
  0.016%. The file goes from 21,293 to 21,196 vertices.
- the same mismatch left 407 slivers of gap between counties and 3.3 km2 of
  overlap. A node inside a gap counted as outside every county, and one inside an
  overlap went to whichever county was checked first. Both are now zero. None of
  the 899 located CoreScope nodes and observers tested changes county, so no
  observer's region changes with this release.
- served outlines: Sierra Foothills goes from 2,670 vertices in one invalid ring
  enclosing three areas to 1,274 in one valid ring; San Joaquin South from 1,954
  in an invalid ring to 1,887 in a valid one. The other eight regions are
  unchanged.
- a changed `REGIONS_FILE` changes the region fingerprint, so the first boot on
  this release arms one observer re-seed pass 60 s after start. That is the
  existing behaviour for any boundary edit, not new.
- `regionBoundaryCollection` is exported from `server.js` for the new test, and
  the comment above `dissolveRings` now says neighbours must also wind the same
  way and gives the current cancelling count, 16,220 of 21,160 segments.
- tests: `test/region-outline.test.js` checks every region group's served
  outline for a point visited twice, crossing edges, and edges with the region on
  both sides (an interior border that did not cancel) or neither (a gap). It
  fails on the previous boundary file for Sierra Foothills and San Joaquin South
  and passes on this one. It also caught each of four deliberately broken copies
  of the new file: Mariposa's ring reversed, Alpine restored to its old borders,
  a stretch of Mariposa's border with Tuolumne shifted by about 300 m, and an
  extra county drawn inside El Dorado. Smoke is unchanged at 35.

## v1.3.8+bayarea.11

- a region chip now frames the region's outline rather than the observers
  plotted inside it. A region can list observers with no coordinates, so a
  frame built from the mapped ones showed a fraction of the region, or nothing
  when none were mapped. `selectedRegionFrame()` returns the bounds of the
  selected group's boundary feature, and `boundsKey` names the frame
  (`region:<group>`), so the map refits when the selection changes and not when
  a poll adds or ages out an observer inside it. With no chip selected the frame
  is still the plotted observers.
- region outlines are drawn as inner strokes. Neighbouring regions share
  borders (17 pairs in the Bay Area set) and a stroke centred on the boundary
  painted both regions onto the same pixels, so a red region surrounded by green
  ones could lose most of its outline to whichever was drawn last. Each outline
  is now clipped to its own polygon and drawn at `stroke-width` 6, leaving 3px
  inside the boundary, so neighbours sit side by side along a shared border in
  their own colours at every zoom. The clip is a separate path kept in step with
  Leaflet's redraws by a `MutationObserver` on the outline's `d`; a `<use>` of
  the outline would inherit its `clip-path` and reference itself. Outlines are
  also stacked by status, unknown < all < some < none, instead of by rebuild
  order, so red is always on top.
- a heard receipt whose hops are all 2-byte hashes gets a `Show path on map`
  toggle that draws its path on the coverage map. Points are hops resolved to
  exactly one located node; legs between hops adjacent in the path are solid, and
  legs through hops with no known position are dashed, with the skipped count in
  a tooltip. The path uses the accent colour in its own pane, above the outlines
  and below the observer markers, and takes the map frame while shown. The card
  says the lines are straight lines between known positions, not the radio path,
  and that the sender's position is not part of the path. The selection is
  dropped when a filter or a new code hides the card.
- 1-byte receipts get no toggle, on measurement rather than preference. Over
  3083 receipt paths from the live broker (270 s, 33 observers), 97% of 1-byte
  hops matched several known nodes, and 36% of the 1-byte hops that did resolve
  share their prefix with a CoreScope node outside the app's known set, so a map
  would draw guesses as route. At 2 bytes 89% of hops resolved to a located node
  and 1% shared a prefix. 3-byte receipts are excluded too for now; every one in
  that sample had a gap.
- `receiptPathHops` carries `lat` and `lon` for a hop resolved to exactly one
  located node and `null` otherwise, so an unresolved or ambiguous hop can never
  be given a candidate's position. Hop resolution itself is unchanged.
- tests: smoke coverage at 1440px and 390px for the region-chip frame, the inner
  strokes (pixel samples either side of each shared border, before and after a
  zoom) and the path map (toggle rule, points, solid and dashed legs, framing,
  toggle off, filter drop); unit assertions for hop positions. Smoke is 35 tests,
  up from 30.

## v1.3.8+bayarea.10

- CoreScope moved to `corescope.bayareameshcore.org`. Two live references carried
  the old `corescope.stonekitty.net` host: the `CORESCOPE_URL` fallback in
  `seed-observers.py`, which applies only when the variable is unset, and the
  value in `.env.bayarea.example`. Both now name the new host.
- this changes nothing on a running site by itself. `server.js` reads
  `CORESCOPE_URL` with an empty default, so the dashboard's link base comes
  purely from the deployed `.env`; the served pages follow only once that file
  is updated on the droplet. The seed fallback matters only to a deployment that
  leaves the variable unset.
- `docs/bay-area-adaptation.md` updated in three places: the §4 config block, the
  sentence describing where matched packet hashes link, and the adaptation
  checklist entry. The §5 seeding walkthrough and the quoted `seed-observers.py`
  source keep the old host, being records of runs made against it.
- the new host serves the same data from the same backend: 885 nodes, 717 with a
  position, an identical set of 885 public keys and an identical `counts` block.
  A seed dry run against each host agreed on every figure — 712 inside the
  boundary, 6 discarded, 678 profiles merged, 365 hash widths newly recorded, 10
  cleared, 724 final profiles of which 713 located — differing only in one name
  within a capped sample list. The `#/packets/<hash>`, `#/observers/<KEY>` and
  `#/nodes/<key>` link families were each opened against the new host and render.
- one caveat, unresolved here because it lives in Cloudflare rather than in this
  repo: the new hostname is proxied and a bot rule challenges some clients. A
  plain `curl` receives `403` with `cf-mitigated: challenge` on every path,
  including `/api/nodes`. The seeding pass is unaffected today — `get_json` sends
  `User-Agent: bayarea-health-check-seed/1.0`, which passes, and a real fetch
  returned all 885 nodes — but nothing in the code marks that string as
  load-bearing, and a tighter rule would make the daily pass raise `HTTPError`
  on an HTML body. It would fail before writing, so the store is never at risk.
  A WAF skip rule for the droplet address or for that agent removes the
  dependency.

## v1.3.8+bayarea.9

- the `Copy` button now follows the code on screen rather than merely whether a
  session exists. `render()` set it from `!session`, so a dead code — expired or
  used up — kept a working `Copy` button for the rest of its readable window.
  Since bayarea.8 the page already said `Expired` directly above that button,
  which made the offer to copy read as a contradiction rather than an oversight.
- the rule is derived, not remembered: `isCodeSendable(session)` is true when a
  session exists and its life is neither `expired` nor `used-up`, and it is the
  single predicate behind both the button state and the handler. Nothing
  persists a flag and nothing re-enables the button except a live code being
  rendered, so the awkward cases fall out rather than each needing a branch.
- it is assigned in `renderCodeLife()` ahead of that function's four early
  returns, so every dashboard path reaches it and both callers — the 1s ticker
  and the 5s poll's render — keep it current. Driving it from `render()` alone
  leaves up to five seconds where the code reads `Expired` beside a live button.
- `copyCurrentCode()` repeats the check itself. The disabled attribute is a
  hint, and a stale or tampered one must not put an unsendable code on the
  clipboard. The share page is exempt from both: a shared result is a permanent
  record, and its copy controls are governed by whether there is a link to copy.
- two of the three rules this started from turned out to be wrong, and the
  derived form is what exposed them. `Copy` must not "always" re-enable when
  `New Code` is pressed — a failed mint leaves the dead code on screen — and it
  must not "stay disabled" after a reload, because an expired *unused* code is
  replaced before first paint and the fresh code is copyable. The third rule,
  disable on expiry, holds. A rule set omitting used-up codes covered about a
  third of the reachable states.
- smoke coverage goes 23 to 30. Five of the new tests pin cases a
  transition-based implementation gets wrong, including a used-up code that
  still displays its earned grade, and one samples the button and the countdown
  together across the moment of death so the two can never be seen disagreeing.
- four mutations were run against the new invariant and all four are now caught.
  One of them was not: the poll-only mutation initially passed, and the first
  mutation report calling it caught was wrong. An awaited `toBeDisabled()`
  placed ahead of the sampling loop blocked until the button settled and so
  swallowed the exact window the loop existed to observe; moving the loop before
  it made the catch real. The earlier pass was timing luck.
- three further mistakes were made in the test code and are worth recording
  because each produced a green or red result for the wrong reason. An
  assertion on a stubbed clipboard passed whether or not the stub worked, since
  the recorder starts empty. Twice a `toBeEnabled()` passed because the test had
  flipped the attribute by hand rather than because the session was live, so the
  click that followed correctly refused and the absent copy looked like a defect
  in the code. And a real clipboard write was used at first: Chromium leaves it
  pending on an unfocused document instead of rejecting it, which failed roughly
  half of runs for reasons unrelated to anything under test. The clipboard is
  now stubbed, both clicks are dispatched synchronously, and the test holds over
  ten consecutive runs.
- one incidental confirmation: the flake that first made the handler test hang
  was the ticker taking a hand-forced attribute back off within a second, which
  is the repair behaviour the derived rule is for.

## v1.3.8+bayarea.8

- the dashboard no longer presents a dead session code as a live one. The page
  restored `currentSessionId` from `sessionStorage` and only minted a new code
  when there was no session at all, while `refreshTrackedSessions` dropped a
  session only on HTTP 404 — and `GET /api/sessions/:id` keeps answering for
  `RESULT_RETENTION_SECONDS`. At the deployed settings that is a code accepted
  for 600s inside a window that stays readable for 604800s, so for about 99.9%
  of a session's readable life the old UI would happily show its code as
  current and tell the operator to send it. `MAX_USES_PER_CODE` was a second
  way to reach the same dead end.
- no server change was needed. `serializeSession` already shipped `expiresAt`,
  `status`, `useCount`, `maxUses` and `usesRemaining`, and `/api/bootstrap`
  already shipped `serverTime`; the client discarded all of it.
- the code block now carries its own remaining life: a countdown under the
  code, a warning state in the last 60s, and a dead state that strikes the code
  through and reads `Expired` or `Used up`. The label above the code moves with
  it — `Active Code` / `Expired Code` / `Used-Up Code` — because a tight crop
  during review showed `ACTIVE CODE` sitting directly above a struck-through
  expired code, which is worse than either state alone.
- **the code is never swapped underneath the operator.** Auto-minting on expiry
  and minting on focus were both considered and rejected: someone who has just
  typed the code into a companion app and is walking to a radio must not have
  it changed while their back is turned. The one exception is load time, where
  a code that is both expired and never used is replaced before it is shown,
  since nothing can be waiting on it.
- the remaining life is measured against the server's clock, not the browser's.
  `serverTime` sets a skew that is applied inside a 24h sanity bound, so a tab
  whose clock is minutes fast no longer declares a live code expired; beyond
  24h the skew is ignored rather than trusted.
- the health headline and matched-message line no longer contradict a dead
  code. They read `No result` and `No message was heard before this code
  expired.` instead of `Waiting` and `Waiting for your #health-check message.`
  — but only when nothing was ever measured. A used-up code has a real earned
  grade, and being dead is a fact about the code rather than about the
  measurement, so its grade, observer count, sender and message body all stand.
- the progress ring is deliberately left neutral rather than turned red. Red is
  this app's colour for a network that did not carry the message, and a stale
  code is not a network fault; colouring it would report a failure that did not
  happen.
- step 3 of the instructions, `Return to this page to see your results.`, is
  true again. It only read as a false promise because the dead step 2 stopped
  at the diagnosis, so step 2 now ends by pointing back at the send. No markup
  changed, which avoids keeping a second element in sync across two pages.
- smoke coverage goes 18 to 23. Two rounds of mutation testing each found a
  real hole the passing suite had missed: a mock that returned the same code
  forever hid an auto-swap, and a single-moment assertion on the headline hid a
  5s flicker between `Waiting` and `No result` caused by the 1s ticker racing
  the poll. The expiry test now samples the headline every 250ms across a full
  poll cycle, and `renderCodeLife()` runs last in `render()` so its corrections
  win — that ordering is load-bearing.
- verified end to end against a real server rather than only against route
  mocks: a tab held open across a genuine 60s expiry, a reload afterwards
  minting a fresh code, and a browser clock pushed ten minutes fast leaving the
  countdown correct.
- known limit: the warning threshold is an absolute 60s rather than a fraction
  of the TTL. At the deployed 600s that is the final 10%; at the 60s server
  floor a code would sit in the warning state for its entire life.

## v1.3.8+bayarea.7

- the observer card's hash-width note now reads `2-byte path hash` rather than
  `2-byte path`. Neither of the obvious words was right alone: the note only
  appears when the node's own advert confirmed the width, so it reports that
  node's `path.hash.mode` setting and not the route any message took, which
  argues against `path`; but `prefix` alone sits immediately after the truncated
  key on the same row and reads as an annotation on that string's display width
  rather than on a radio setting. `path hash` is upstream's own term — the
  MeshCore FAQ names `path.hash.mode 1` a 2-byte path hash, and the bytes are a
  public-key prefix a v1.14+ repeater appends before forwarding, not a digest of
  the route — so the card now matches what an operator sees in the app.
- no layout change. The span was already `white-space: nowrap; word-break:
  keep-all`, the exemption added when the break-anywhere rule on
  `.observer-detail` split `2-BYTE PATH` after the hyphen. Measured against the
  real stylesheet at 1440, 390 and 320px: the span grows 103px to 152px, the
  narrowest container is 286px, no horizontal overflow at any width, and the
  detail line's height is unchanged because it was already two lines at 390px.

## v1.3.8+bayarea.6

- the CoreScope seeding pass now also runs about a minute after boot when the
  region inputs have changed since the last successful pass, instead of only on
  the daily `OBSERVER_RESEED_HOUR` schedule. A boundary edit reaches observer
  positions only through a pass, so widening the map used to wait up to a day:
  the 04:00 pass on the day Kern was added ran against the old 28-county file
  and discarded both Kern repeaters, `TEH - Stallion Springs` and
  `The Dale Repeater`, even though CoreScope had coordinates for both.
- the fingerprint covers `REGIONS_FILE` **and** `UPLINK_CODES_FILE`. A code
  moved between the `codes` and `outOfArea` blocks changes which observers are
  in area, and re-running a pass that turns out to change nothing is cheaper
  than reasoning about which edits can matter.
- the boot pass ignores `OBSERVER_RESEED_HOUR` — the trigger is the edit, not
  the clock — but still requires `OBSERVER_RESEED_ENABLED`, so CI, the smoke
  run and sandbox copies never pull CoreScope on boot. It does not consume the
  day's scheduled run, and only a successful pass records its fingerprint, so a
  failure is retried on the next restart rather than marked done. An unreadable
  region file yields no fingerprint rather than a new one, which would otherwise
  fire a pass on every boot.
- `GET /api/admin/reseed` reports `regionFingerprint`, `lastSeededFingerprint`
  and `bootPassPending`. New `OBSERVER_RESEED_BOOT_DELAY_MS` (default 60000).
- on the first deploy carrying this change no log line has a fingerprint yet,
  so the pass fires once regardless of the boundary — the run that finally
  locates the two Kern repeaters, taking located observers 31 to 33.
- `test/reseed-fingerprint.test.js`: five tests over a stub seed script run
  through `/bin/sh`, so the suite needs neither python3 nor CoreScope.

## v1.3.8+bayarea.5

- removed the `Packet Detail` drawer and the click target on receipt cards.
  Everything in it except three fields was already on the card itself, and
  those three - the per-receipt message hash, the raw `A -> B -> C` path
  string, and the hop chip row - are all still printed in the Technical Logs
  drawer's Trace Lines, so nothing is lost from the page
- linked each observer's name on its card to that station's CoreScope
  observer page, and every named repeater in the leg list and the hop chips
  to its CoreScope node page. CoreScope routes the two identities
  case-sensitively for the same public key, so observer links are uppercase
  and node links lowercase; both were confirmed in the rendered UI, where the
  wrong case gives a `Node not found` page rather than a redirect
- a hop links only when its prefix resolved to exactly one station; an
  ambiguous or unknown prefix stays plain text rather than pointing at a
  guess. `pathHops`, `segments` and `skippedHops` now carry the resolved
  node's public key for this, empty when unresolved
- added Mariposa and Alpine counties to the boundary file, both in Sierra
  Foothills. Point-testing all 692 located CoreScope nodes against every
  California county found only six outside the boundary, two of them bad
  data; the rest were `Bullion Repeater` and `Bullion Room (hello)` in
  Mariposa and `SIERRA Lake Alpine` in Alpine, the latter part of the same
  Highway 4 chain that already fills Calaveras. Mariposa was enclosed on
  three sides by counties already in the file
- added `MPI` (Mariposa-Yosemite) as an anticipated code. Alpine County has
  no IATA airport and so gets no code; an unlocated Alpine observer stays
  unclassified rather than being guessed into a group
- left Santa Barbara out despite `Gravel Peak` being the busiest excluded
  node on the broker: Southern California runs MeshCore on a different
  frequency, so those repeaters are noise on this network for now

## v1.3.8+bayarea.4

- reworked the repeater path on receipt cards: the header now reads
  `Estimated path over 14 legs / 16 hops · at least 285 mi`, stating the hops
  spanned separately from the legs drawn whenever a hop in between has no
  known position
- qualified the path total as `at least`: every leg is a great-circle line
  between two located hops, so the sum is a floor on the distance covered and
  never an over-estimate
- added `pathCrowFlies` to receipts, the straight-line distance between the
  first and last located hop, shown on the card as `End to end 96 mi as the
  crow flies` with both endpoints named in its tooltip; it is deliberately not
  derived from the legs, which sum to far more on a path that doubles back
- numbered each leg, in a tabular column so the routes all start at the same
  point and the distances read as a column
- put each leg endpoint's path prefix inline as `Name (HASH)` and dropped the
  separate prefix chip row from the card when legs are present, since it was
  listing the same repeaters a second time; the chip row still renders when
  there are no legs, and the drawer keeps the full raw chain
- replaced the trailing `estimated over N unknown hops` text with a
  subordinate line reading `via N hops with no location:` followed by up to
  three of those hops by identity; segments now carry `skippedHops` with a
  hash and, where the prefix resolved to exactly one observer, a name
- removed the drawer's `Path Distance` stat, which repeated the path total
  without its `at least` qualifier and, when there was no distance, said only
  `not estimated` where the Path Trace section says which hops are missing
  position

## v1.3.8+bayarea.3

- added `locationUpdatedAt` to observer records: stamped only when an
  observer's coordinates actually change (re-announcing the same position
  never bumps it), `null` for an observer with no location, and `null` on
  profiles persisted before this field existed even if they do have a
  location
- published `locationUpdatedAt` in the `/api/bootstrap` observer directory
  alongside each observer's `lat`/`lon`
- added the share page's "Show Additional Information" toggle (previously
  only on the main dashboard) and hid the copy-code button on the share page,
  since a shared result has no code left to copy
- added dedicated Playwright smoke tests for `share.html` in its own project
  and test server (port 3093), covering the new toggle, the hidden copy
  button, and a populated/heard session rendering inside the collapsed
  section

## v1.3.8+bayarea.2

- merged the observer roster into Observer Reports: heard observers keep their
  receipt cards and not-heard observers are appended to the same list, behind an
  `All` / `Heard` / `Not heard` filter
- deleted the standalone Observers panel from `index.html` and `share.html` and
  moved its roster note into Observer Reports
- moved the region filter above the coverage map and extended it to filter the
  map markers as well as the report list
- added named repeater paths and per-leg distances to receipt cards, and fixed
  the leg attribution that credited the wrong hop as the farthest observer
- changed region status dots to true green/yellow/red from `theme-bayarea.css`
  instead of reusing the score palette
- changed observer wording from `seen` to `heard` throughout the interface
- fixed a `share.html` layout regression: the page's `dashboard-grid` carries no
  section class, so it kept the two-column template and stranded 528px in an
  empty observers column at 1440px, plus a zero-height phantom row that doubled
  the panel gap below 1240px
- removed the dead observer CSS left by the panel deletion, 31 rules deleted and
  13 trimmed, and the inert `grid-template-areas` and `grid-template-columns`
  declarations that still referenced the removed `observers` area

## v1.3.8+bayarea.1

- merged upstream `v1.3.8`
- renamed the fork's `CARTO_API_KEY` to upstream's `CARTO_BASEMAP_KEY` and kept
  the old name as a read-only alias so existing `.env` files keep working
- adopted upstream's keyless behaviour: with no CARTO key the dark basemap now
  falls back to OpenStreetMap instead of requesting a watermarked CARTO tile
- published `map.cartoBasemapKey` and `map.darkBasemapAvailable` in
  `/api/bootstrap` alongside the fork's existing per-theme tile URLs
- moved the container runtime to Node `26-slim` and CI to `node:26-bookworm`
- added `npm run docker:tag`, which maps the SemVer build metadata to a legal
  Docker tag (`1.3.8+bayarea.1` -> `1.3.8-bayarea.1`)

## v1.3.8

- added `CARTO_BASEMAP_KEY` support for authenticated CARTO Dark Matter map
  tiles and exposed the public project key through `/api/bootstrap`
- changed dark-theme map rendering to fall back to OpenStreetMap when no CARTO
  key is configured instead of requesting unavailable keyless CARTO tiles
- updated the Docker runtime from Node `22-slim` to `26-slim`

## v1.3.7

- changed the coverage map to follow the active session's expected observer set
  so geographic region and manual observer selections no longer leave unrelated
  directory observers visible on the map
- filtered invalid map coordinates, including the `0,0` no-position sentinel,
  non-numeric values, and coordinates outside valid latitude/longitude ranges
- added browser regression coverage for selected-region map scoping and `0,0`
  observer suppression
- updated `ws` to `8.21.3` and added weekly Dependabot monitoring for the
  Docker base image

## v1.3.6

- updated `@playwright/test` to `1.62.1`, `ws` to `8.21.2`, and
  `actions/setup-node` to `v7`
- updated transitive `ip-address` to `10.4.0` to resolve the npm audit
  advisories affecting IPv4 and IPv6 trust-boundary classification
- made client-address rate limiting honor Express `TRUST_PROXY` handling
  instead of trusting `X-Forwarded-For` independently
- added explicit boolean and numeric `TRUST_PROXY` parsing, including safe
  direct-access operation with `TRUST_PROXY=false`
- restricted the optional external hero link to HTTP(S) URLs before exposing
  it to browser navigation
- changed Docker production dependency installation to deterministic `npm ci`
  lockfile installs

## v1.3.5

- improved observer name learning from MQTT status metadata by using `origin`
  as a fallback name when explicit name fields are absent
- improved decoded MeshCore advert handling so advert names and coordinates are
  saved against the decoded public key, even when another observer received the
  packet
- allowed high-quality decoded advert names to refresh stale saved observer
  names without renaming the MQTT receiver observer
- made dynamic top-observer defaults honor observer retention so stale high-volume
  observers are not selected after they drop out of the dashboard window
- added optional `CORESCOPE_URL` support so matched message hashes can open
  CoreScope `#/packets/<hash>` routes
- added regression coverage with a synthetic Worcester observer advert for
  decoded advert name/location learning and receiver-topic safety
- updated dependency maintenance versions: `mqtt` to `5.15.2`,
  `@playwright/test` to `1.61.1`, and `docker/build-push-action` to `v7`

## v1.3.4

- added `SITE_URL` so Docker/reverse-proxy deployments can generate public
  absolute share links and social preview metadata instead of internal hostnames
- added Dependabot checks for npm and GitHub Actions updates against `dev`
- updated production dependencies: `dotenv` to `17.4.2` and Express to `5.2.1`
- updated the Express catch-all route for Express 5 route parsing compatibility
- updated browser test tooling with `@playwright/test` `1.61.0`
- updated GitHub Actions dependencies: `actions/checkout` to `v7`,
  `actions/setup-node` to `v6`, `docker/setup-buildx-action` to `v4`,
  `docker/login-action` to `v4`, and `docker/metadata-action` to `v6`

## v1.3.3

- fixed retained share links so `/share/:sessionId` pages and session API
  responses are not cached by the browser or service worker
- changed the share button payload to share only the retained result URL so
  paste targets do not prepend extra observer text before the link
- added packet-path distance estimates between known observer hops and a
  longest-packet distance metric, configurable with `DISTANCE_UNIT=mi` or `km`
- added an observer-span fallback for the longest-packet metric when packet
  path hops are not known observers with coordinates
- marked path-distance segments as estimated when they bridge unknown or
  no-coordinate hops between known observer anchors
- added distance labels directly to each `Who saw the message` receipt card,
  falling back to observer-span distance when per-path distance is unavailable
- escaped untrusted observer labels in the receipt timeline and Leaflet map
  popups to prevent CVE-2026-45323-style stored XSS from MeshCore/MQTT names
- updated safe same-major dependency versions for Playwright and MQTT
- updated the PWA service worker cache version and bypassed caching for dynamic
  `/share/` and `/api/` requests
- added API regression coverage for share/session `Cache-Control: no-store`
  behavior
- bumped the app version to `1.3.3`
- reworked the documentation by shortening `README.md`, tightening `HOWTO.md`,
  and moving the complete runtime variable reference into `ENVIRONMENT.md`
- added clone-from-source quick-start steps and published Docker image
  deployment instructions
- updated contributor guidance so env changes and release work keep
  `.env.example`, `ENVIRONMENT.md`, `HOWTO.md`, and `CHANGES.md` in sync

## v1.3.2

- added rolling observer activity tracking in `data/observer-activity.json` so
  the app can rank recent MQTT-connected observers over a configurable time
  window and auto-select the top default target set when `KNOWN_OBSERVERS` is
  blank
- added the observer activity env controls:
  `OBSERVER_ACTIVITY_FILE`, `OBSERVER_TOP_WINDOW_DAYS`, and
  `OBSERVER_TOP_COUNT`
- improved observer name handling so saved observer profile names stay stable
  instead of being too easily replaced by lower-quality live MQTT metadata
- stabilized the Observer Set list so routine live snapshot updates no longer
  reset the list content and scroll position while users are browsing nodes
- refreshed the status and telemetry palette to rely less on red/green
  contrast and work better for color-blind users
- added `OBSERVER_HASH_DISPLAY_BYTES` so the UI can show observer prefixes as
  1-byte, 2-byte, or 3-byte hash labels without changing packet decode rules
- aligned the remaining map-marker and "Scored Against" standby colors with
  the same accessible score-state palette used across the rest of the app
- added non-color seen vs not-seen treatment to map markers and score cards so
  observer state stays distinguishable even when hue alone is not enough
- fixed the `Scored Against` card layout so longer status labels do not
  overlap observer names
- included dependency maintenance updates for `qs` and `express`

## v1.3.1

- bumped `ip-address` from `10.1.0` to `10.2.0`

## v1.3.0

- thank you to @gadgethd for PR #14, which added the region-based observer
  filtering foundation for this release
- added server-side observer region detection from configurable GeoJSON
  boundary files so observers with saved coordinates can be assigned to named
  regions and optional parent groups
- added grouped region-filter controls above the observer selector so users can
  target an entire division such as `New England` or drill into a child region
  such as `Massachusetts`
- added bundled region boundary files for the UK, US states, US Census places,
  Germany, Australia, Canada, and France
- added the new region env vars:
  `REGIONS_FILE`, `REGION_NAME_PROPERTY`, and `REGION_GROUP_PROPERTY`
- added Docker image support for bundled region files so region detection works
  in container deployments, not just local source checkouts
- added flat/no-group fallback handling so custom GeoJSON files without a group
  property still render usable region buttons
- added region hierarchy test coverage for both grouped and flat region
  boundary files
- fixed the "Who saw the message" receipt timeline so the last observer marker
  stays inside the track instead of rendering half off-screen

## v1.2.5

- thank you to @mitchellmoss for the new web UI design that drove this release
- redesigned the dashboard, shared-result page, and landing flow into the new
  control-center UI with the new hero, command, and glance layout
- carried the repeater count feature from `v1.2.4` into the redesigned health
  score cards on both the live dashboard and shared-result view
- updated the shared-result experience to mirror the redesigned dashboard
  instead of using the older score-shell presentation

## v1.2.4

- added a repeater count metric to the health card by extracting unique relay
  hops from matched receipt paths
- exposed the repeater total in both the main dashboard and shared-result
  score cards

## v1.2.3

- fixed receipt-path handling so the app preserves and displays 2-byte and
  3-byte MeshCore hops instead of collapsing terminal observer hops to 1 byte
- added API coverage for both 2-byte and 3-byte path rendering so multi-byte
  route display stays locked in
- changed `OBSERVER_RETENTION_SECONDS=0` to disable stale-observer pruning
  instead of collapsing to the minimum retention window
- stopped decoded packet adverts from renaming observers and started ignoring
  bogus `0,0` coordinates so repeater self-announces do not pollute the
  observer directory
- stopped MQTT `/status` metadata from renaming other observers through
  `origin_id` or `origin`, so only the actual MQTT-connected observer topic
  can update its own identity
- stopped MQTT metadata with a mismatched embedded observer key from assigning
  another node's location to the topic observer, which prevents marker
  pileups at copied coordinates
- merged PR #8 to improve the current health score ring with status-based
  coloring and SVG stroke rendering, avoiding the previous conic-gradient
  artifact
- merged PR #9 to add the optional `data-map-observer-scope="expected"` page
  hook so custom deployments can make the coverage map follow the active
  session scoring set
- linked the footer version label to the repository changelog so users can
  click straight through to `CHANGES.md`
- fixed the shared-result page to use the same SVG score ring markup as the
  main dashboard, keeping the PR #8 score ring rendering consistent across
  both views

## v1.2.2

- changed the coverage map to show all known observers with saved coordinates,
  not just the current target observer set
- added `OBSERVER_RETENTION_SECONDS` so stale observers can drop out of the
  dashboard directory and map after a configurable age
- tightened the matched-message panel so long payloads stop dominating the
  score card while keeping the full message available on hover
- kept configured default observers visible in the selector even when they are
  no longer retained, so the default target set stays aligned with scoring
- updated the target preview and unused-session regeneration flow so changing
  the observer selection immediately updates the next code's scoring target
- expanded API and smoke coverage for retained default observers and
  observer-target retargeting
- fixed the dashboard smoke test to expect the retained empty-map note on a
  fresh boot, which restores GitHub Actions green status for this release

## v1.2.1

- switched runtime packet decoding back to `@michaelhart/meshcore-decoder`
- added a local postinstall compatibility patch so the published decoder still
  loads on Node 18
- fixed Docker build ordering so the decoder postinstall patch is available
  during image builds
- fixed the dashboard `Share` button so supported browsers use the native share
  sheet with the retained `/share/:sessionId` link
- kept clipboard copy as the fallback when the Web Share API is unavailable
- added smoke-test coverage for the browser share flow and retained share link
  payload

## v1.2.0

- added retained share links for session results via `/share/:sessionId`
- added `RESULTS_FILE` and `RESULT_RETENTION_SECONDS` for persisted result storage and expiry control
- added unique code generation across retained session results
- added automatic pruning of expired retained results from `session-results.json`
- added a dashboard `Share` button that copies a retained result link
- added retained result support to Docker with a bind-mounted `data/` directory
- updated docs and API coverage for retained results and share links

## v1.1.1

- added installable browser app support with a web manifest and service worker
- added an `Install App` dashboard button for browsers that expose install prompts
- added Apple touch icon and app-capable metadata to dashboard and landing pages
- added manifest endpoint coverage in API tests
- added `DASH_BROKER_HOST` so the dashboard can show a public broker label
  without exposing the internal MQTT connection host
- updated docs for installable app support and current feature set

## v1.1

- added observer coverage map with dark mode by default and a light-map toggle
- observer markers now show green for observers that saw the matched message and red for observers that did not
- observer coordinates are now learned from MQTT metadata and persisted into `observer.json`
- `observer.json` now supports saved observer profiles with `name`, `lat`, and `lon`
- added observer receipt timeline visualization by first-seen time
- linked matched message hashes directly to the packet analyzer
- added optional env-driven external hero link via `EXTERNAL_LINK_URL` and `EXTERNAL_LINK_LABEL`
- moved the repo reference to a footer note and hard-coded it to the project repository
- added local Leaflet-based map rendering without a CDN dependency
- fixed map tile loading under CSP and fixed tile-layer reload flicker on refresh
- fixed active-session hash alias handling so in-flight receipts do not reset coverage mid-run
- added API coverage for MQTT-learned observer coordinates

## v1.0

- initial standalone release of Mesh Health Check
- Docker-first deployment with `docker compose up`
- local `.env` runtime configuration only
- MQTT ingest and MeshCore packet parsing with `meshcore-decoder-multibyte-patch`
- channel message matching by generated code and message hash
- per-observer receipt tracking with path and radio metrics
- browser-session-only previous check history
- 10-minute code expiration and configurable max uses per code
- public browser UI with internal JSON endpoints for app state
- rate limiting for session creation
- optional Cloudflare Turnstile gate for new code generation
- dedicated Turnstile landing page with redirect into `/app`
- proxy-friendly deployment for Nginx and Cloudflare
- persistent `observer.json` mapping for observer names across restarts
- browser-side custom observer selection for the next generated code
- deployment-wide default observer target set via `KNOWN_OBSERVERS`
- decode scope limited to the configured test channel only
- `LOG_LEVEL=info|debug` runtime logging control
- Node unit tests and GitHub Actions CI for shared helper logic
- fixture-driven packet ingest tests and Playwright smoke tests
