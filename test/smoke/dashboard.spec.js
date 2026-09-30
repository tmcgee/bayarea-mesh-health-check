import { expect, test } from '@playwright/test';

const MAP_TEST_KEYS = {
  target: '1111111111111111111111111111111111111111111111111111111111111111',
  outside: '2222222222222222222222222222222222222222222222222222222222222222',
  zero: '3333333333333333333333333333333333333333333333333333333333333333',
  neighbour: '4444444444444444444444444444444444444444444444444444444444444444',
};

function mapObserver(key, label, lat, lon, region, regionGroup = null) {
  return {
    key,
    hash: key.slice(0, 2),
    label,
    name: label,
    shortKey: `${key.slice(0, 6)}...${key.slice(-6)}`,
    lat,
    lon,
    hasLocation: true,
    region,
    regionGroup,
    isActive: true,
    isRetained: true,
    packetCount: 1,
  };
}

const CARTO_DARK_TEMPLATE = 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png';
const OSM_TEMPLATE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

// The server decides the tile URLs and publishes them in site.map, so the mock
// mirrors what a keyed and a keyless deployment would each send.
function mapTiles(cartoBasemapKey = 'test-carto-key') {
  const keyed = cartoBasemapKey
    ? `${CARTO_DARK_TEMPLATE}?key=${encodeURIComponent(cartoBasemapKey)}`
    : OSM_TEMPLATE;
  return {
    darkTileUrl: keyed,
    lightTileUrl: OSM_TEMPLATE,
    darkAttribution: cartoBasemapKey
      ? '&copy; OpenStreetMap contributors &copy; CARTO'
      : '&copy; OpenStreetMap contributors',
    lightAttribution: '&copy; OpenStreetMap contributors',
    cartoBasemapKey,
    darkBasemapAvailable: Boolean(cartoBasemapKey),
    cartoKeyConfigured: Boolean(cartoBasemapKey),
  };
}

// Mirrors the grouped hierarchy the server derives from the directory. Observers
// without a regionGroup produce no hierarchy at all, which is what the older
// map tests below rely on.
function regionHierarchy(observerDirectory) {
  const groups = new Map();
  observerDirectory.forEach((observer) => {
    if (!observer.regionGroup) {
      return;
    }
    if (!groups.has(observer.regionGroup)) {
      groups.set(observer.regionGroup, { group: observer.regionGroup, count: 0, inferredCount: 0, regions: [] });
    }
    const entry = groups.get(observer.regionGroup);
    // Placed by uplink code alone: no county, so the server tallies it at group
    // level as inferredCount rather than as a located observer.
    if (!observer.region && observer.regionInferred) {
      entry.inferredCount += 1;
      return;
    }
    entry.count += 1;
    const region = entry.regions.find((item) => item.name === observer.region);
    if (region) {
      region.count += 1;
    } else if (observer.region) {
      entry.regions.push({ name: observer.region, count: 1, packetCount: 1 });
    }
  });
  return [...groups.values()];
}

function mapBootstrap(observerDirectory, cartoBasemapKey = 'test-carto-key') {
  return {
    map: mapTiles(cartoBasemapKey),
    site: {
      title: 'MeshCore Observer Coverage',
      eyebrow: 'MeshCore Observer Coverage',
      headline: 'Check your mesh reach.',
      description: 'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.',
      version: '1.3.8+bayarea.2',
      repoUrl: 'https://github.com/yellowcooln/meshcore-health-check',
      changesUrl: 'https://github.com/yellowcooln/meshcore-health-check/blob/main/CHANGES.md',
      map: mapTiles(cartoBasemapKey),
    },
    mqtt: { connected: false, broker: 'mqtt.example.test', topics: ['meshcore/BOS/#'] },
    testChannel: { name: 'health-check', hash: '99' },
    turnstile: { enabled: false, verified: true },
    defaultObserverSource: 'configured',
    defaultObserverKeys: observerDirectory.map((observer) => observer.key),
    defaultObservers: observerDirectory,
    observerDirectory,
    activeObservers: observerDirectory,
    observerStats: {
      activeCount: observerDirectory.length,
      windowSeconds: 900,
      configuredCount: observerDirectory.length,
      retentionSeconds: 0,
      topWindowDays: 7,
      topCount: 10,
      hashDisplayBytes: 1,
      distanceUnit: 'mi',
    },
    availableRegions: [...new Set(observerDirectory.map((observer) => observer.region).filter(Boolean))],
    regionHierarchy: regionHierarchy(observerDirectory),
    results: { retentionSeconds: 604800 },
    // The real payload carries the server's clock, and the code-expiry
    // countdown measures against it rather than the browser's.
    serverTime: Date.now(),
  };
}

// A square boundary for the region outline layer, shaped like the payload
// /api/region-boundaries serves: one feature per region group, carrying the
// group name and nothing else.
function boundaryFeature(group, west, south, east, north) {
  return {
    type: 'Feature',
    properties: { group },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]]],
    },
  };
}

function mapSession(expectedObservers, seenKeys = [], receipts = []) {
  const seen = new Set(seenKeys);
  const now = Date.now();
  return {
    id: 'map-session',
    code: 'MHC-MAP123',
    instructions: 'Send MHC-MAP123 to #health-check',
    status: 'active',
    createdAt: now,
    expiresAt: now + 600000,
    resultExpiresAt: now + 604800000,
    maxUses: 3,
    useCount: 0,
    usesRemaining: 3,
    expectedCount: expectedObservers.length,
    observedCount: 0,
    healthPercent: 0,
    healthLabel: 'POOR',
    expectedObserverSource: 'selected observers',
    expectedObservers: expectedObservers.map((observer) => ({
      key: observer.key,
      hash: observer.hash,
      label: observer.label,
      seen: seen.has(observer.key),
    })),
    receipts,
  };
}

async function openMockMapSession(
  page,
  observerDirectory,
  expectedObservers,
  cartoBasemapKey = 'test-carto-key',
  { seenKeys = [], boundaries = null, receipts = [] } = {},
) {
  await page.addInitScript(() => {
    window.WebSocket = class {
      addEventListener() {}
      close() {}
    };
  });
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mapBootstrap(observerDirectory, cartoBasemapKey)),
  }));
  await page.route('**/api/sessions/map-session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mapSession(expectedObservers, seenKeys, receipts)),
  }));
  await page.route('**/api/region-boundaries', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ type: 'FeatureCollection', features: boundaries || [] }),
  }));
  await page.goto('/share/map-session');
}

test('dashboard loads and creates a session code', async ({ page }) => {
  await page.goto('/app');

  await expect(page).toHaveTitle(/MeshCore Observer Coverage/i);
  await expect(page.getByText('MeshCore Observer Coverage')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Code' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'yellowcooln/meshcore-health-check' })).toBeVisible();
  await expect(page.locator('#session-code')).toContainText('MHC-', { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(page.getByText('Where the observers are')).toBeVisible();
  await expect(page.locator('#map-observer-note')).toContainText('mapped observers reached.');
  await expect(page.locator('#observer-map')).toBeVisible();

  // The observers and reports panels moved inside the collapsed "Show
  // Additional Information" section. The coverage map deliberately stays
  // outside it, so it is visible above without any interaction.
  await expect(page.locator('#observer-reports')).not.toBeVisible();
  await expect(page.locator('#additional-info-label')).toHaveText('Show Additional Information');
  await page.locator('#additional-info-toggle').click();
  await expect(page.locator('#additional-info-label')).toHaveText('Hide Additional Information');
  await expect(page.getByText('Observer Reports')).toBeVisible();
  await expect(page.getByText('Heard and not heard')).toBeVisible();

  // The roster is the list now, so a session that has heard nothing yet shows
  // one not-heard row per rostered observer instead of the old "No observer
  // reports yet." empty state. That string only survives for the no-session
  // case. The counts come from the two observers this project pins.
  await expect(page.locator('#receipts-empty')).toBeHidden();
  await expect(page.locator('#receipts .receipt-card--quiet')).toHaveCount(2);
  await expect(page.locator('#observer-allowlist-note')).toHaveText('2 observers.');
  await expect(page.locator('#receipts-filter .region-btn')).toHaveCount(3);
});

test('the steps carry counter markers and every control wears one coat', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#session-code')).toContainText('MHC-', { timeout: 10000 });

  // The numbering is drawn by a CSS counter, so the copy must not repeat it.
  const steps = page.locator('.session-step');
  await expect(steps).toHaveCount(3);
  for (const text of await steps.allInnerTexts()) {
    expect(text).not.toMatch(/Step \d/);
  }
  const markers = await page.evaluate(() =>
    [...document.querySelectorAll('.session-step')].map((el) => {
      const before = getComputedStyle(el, '::before');
      return { content: before.content, radius: before.borderRadius, colour: before.color };
    }));
  expect(markers.map((m) => m.content)).toEqual(['counter(session-step)', 'counter(session-step)', 'counter(session-step)']);
  markers.forEach((m) => expect(m.radius).toBe('999px'));

  // The channel in step 1 and the code in step 2 are the two things a visitor
  // has to carry to another app, so both are emphasised.
  // The channel name comes from the deployment's own config, so match the shape
  // and the panel's own copy of it rather than pinning the Bay Area value.
  await expect(page.locator('#session-step-channel')).toHaveText(/^#\S+$/);
  const channel = await page.locator('#session-step-channel').innerText();
  await expect(page.locator('#channel-name')).toHaveText(channel);
  const code = await page.locator('#session-code').innerText();
  await expect(page.locator('#session-instructions strong')).toHaveText(code);

  // Nothing is filled in until a message lands.
  await expect(page.locator('#session-status')).toHaveText('--');
  await expect(page.locator('#session-hash')).toHaveText('--');
  await expect(page.locator('#sender-name')).toHaveText('--');

  // One button style across the page: the New Code treatment won. The header
  // utilities keep their smaller padding on purpose - it is the paint that has
  // to match, not the footprint.
  const paint = await page.evaluate(() =>
    ['#new-session-button', '#copy-session-code', '#share-session', '#ui-theme-toggle'].map((sel) => {
      const cs = getComputedStyle(document.querySelector(sel));
      return `${cs.backgroundImage}|${cs.color}|${cs.fontWeight}|${cs.borderRadius}`;
    }));
  expect(new Set(paint).size).toBe(1);

  const box = await page.evaluate(() =>
    ['#new-session-button', '#copy-session-code', '#share-session'].map(
      (sel) => getComputedStyle(document.querySelector(sel)).padding));
  expect(new Set(box).size).toBe(1);
});

test('share button uses the browser share API with the retained share link', async ({ page }) => {
  await page.addInitScript(() => {
    window.__shareCalls = [];
    navigator.share = async (payload) => {
      window.__shareCalls.push(payload);
    };
  });

  await page.goto('/app');
  await expect(page.locator('#session-code')).toContainText('MHC-', { timeout: 10000 });

  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('button', { name: 'Shared' })).toBeVisible();

  const shareCalls = await page.evaluate(() => window.__shareCalls);
  expect(shareCalls).toHaveLength(1);
  expect(shareCalls[0].text).toBeUndefined();
  expect(shareCalls[0].url).toMatch(/^http:\/\/127\.0\.0\.1:3091\/share\/[0-9a-f-]+$/i);
});

// Sharing belongs after the result it offers to share. It used to sit inside the
// Three Easy Steps sequence, above the code, inviting the reader to share results
// that did not exist yet.
test('sharing sits between the coverage map and the collapsed section', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#session-code')).toContainText('MHC-', { timeout: 10000 });

  const positions = await page.evaluate(() => {
    const top = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    };
    return {
      map: top('#coverage-map'),
      share: top('.share-panel'),
      toggle: top('#additional-info-toggle'),
      strandedInSequence: Boolean(document.querySelector('.session-sequence .session-share-invite')),
      buttonInPanel: Boolean(document.querySelector('.share-panel #share-session')),
      noteInPanel: Boolean(document.querySelector('.share-panel #session-share-note')),
    };
  });

  expect(positions.strandedInSequence).toBe(false);
  expect(positions.buttonInPanel).toBe(true);
  expect(positions.noteInPanel).toBe(true);
  expect(positions.map).toBeLessThan(positions.share);
  expect(positions.share).toBeLessThan(positions.toggle);

  // Its own panel now, so the divider rule it used to carry inside the sequence
  // would draw across the full page width for no reason.
  const invite = page.locator('.share-panel .session-share-invite');
  await expect(invite).toHaveCSS('border-top-width', '0px');
});

test('the merged report list is read-only and the code survives opening it', async ({ page }) => {
  await page.goto('/app');

  const sessionCode = page.locator('#session-code');
  await expect(sessionCode).toContainText('MHC-', { timeout: 10000 });
  const initialCode = await sessionCode.textContent();

  await page.locator('#additional-info-toggle').click();
  await expect(page.locator('#observer-reports')).toBeVisible();

  // The standalone Observers panel is gone; its roster is now the tail of this
  // list. There were never any per-observer checkboxes to change here, so
  // opening the section must not mint a new code. What is left is a read-only
  // list plus the heard filter and the roster note.
  await expect(page.locator('#observer-reports input[type="checkbox"]')).toHaveCount(0);
  await expect(page.locator('#observer-allowlist-note')).toContainText('observers');

  await page.waitForTimeout(500);
  await expect(sessionCode).toHaveText(initialCode || '');
});

// The roster note has three branches and this is the least-exercised one: it runs
// only when no roster is configured AND nothing was heard in the active window,
// so the scoring set came from the 7-day ranking instead of live activity. It has
// to say that it is the scoring set, not just recite the ranking rule.
test('roster note explains a target picked by 7-day ranking', async ({ page }) => {
  const directory = Array.from({ length: 10 }, (unused, index) => mapObserver(
    `!top${index}`,
    `Top Observer ${index}`,
    37.8 + index * 0.01,
    -122.27,
    'East Bay',
  ));

  await page.addInitScript(() => {
    window.WebSocket = class {
      addEventListener() {}
      close() {}
    };
  });
  await page.route('**/api/bootstrap', (route) => {
    const payload = mapBootstrap(directory);
    payload.defaultObserverSource = 'top-window';
    payload.observerStats.configuredCount = 0;
    payload.observerStats.activeCount = 0;
    payload.observerStats.topCount = 10;
    payload.observerStats.topWindowDays = 7;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.goto('/app');
  await page.locator('#additional-info-toggle').click();

  const note = page.locator('#observer-allowlist-note');
  await expect(note).toHaveText('Scored against the 10 observers most active over the last 7 days.');
  await expect(note).not.toContainText('Top 10');
});

test('coverage map only plots observers targeted by the selected region', async ({ page }) => {
  const target = mapObserver(MAP_TEST_KEYS.target, 'Target Observer', 42.3601, -71.0589, 'BOS');
  const outside = mapObserver(MAP_TEST_KEYS.outside, 'Outside Observer', 48.8566, 2.3522, 'CDG');

  await openMockMapSession(page, [target, outside], [target]);

  await expect(page.locator('#map-observer-note')).toHaveText('0/1 mapped observers reached.');
  await expect(page.locator('#observer-map .leaflet-marker-icon')).toHaveCount(1);
});

test('region outlines draw under the markers, colour by status, and follow the region filter', async ({ page }) => {
  // Two regions, and the first has two subregions so the drill-down below has
  // something to narrow to.
  const heard = mapObserver(MAP_TEST_KEYS.target, 'Heard Observer', 42.3601, -71.0589, 'Boston', 'North America');
  const quietNear = mapObserver(MAP_TEST_KEYS.neighbour, 'Quiet Neighbour', 42.65, -71.3, 'Lowell', 'North America');
  const quietFar = mapObserver(MAP_TEST_KEYS.outside, 'Quiet Observer', 48.8566, 2.3522, 'Paris', 'Europe');
  const observers = [heard, quietNear, quietFar];

  await openMockMapSession(page, observers, observers, 'test-carto-key', {
    seenKeys: [heard.key],
    boundaries: [
      boundaryFeature('North America', -71.5, 42, -70.5, 42.7),
      boundaryFeature('Europe', 2, 48.5, 2.7, 49.2),
    ],
  });

  const outlines = page.locator('#observer-map path.region-shape');
  await expect(outlines).toHaveCount(2);

  // One outline per region, matching the region chip dots: the region where
  // something was heard is part-green, the silent region is red.
  await expect(page.locator('#observer-map path[data-region-group="North America"]')).toHaveClass(/region-shape--some/);
  await expect(page.locator('#observer-map path[data-region-group="Europe"]')).toHaveClass(/region-shape--none/);

  // Fill is off, so the interior of a region never paints over the basemap or
  // becomes a hit target.
  await expect(outlines.first()).toHaveCSS('fill', 'none');

  // The outlines live in their own pane between the tiles (200) and the markers
  // (600), and that pane takes no pointer events, so observer taps are untouched.
  const panes = await page.evaluate(() => ({
    regions: getComputedStyle(document.querySelector('.leaflet-observerRegions-pane')).zIndex,
    regionsPointerEvents: getComputedStyle(document.querySelector('.leaflet-observerRegions-pane')).pointerEvents,
    markers: getComputedStyle(document.querySelector('.leaflet-marker-pane')).zIndex,
    tiles: getComputedStyle(document.querySelector('.leaflet-tile-pane')).zIndex,
  }));
  expect(Number(panes.tiles)).toBeLessThan(Number(panes.regions));
  expect(Number(panes.regions)).toBeLessThan(Number(panes.markers));
  expect(panes.regionsPointerEvents).toBe('none');

  // A marker still opens its popup with outlines on the map.
  await page.locator('#observer-map .leaflet-marker-icon').first().click();
  await expect(page.locator('.leaflet-popup-content')).toContainText('Heard Observer');

  // Selecting a region leaves only that region's outline on the map.
  await page.locator('.region-btn--group', { hasText: 'Europe' }).first().click();
  await expect(outlines).toHaveCount(1);
  await expect(page.locator('#observer-map path[data-region-group="Europe"]')).toHaveCount(1);
  await expect(page.locator('#observer-map path[data-region-group="North America"]')).toHaveCount(0);

  // Drilling into a subregion narrows the plotted observers but keeps the whole
  // region outlined - the outline describes the region, not the selection.
  await page.locator('.region-btn--group', { hasText: 'North America' }).first().click();
  await expect(page.locator('#observer-map .leaflet-marker-icon')).toHaveCount(2);
  await page.locator('.region-btn--child', { hasText: 'Lowell' }).first().click();
  await expect(page.locator('#observer-map .leaflet-marker-icon')).toHaveCount(1);
  await expect(outlines).toHaveCount(1);
  await expect(page.locator('#observer-map path[data-region-group="North America"]')).toHaveClass(/region-shape--some/);

  await page.locator('.region-btn--all').first().click();
  await expect(outlines).toHaveCount(2);
});

// Screen-space rectangles of a region outline and of the map, for asserting what
// the viewport frames without reaching into Leaflet's module-scoped map.
async function outlineFraming(page, group) {
  return page.evaluate((name) => {
    const path = document.querySelector(`#observer-map path[data-region-group="${name}"]`);
    const map = document.querySelector('#observer-map');
    if (!path || !map) return null;
    const o = path.getBoundingClientRect();
    const m = map.getBoundingClientRect();
    return {
      inside: o.left >= m.left - 1 && o.right <= m.right + 1 && o.top >= m.top - 1 && o.bottom <= m.bottom + 1,
      // How much of the padded viewport the outline fills on its tighter axis.
      // Leaflet snaps to whole zoom levels, so a fitted outline lands between
      // 0.5 and 1; the world view at zoom 2 would be near 0.1.
      fill: Math.max(o.width / (m.width - 52), o.height / (m.height - 52)),
    };
  }, group);
}

test('a region chip zooms to the region outline, a county chip to its observers', async ({ page }) => {
  // Two mapped observers clustered in one corner of a large region, so fitting
  // the markers and fitting the outline give very different views.
  const boston = mapObserver(MAP_TEST_KEYS.target, 'Boston Observer', 42.3601, -71.0589, 'Boston', 'North America');
  const cambridge = mapObserver(MAP_TEST_KEYS.neighbour, 'Cambridge Observer', 42.3736, -71.1097, 'Cambridge', 'North America');
  // A region whose only observer has no coordinates - the empty-region map path.
  const unmapped = {
    ...mapObserver(MAP_TEST_KEYS.outside, 'Unmapped Observer', null, null, null, 'Europe'),
    hasLocation: false,
    regionInferred: true,
  };
  const observers = [boston, cambridge, unmapped];

  await openMockMapSession(page, observers, observers, 'test-carto-key', {
    boundaries: [
      boundaryFeature('North America', -80, 35, -65, 48),
      boundaryFeature('Europe', -5, 43, 8, 51),
    ],
  });
  await expect(page.locator('#observer-map path.region-shape')).toHaveCount(2);

  // Region chip: the whole outline is in view and fills the padded viewport on
  // one axis. Fitting the two markers instead would zoom to 10 and push the
  // outline far past every edge.
  await page.locator('.region-btn--group', { hasText: 'North America' }).first().click();
  await expect.poll(() => outlineFraming(page, 'North America'), { timeout: 5000 })
    .toMatchObject({ inside: true });
  expect((await outlineFraming(page, 'North America')).fill).toBeGreaterThan(0.45);

  // County chip: back to framing its observers, so the outline overflows.
  await page.locator('.region-btn--child', { hasText: 'Boston' }).first().click();
  await expect(page.locator('#observer-map .leaflet-marker-icon')).toHaveCount(1);
  await expect.poll(() => outlineFraming(page, 'North America'), { timeout: 5000 })
    .toMatchObject({ inside: false });

  // "All North America" is the region again, so the outline framing returns.
  await page.locator('.region-btn--child', { hasText: 'All North America' }).first().click();
  await expect.poll(() => outlineFraming(page, 'North America'), { timeout: 5000 })
    .toMatchObject({ inside: true });

  // A region with no mapped observers still moves the map to itself. Before,
  // the map stayed on North America and Europe's outline sat off-screen.
  await page.locator('.region-btn--group', { hasText: 'Europe' }).first().click();
  await expect(page.locator('#map-observer-note')).toHaveText('No mapped observers in Europe.');
  await expect(page.locator('#observer-map .leaflet-marker-icon')).toHaveCount(0);
  await expect.poll(() => outlineFraming(page, 'Europe'), { timeout: 5000 })
    .toMatchObject({ inside: true });
  expect((await outlineFraming(page, 'Europe')).fill).toBeGreaterThan(0.45);

  // A poll re-render with the same selection keeps the user's view: pan away,
  // wait past the 5 s refresh, and the map has not snapped back.
  const map = page.locator('#observer-map');
  const box = await map.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.95, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => outlineFraming(page, 'Europe'), { timeout: 5000 })
    .toMatchObject({ inside: false });
  await page.waitForTimeout(6000);
  expect((await outlineFraming(page, 'Europe')).inside).toBe(false);
});

// Pixel colours from a screenshot of the map, decoded in the page so the suite
// needs no image library. Points are page (CSS) coordinates at DPR 1.
async function sampleMapColours(page, points) {
  const map = page.locator('#observer-map');
  const box = await map.boundingBox();
  // Raw bytes into a Blob: the page's CSP forbids fetching a data: URL.
  const png = [...await map.screenshot()];
  return page.evaluate(async ({ data, origin, pts }) => {
    const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return pts.map(([x, y]) => {
      const px = Math.floor(x - origin.x);
      const py = Math.floor(y - origin.y);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
      return [...ctx.getImageData(px, py, 1, 1).data.slice(0, 3)];
    });
  }, { data: png, origin: { x: box.x, y: box.y }, pts: points });
}

// Nearest named colour, so anti-aliasing and blending never need exact values.
function nearestColour(rgb, palette) {
  if (!rgb) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const [name, ref] of Object.entries(palette)) {
    const distance = ref.reduce((sum, value, index) => sum + (value - rgb[index]) ** 2, 0);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

function parseRgb(css) {
  return (css.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`region outlines stroke inside their own boundary at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // Three abutting squares: a silent (red) region between two heard (green)
    // ones - the case where a centred stroke let one colour hide the other.
    const west = mapObserver(MAP_TEST_KEYS.target, 'West Observer', 0.6, -2, 'West County', 'West');
    const middle = mapObserver(MAP_TEST_KEYS.neighbour, 'Middle Observer', -0.6, 0, 'Middle County', 'Middle');
    const east = mapObserver(MAP_TEST_KEYS.outside, 'East Observer', 0.6, 2, 'East County', 'East');
    const observers = [west, middle, east];
    await openMockMapSession(page, observers, observers, 'test-carto-key', {
      seenKeys: [west.key, east.key],
      boundaries: [
        boundaryFeature('West', -3, -1, -1, 1),
        boundaryFeature('Middle', -1, -1, 1, 1),
        boundaryFeature('East', 1, -1, 3, 1),
      ],
    });
    // Pixel samples read the outlines alone: no basemap, no markers.
    await page.addStyleTag({ content: '.leaflet-tile-pane, .leaflet-marker-pane, .leaflet-shadow-pane { visibility: hidden !important; }' });

    const outline = (group) => page.locator(`#observer-map path.region-shape[data-region-group="${group}"]`);
    await expect(outline('West')).toHaveClass(/region-shape--all/);
    await expect(outline('Middle')).toHaveClass(/region-shape--none/);
    await expect(outline('East')).toHaveClass(/region-shape--all/);
    await page.locator('#observer-map').scrollIntoViewIfNeeded();

    // Draw order puts the most urgent status last (on top), whatever the
    // feature order - Middle arrives second but is drawn last.
    const order = await page.locator('#observer-map path.region-shape').evaluateAll(
      (paths) => paths.map((path) => path.getAttribute('data-region-group')),
    );
    expect(order[order.length - 1]).toBe('Middle');

    // Every outline is masked by its own mask, whose path tracks the outline's
    // geometry and is stroked so as to reach past it.
    const masksInStep = () => page.locator('#observer-map path.region-shape').evaluateAll((paths) => paths.every((path) => {
      const id = (path.getAttribute('mask') || '').match(/url\(#([^)]+)\)/)?.[1];
      const source = id ? document.getElementById(id)?.querySelector('path') : null;
      return Boolean(source) && source.getAttribute('d') === path.getAttribute('d')
        && source.getAttribute('fill-rule') === 'evenodd'
        && Number(source.getAttribute('stroke-width')) > 0
        && !path.hasAttribute('clip-path');
    }));
    expect(await masksInStep()).toBe(true);
    await expect(page.locator('#observer-map mask')).toHaveCount(3);

    const palette = {
      green: parseRgb(await outline('West').evaluate((path) => getComputedStyle(path).stroke)),
      red: parseRgb(await outline('Middle').evaluate((path) => getComputedStyle(path).stroke)),
      background: parseRgb(await page.locator('#observer-map').evaluate((map) => getComputedStyle(map).backgroundColor)),
    };

    // Both sides of each shared border, 1px in (the middle of the 2px inner
    // stroke): each region's own colour. A centred stroke paints one colour across
    // the line and leaves the other side bare. 8px in is past the stroke: bare map.
    const bordersShowBothColours = async () => {
      const rect = await outline('Middle').evaluate((path) => {
        const r = path.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      const y = (rect.top + rect.bottom) / 2;
      const samples = await sampleMapColours(page, [
        [rect.left - 1, y], [rect.left + 1, y], [rect.left + 8, y],
        [rect.right + 1, y], [rect.right - 1, y], [rect.right - 8, y],
      ]);
      return samples.map((rgb) => nearestColour(rgb, palette));
    };
    await expect.poll(bordersShowBothColours, { timeout: 5000 })
      .toEqual(['green', 'red', 'background', 'green', 'red', 'background']);

    // Zooming out rewrites every outline's d; the masks must follow or the
    // strokes are cut away.
    await page.locator('#observer-map .leaflet-control-zoom-out').click();
    await expect.poll(masksInStep, { timeout: 5000 }).toBe(true);
    await expect.poll(bordersShowBothColours, { timeout: 5000 })
      .toEqual(['green', 'red', 'background', 'green', 'red', 'background']);

    // Selected on its own, the red region shows a complete red outline, all of
    // it inside the boundary and nothing outside.
    await page.locator('.region-btn--group', { hasText: 'Middle' }).first().click();
    await expect(page.locator('#observer-map path.region-shape')).toHaveCount(1);
    // The other two outlines' masks went with them.
    await expect(page.locator('#observer-map mask')).toHaveCount(1);
    const ring = async () => {
      const r = await outline('Middle').evaluate((path) => {
        const b = path.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      });
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const samples = await sampleMapColours(page, [
        [r.left + 1, cy], [r.right - 1, cy], [cx, r.top + 1], [cx, r.bottom - 1],
        [r.left - 2, cy], [r.right + 2, cy], [cx, r.top - 2], [cx, r.bottom + 2],
      ]);
      return samples.map((rgb) => nearestColour(rgb, palette));
    };
    await expect.poll(ring, { timeout: 5000 }).toEqual([
      'red', 'red', 'red', 'red',
      'background', 'background', 'background', 'background',
    ]);
  });
}

// Two outlines that share a border, each clipped to its own side, both antialias
// the same edge: where the line does not fall on the pixel grid, each covers only
// part of the pixel and the two partial coverages leave a dark hairline of map
// between two strokes. A diagonal border is off the grid at almost every pixel,
// so it shows what the axis-aligned squares above cannot. Both triangles are the
// same status, so a pixel on the border should read as the stroke colour.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`outlines sharing a diagonal border leave no bare line between them at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const northwest = mapObserver(MAP_TEST_KEYS.target, 'NW Observer', 1.2, -1.2, 'NW County', 'NW');
    const southeast = mapObserver(MAP_TEST_KEYS.neighbour, 'SE Observer', -1.2, 1.2, 'SE County', 'SE');
    const observers = [northwest, southeast];
    const triangle = (group, ring) => ({
      type: 'Feature',
      properties: { group },
      geometry: { type: 'MultiPolygon', coordinates: [[ring]] },
    });
    await openMockMapSession(page, observers, observers, 'test-carto-key', {
      seenKeys: [northwest.key, southeast.key],
      boundaries: [
        triangle('NW', [[-2, -2], [2, 2], [-2, 2], [-2, -2]]),
        triangle('SE', [[-2, -2], [2, -2], [2, 2], [-2, -2]]),
      ],
    });
    await page.addStyleTag({ content: '.leaflet-tile-pane, .leaflet-marker-pane, .leaflet-shadow-pane { visibility: hidden !important; }' });

    const outlines = page.locator('#observer-map path.region-shape');
    await expect(outlines).toHaveCount(2);
    await expect(outlines.first()).toHaveClass(/region-shape--all/);
    await expect(outlines.last()).toHaveClass(/region-shape--all/);
    await page.locator('#observer-map').scrollIntoViewIfNeeded();

    const stroke = parseRgb(await outlines.first().evaluate((path) => getComputedStyle(path).stroke));
    const background = parseRgb(await page.locator('#observer-map').evaluate((map) => getComputedStyle(map).backgroundColor));
    // How much of a pixel is stroke rather than map: 1 is all stroke, 0 is bare.
    // The observers sit symmetrically about (0, 0), so the map is centred there
    // and the border through (0, 0) runs at 45 degrees through the middle of the
    // view, however much of the square the zoom leaves in frame.
    const weakestCoverage = async () => {
      const box = await page.locator('#observer-map').boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const reach = Math.min(box.width, box.height) / 2 - 30;
      const points = [];
      for (let offset = -reach; offset <= reach; offset += reach / 40) {
        points.push([cx + offset, cy - offset]);
      }
      const samples = await sampleMapColours(page, points);
      const axis = stroke.map((value, index) => value - background[index]);
      const span = axis.reduce((sum, value) => sum + value * value, 0);
      const coverage = samples.map((rgb) => (rgb
        ? rgb.reduce((sum, value, index) => sum + (value - background[index]) * axis[index], 0) / span
        : 1));
      return Math.min(...coverage);
    };
    await expect.poll(weakestCoverage, { timeout: 5000 }).toBeGreaterThan(0.92);
  });
}

// A heard receipt with the fields the card and the path map read. Hops carry a
// position only when the server resolved them to exactly one located node.
function pathReceipt(observer, hops, firstSeenAt) {
  return {
    observerKey: observer.key,
    observerLabel: observer.label,
    observerHash: observer.key.slice(0, 4).toUpperCase(),
    observerShortKey: observer.shortKey,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    count: 1,
    path: hops.map((hop) => hop.hash),
    pathHops: hops.map((hop, index) => ({
      hash: hop.hash,
      label: hop.label || hop.hash,
      key: hop.key || '',
      resolved: Boolean(hop.key),
      hasLocation: hop.lat != null,
      lat: hop.lat ?? null,
      lon: hop.lon ?? null,
      isTerminal: index === hops.length - 1,
    })),
  };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`a 2-byte receipt path is drawn on the coverage map at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const west = mapObserver(MAP_TEST_KEYS.target, 'West Observer', 0, 2, 'West County', 'West');
    const east = mapObserver(MAP_TEST_KEYS.outside, 'East Observer', 0.5, 6, 'East County', 'East');
    const now = Date.now();
    const twoByte = pathReceipt(west, [
      { hash: 'AAAA', label: 'Alpha Rptr', key: 'a'.repeat(64), lat: 0, lon: -2 },
      { hash: 'BBBB' },
      { hash: 'CCCC', label: 'Charlie Rptr', key: 'c'.repeat(64), lat: 0, lon: 0 },
      { hash: '1111', label: west.label, key: west.key, lat: 0, lon: 2 },
    ], now - 5000);
    // Every hop located, but 1-byte: no map is offered.
    const oneByte = pathReceipt(east, [
      { hash: 'AA', label: 'Alpha Rptr', key: 'a'.repeat(64), lat: 0, lon: -2 },
      { hash: '22', label: east.label, key: east.key, lat: 0.5, lon: 6 },
    ], now - 4000);
    await openMockMapSession(page, [west, east], [west, east], 'test-carto-key', {
      seenKeys: [west.key, east.key],
      receipts: [twoByte, oneByte],
    });
    await page.locator('#additional-info-toggle').click();

    const card = (label) => page.locator('#receipts .receipt-card', { hasText: label });
    const westButton = card('West Observer').locator('[data-receipt-path]');
    await expect(westButton).toHaveText('Show path on map');
    await expect(westButton).toHaveAttribute('aria-pressed', 'false');
    await expect(card('East Observer').locator('[data-receipt-path]')).toHaveCount(0);
    await expect(page.locator('#observer-map .receipt-path-point')).toHaveCount(0);

    await westButton.click();
    await expect(westButton).toHaveText('Hide path on map');
    await expect(westButton).toHaveAttribute('aria-pressed', 'true');
    await expect(card('West Observer').locator('.receipt-map-note')).toContainText(
      'straight lines between the 3 of 4 hops with a known position, not the radio path',
    );

    // Three located hops, BBBB has no position: Alpha to Charlie is dashed
    // because it passes through it, Charlie to the observer is solid.
    const points = page.locator('#observer-map .receipt-path-point');
    await expect(points).toHaveCount(3);
    await expect(page.locator('#observer-map .receipt-path-point--first')).toHaveCount(1);
    await expect(page.locator('#observer-map .receipt-path-point--observer')).toHaveCount(1);
    const legs = page.locator('#observer-map path.receipt-path-leg');
    await expect(legs).toHaveCount(2);
    expect(await legs.evaluateAll((paths) => paths.map((path) => path.classList.contains('receipt-path-leg--gap'))))
      .toEqual([true, false]);
    expect(await page.locator('#observer-map .receipt-path-leg--gap').evaluate((path) => getComputedStyle(path).strokeDasharray))
      .not.toBe('none');

    // The map frames the path: every point inside the map. Map and points are
    // measured in one evaluate, polled, because the toggle may still be
    // smooth-scrolling the map into view.
    const pointsInsideMap = () => page.evaluate(() => {
      const map = document.querySelector('#observer-map').getBoundingClientRect();
      return [...document.querySelectorAll('#observer-map .receipt-path-point')].every((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return x > map.left && x < map.right && y > map.top && y < map.bottom;
      });
    });
    await expect.poll(pointsInsideMap, { timeout: 5000 }).toBe(true);

    // Toggling off removes it.
    await westButton.click();
    await expect(westButton).toHaveText('Show path on map');
    await expect(points).toHaveCount(0);
    await expect(legs).toHaveCount(0);

    // A region filter that hides the card drops the path with it, and clearing
    // the filter does not bring it back.
    await westButton.click();
    await expect(points).toHaveCount(3);
    await page.locator('.region-btn--group', { hasText: 'East' }).first().click();
    await expect(card('West Observer')).toHaveCount(0);
    await expect(points).toHaveCount(0);
    await page.locator('#region-filter .region-btn', { hasText: 'All' }).first().click();
    await expect(card('West Observer').locator('[data-receipt-path]')).toHaveText('Show path on map');
    await expect(points).toHaveCount(0);
  });
}

test('coverage map omits observers with 0,0 coordinates', async ({ page }) => {
  const target = mapObserver(MAP_TEST_KEYS.target, 'Target Observer', 42.3601, -71.0589, 'BOS');
  const zero = mapObserver(MAP_TEST_KEYS.zero, 'Zero Observer', 0, 0, 'BOS');

  await openMockMapSession(page, [target, zero], [target, zero]);

  await expect(page.locator('#map-observer-note')).toHaveText('0/1 mapped observers reached.');
  await expect(page.locator('#observer-map .leaflet-marker-icon')).toHaveCount(1);
});

test('dark coverage map requests CARTO tiles with the configured key', async ({ page }) => {
  const target = mapObserver(MAP_TEST_KEYS.target, 'Target Observer', 37.8044, -122.2712, 'East Bay');
  const cartoRequests = [];
  await page.route('https://*.basemaps.cartocdn.com/**', async (route) => {
    cartoRequests.push(route.request().url());
    await route.abort();
  });

  await openMockMapSession(page, [target], [target]);

  await expect.poll(() => cartoRequests.length).toBeGreaterThan(0);
  expect(cartoRequests[0]).toContain('dark_all');
  expect(cartoRequests[0]).toContain('key=test-carto-key');
  // CARTO does serve a fourth subdomain, so the layer is entitled to use it.
  const cartoHosts = new Set(cartoRequests.map((url) => new URL(url).host));
  for (const host of cartoHosts) {
    expect(host).toMatch(/^[abcd]\.basemaps\.cartocdn\.com$/);
  }
});

test('dark dashboard falls back to OpenStreetMap without a CARTO key', async ({ page }) => {
  const target = mapObserver(MAP_TEST_KEYS.target, 'Target Observer', 37.8044, -122.2712, 'East Bay');
  const cartoRequests = [];
  const osmRequests = [];
  await page.route('https://*.basemaps.cartocdn.com/**', async (route) => {
    cartoRequests.push(route.request().url());
    await route.abort();
  });
  await page.route('https://*.tile.openstreetmap.org/**', async (route) => {
    osmRequests.push(route.request().url());
    await route.abort();
  });

  await openMockMapSession(page, [target], [target], '');

  await expect.poll(() => osmRequests.length).toBeGreaterThan(0);
  expect(cartoRequests).toHaveLength(0);
  // d.tile.openstreetmap.org has no DNS record, so requesting it means roughly a
  // quarter of the basemap silently fails to load for real users. The layer used
  // to hardcode CARTO's 'abcd' for both providers.
  const osmHosts = [...new Set(osmRequests.map((url) => new URL(url).host))].sort();
  expect(osmHosts).not.toContain('d.tile.openstreetmap.org');
  for (const host of osmHosts) {
    expect(host).toMatch(/^[abc]\.tile\.openstreetmap\.org$/);
  }
});

// The lede is prose with an inline channel chip in the middle. It was styled by a
// rule shared with .session-share-invite, which made the paragraph a flex
// container: its three spans became flex items, so a 390px viewport rendered them
// as three ragged columns and desktop showed 16px holes around the chip.
test('hero lede stays one text flow with the channel chip inline', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app');
    const lede = page.locator('.dock-lede').first();
    await expect(lede).toBeVisible();

    const layout = await lede.evaluate((el) => ({
      display: getComputedStyle(el).display,
      chipDisplay: getComputedStyle(el.querySelector('#hero-channel')).display,
      spanTops: [...el.children].map((child) => child.getBoundingClientRect().top),
    }));
    expect(layout.display).toBe('block');
    expect(layout.chipDisplay).toBe('inline');
    // Columns would put each span at the same top offset; a text flow does not.
    expect(new Set(layout.spanTops).size).toBeGreaterThan(1);

    // No space before the comma that resumes the sentence after the chip, which
    // also denies the browser a break that would start a line with a comma.
    const text = (await lede.innerText()).replace(/\s+/g, ' ');
    expect(text).toContain('#health-check, and watch');
  }
});

test('footer entries break between items, never inside one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/app');
  const entries = page.locator('.site-footer .footer-entry');
  await expect(entries).toHaveCount(2);

  const tops = [];
  for (const entry of await entries.all()) {
    // An entry spans several inline boxes (its label text plus its link), so
    // count the distinct line tops rather than the rects: one line top means the
    // entry did not wrap, whatever it is made of internally.
    const box = await entry.evaluate((el) => ({
      whiteSpace: getComputedStyle(el).whiteSpace,
      lineTops: [...new Set([...el.getClientRects()].map((rect) => Math.round(rect.top)))],
    }));
    expect(box.whiteSpace).toBe('nowrap');
    expect(box.lineTops).toHaveLength(1);
    tops.push(box.lineTops[0]);
  }

  // At 390px the two entries do not fit side by side, so the break has to land
  // between them. Previously it landed inside the second one, stranding the
  // "Source:" label a line above its repo slug.
  expect(new Set(tops).size).toBe(2);
});

test('escapes untrusted observer labels in timeline and map popups', async ({ page }) => {
  const maliciousLabel = '<img src=x onerror="window.__meshHealthXssHit=true">Evil Observer';
  const observerKey = 'AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B';
  const now = Date.now();
  const session = {
    id: 'xss-session',
    code: 'MHC-XSS123',
    instructions: 'Send MHC-XSS123 to #health-check',
    status: 'active',
    createdAt: now,
    expiresAt: now + 600000,
    resultExpiresAt: now + 604800000,
    maxUses: 3,
    useCount: 1,
    usesRemaining: 2,
    expectedCount: 1,
    observedCount: 1,
    healthPercent: 100,
    healthLabel: 'VERY HEALTHY',
    messageHash: 'ABCDEF1234567890',
    messageBody: 'malicious label check',
    sender: 'Tester',
    channelName: 'health-check',
    shareUrl: 'http://127.0.0.1:3091/share/xss-session',
    expectedObserverSource: 'configured',
    expectedObservers: [{
      key: observerKey,
      hash: 'AF',
      label: maliciousLabel,
      seen: true,
    }],
    receipts: [{
      observerKey,
      observerHash: 'AF',
      observerShortKey: 'AF07FC...D11A2B',
      observerLabel: maliciousLabel,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      messageHash: 'ABCDEF1234567890',
      rssi: -45,
      snr: 8,
      duration: 125,
      path: ['AF07'],
    }],
  };

  await page.addInitScript(() => {
    window.__meshHealthXssHit = false;
    window.WebSocket = class {
      addEventListener() {}
      close() {}
    };
  });
  await page.route('**/api/bootstrap', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        site: {
          title: 'MeshCore Observer Coverage',
          eyebrow: 'MeshCore Observer Coverage',
          headline: 'Check your mesh reach.',
          description: 'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.',
          version: '1.3.5',
          coreScopeUrl: 'https://analyzer.example.test',
          repoUrl: 'https://github.com/yellowcooln/meshcore-health-check',
          changesUrl: 'https://github.com/yellowcooln/meshcore-health-check/blob/main/CHANGES.md',
        },
        mqtt: {
          connected: false,
          broker: 'mqtt.example.test',
          topics: ['meshcore/SITE/#'],
        },
        testChannel: {
          name: 'health-check',
          hash: '99',
        },
        turnstile: {
          enabled: false,
          verified: true,
        },
        defaultObserverSource: 'configured',
        defaultObservers: [{
          key: observerKey,
          hash: 'AF',
          label: maliciousLabel,
          name: maliciousLabel,
          shortKey: 'AF07FC...D11A2B',
          lat: 42.3601,
          lon: -71.0589,
          hasLocation: true,
          isActive: true,
          isRetained: true,
          packetCount: 1,
        }],
        observerDirectory: [{
          key: observerKey,
          hash: 'AF',
          label: maliciousLabel,
          name: maliciousLabel,
          shortKey: 'AF07FC...D11A2B',
          lat: 42.3601,
          lon: -71.0589,
          hasLocation: true,
          isActive: true,
          isRetained: true,
          packetCount: 1,
        }],
        observerStats: {
          activeCount: 1,
          windowSeconds: 900,
          configuredCount: 1,
          retentionSeconds: 0,
          topWindowDays: 7,
          topCount: 10,
          hashDisplayBytes: 1,
          distanceUnit: 'mi',
        },
        availableRegions: [],
        regionHierarchy: [],
        results: {
          retentionSeconds: 604800,
        },
      }),
    });
  });
  await page.route('**/api/sessions', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(session),
    });
  });

  await page.goto('/app');
  await expect(page.locator('#session-code')).toHaveText('MHC-XSS123');
  await expect(page.locator('#session-hash')).toHaveAttribute(
    'href',
    'https://analyzer.example.test/#/packets/abcdef1234567890',
  );
  await expect(page.locator('#receipts')).toContainText('Evil Observer');
  await expect(page.locator('#receipts img')).toHaveCount(0);
  await expect(page.locator('#observer-reports img')).toHaveCount(0);

  await page.locator('.leaflet-marker-icon').first().click();
  await expect(page.locator('.leaflet-popup-content')).toContainText('Evil Observer');
  await expect(page.locator('.leaflet-popup-content img')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__meshHealthXssHit)).toBe(false);
});

// --- Session code lifetime -------------------------------------------------
//
// A code stops being accepted at expiresAt, but the server keeps the session
// readable for the whole result-retention window, so the page could hold a
// dead code on screen for days without saying so. These cover what the page
// now says about that, and - just as importantly - what it refuses to do.

function lifeSession(overrides = {}) {
  const code = overrides.code || 'MHC-LIFE01';
  return {
    id: 'life-session',
    code,
    instructions: `Send the code ${code} to the #health-check channel.`,
    status: 'waiting',
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 600000,
    resultExpiresAt: Date.now() + 604800000,
    maxUses: 3,
    useCount: 0,
    usesRemaining: 3,
    matchedAt: 0,
    expectedCount: 0,
    observedCount: 0,
    repeaterCount: 0,
    healthPercent: 0,
    healthLabel: 'Waiting',
    healthMeasured: false,
    expectedObserverSource: 'active observers',
    expectedObservers: [],
    receipts: [],
    ...overrides,
  };
}

// Routes the dashboard's three session calls. `buildSession` is a builder
// rather than a value so each poll re-serialises against the current clock
// while the absolute expiresAt inside it stays put.
//
// The create endpoint hands back the intended session the first time and a
// loudly different code every time after that. The page is supposed to mint
// exactly once, at load; any second mint puts MHC-SWAPPD on screen and fails
// whichever assertion named the real code. Without that the swap tests pass
// vacuously - a mock that returns the same code forever cannot tell a page
// that kept its code from one that replaced it with an identical one.
async function openCodeLifePage(page, buildSession, { preseedId = '' } = {}) {
  const swapped = () => lifeSession({ id: 'swapped-session', code: 'MHC-SWAPPD' });
  let mints = 0;
  await page.addInitScript((sessionId) => {
    window.WebSocket = class {
      addEventListener() {}
      close() {}
    };
    if (sessionId) {
      sessionStorage.setItem('mesh-health-check-session-id', sessionId);
      sessionStorage.setItem('mesh-health-check-session-history', JSON.stringify([sessionId]));
    }
  }, preseedId);
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mapBootstrap([])),
  }));
  await page.route('**/api/sessions', (route) => {
    mints += 1;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(mints === 1 ? buildSession() : swapped()),
    });
  });
  await page.route('**/api/sessions/*', (route) => {
    const id = route.request().url().split('/').pop();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id === 'swapped-session' ? swapped() : buildSession()),
    });
  });
  await page.goto('/app');
}

test('a live code shows a countdown and no dead styling', async ({ page }) => {
  await openCodeLifePage(page, () => lifeSession());

  await expect(page.locator('#session-code')).toHaveText('MHC-LIFE01');
  await expect(page.locator('#session-code-expiry')).toBeVisible();
  await expect(page.locator('#session-code-expiry')).toContainText(/^Expires in \d+:\d\d$/);
  await expect(page.locator('#session-code-expiry')).not.toHaveClass(/is-dead/);
  await expect(page.locator('#session-code')).not.toHaveClass(/is-dead/);
  await expect(page.locator('#session-instructions')).toContainText('Send the code MHC-LIFE01');
  await expect(page.locator('#session-code-label')).toHaveText('Active Code');
  // A live code is genuinely still waiting, so the headline says so.
  await expect(page.locator('#health-label')).toHaveText('Waiting');
  await expect(page.locator('#message-preview')).toContainText('Waiting for your');
});

// The regression guard for the whole change. A code that dies while the page
// is open must be reported, never replaced: swapping it under someone who has
// already sent it is the exact failure this work exists to prevent.
test('a code that expires while the page is open is marked dead, not swapped', async ({ page }) => {
  const expiresAt = Date.now() + 3000;
  await openCodeLifePage(page, () => lifeSession({ expiresAt }));

  await expect(page.locator('#session-code')).toHaveText('MHC-LIFE01');
  await expect(page.locator('#session-code')).not.toHaveClass(/is-dead/);

  await expect(page.locator('#session-code-expiry')).toHaveText('Expired', { timeout: 10000 });
  await expect(page.locator('#session-code')).toHaveClass(/is-dead/);
  await expect(page.locator('#session-status')).toHaveText('EXPIRED');
  await expect(page.locator('#session-instructions'))
    .toHaveText('This code is no longer accepted. Press New Code and send the fresh one.');
  // Nothing adjacent may still call it active.
  await expect(page.locator('#session-code-label')).toHaveText('Expired Code');
  // Step 2 now ends with the send, so step 3 is true as written and stays put.
  await expect(page.locator('.session-steps__list li').nth(2))
    .toHaveText('Return to this page to see your results.');
  // Nothing is coming for this code, so the page stops saying it is waiting.
  await expect(page.locator('#health-label')).toHaveText('No result');
  await expect(page.locator('#message-preview'))
    .toHaveText('No message was heard before this code expired.');

  // And it has to STAY said. The correction has two independent callers - the
  // one-second ticker and the five-second poll's render - and if render applied
  // it before writing the headline rather than after, the poll would put
  // "Waiting" back and the ticker would undo it a second later. A single-moment
  // assertion cannot see that; sampling across a full poll cycle can. Any value
  // other than 'No result' turning up here is that flicker.
  const seen = new Set();
  const deadline = Date.now() + 6500;
  while (Date.now() < deadline) {
    seen.add((await page.locator('#health-label').textContent())?.trim());
    await page.waitForTimeout(250);
  }
  expect([...seen]).toEqual(['No result']);
  // The point of the test: same code, still on screen, nothing minted behind it.
  await expect(page.locator('#session-code')).toHaveText('MHC-LIFE01');
});

// A code cannot run out of uses without messages having landed on it, so this
// state always carries a real result. Being dead is a fact about the code, not
// about the measurement, and the grade it earned has to survive saying so.
test('a code with no uses left reads as used up and keeps the result it earned', async ({ page }) => {
  await openCodeLifePage(page, () => lifeSession({
    expiresAt: Date.now() + 600000,
    useCount: 3,
    usesRemaining: 0,
    matchedAt: Date.now() - 500,
    status: 'matched',
    healthMeasured: true,
    healthRated: true,
    healthLabel: 'FAIR',
    healthPercent: 55,
    observedCount: 2,
    expectedCount: 4,
    minScoringSet: 3,
    sender: 'N6ABC',
    messageBody: 'MHC-LIFE01 test transmission',
  }));

  await expect(page.locator('#session-code-expiry')).toHaveText('Used up');
  await expect(page.locator('#session-status')).toHaveText('USED UP');
  await expect(page.locator('#session-code')).toHaveClass(/is-dead/);
  await expect(page.locator('#session-instructions')).toContainText('used the maximum number of times');
  await expect(page.locator('#session-code-label')).toHaveText('Used-Up Code');

  // The measurement is untouched by the code being dead.
  await expect(page.locator('#health-label')).toHaveText('FAIR');
  await expect(page.locator('#observed-count')).toHaveText('2 / 4');
  await expect(page.locator('#message-preview')).toHaveText('MHC-LIFE01 test transmission');
});

// The one case where replacing the code is right: nothing is in flight against
// a code that expired unused before the page was even opened.
test('an expired unused code restored on load is replaced with a fresh one', async ({ page }) => {
  const stale = () => lifeSession({ expiresAt: Date.now() - 60000 });
  const fresh = () => lifeSession({ id: 'fresh-session', code: 'MHC-FRESH1' });

  await page.addInitScript(() => {
    window.WebSocket = class {
      addEventListener() {}
      close() {}
    };
    sessionStorage.setItem('mesh-health-check-session-id', 'life-session');
    sessionStorage.setItem('mesh-health-check-session-history', JSON.stringify(['life-session']));
  });
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mapBootstrap([])),
  }));
  let mints = 0;
  await page.route('**/api/sessions', (route) => {
    mints += 1;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(fresh()),
    });
  });
  await page.route('**/api/sessions/*', (route) => {
    const id = route.request().url().split('/').pop();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id === 'fresh-session' ? fresh() : stale()),
    });
  });
  await page.goto('/app');

  await expect(page.locator('#session-code')).toHaveText('MHC-FRESH1');
  await expect(page.locator('#session-code')).not.toHaveClass(/is-dead/);
  await expect(page.locator('#session-code-expiry')).toContainText(/^Expires in \d+:\d\d$/);
  // Once, at load - not once per poll. The replacement is a load-time repair,
  // and a page that keeps minting is a page burning codes in the background.
  await page.waitForTimeout(2500);
  expect(mints).toBe(1);
});

// ---------------------------------------------------------------------------
// Copy button. The rule is one derived invariant - Copy is enabled exactly
// when a session exists and its code is still sendable - rather than a set of
// remembered transitions. These tests exist mostly to pin the cases a
// transition-based implementation gets wrong.
// ---------------------------------------------------------------------------

test('Copy is enabled while the code lives and never survives its death', async ({ page }) => {
  const expiresAt = Date.now() + 3000;
  await openCodeLifePage(page, () => lifeSession({ expiresAt }));
  const copy = page.locator('#copy-session-code');

  await expect(copy).toBeEnabled();

  // The countdown is driven by the one-second ticker and the button state is
  // written in the same pass. Set the button from render() alone and there is
  // a window of up to five seconds where the code reads Expired while Copy
  // still works - invisible to a single-moment assertion, so sample instead.
  //
  // The sampling has to start before the code dies and run straight through
  // the death. An awaited toBeDisabled() placed here instead would block until
  // the button settles and so swallow the exact window this is looking for -
  // which it did, and the mutation that proves this test works went
  // undetected until the loop was moved ahead of it.
  const disagreements = [];
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const label = (await page.locator('#session-code-expiry').textContent())?.trim();
    const enabled = await copy.isEnabled();
    if (label === 'Expired' && enabled) {
      disagreements.push(`${Date.now()} Expired but Copy enabled`);
    }
    await page.waitForTimeout(200);
  }
  expect(disagreements).toEqual([]);

  // And it really did die during that window, so the loop was not watching a
  // still-live code and passing for nothing.
  await expect(page.locator('#session-code-expiry')).toHaveText('Expired');
  await expect(copy).toBeDisabled();
});

// Expiry is not the only way a code dies. This one has a real grade, so any
// implementation keying off "expired" or off the absence of a result leaves
// Copy enabled on a code the server will refuse.
test('Copy is disabled for a used-up code that still shows its grade', async ({ page }) => {
  await openCodeLifePage(page, () => lifeSession({
    expiresAt: Date.now() + 600000,
    useCount: 3,
    usesRemaining: 0,
    matchedAt: Date.now() - 500,
    status: 'matched',
    healthMeasured: true,
    healthRated: true,
    healthLabel: 'FAIR',
    healthPercent: 55,
    observedCount: 2,
    expectedCount: 4,
    sender: 'N6ABC',
    messageBody: 'MHC-LIFE01 test transmission',
  }));

  await expect(page.locator('#session-code-expiry')).toHaveText('Used up');
  await expect(page.locator('#copy-session-code')).toBeDisabled();
  // The grade is still on screen; only the code is dead.
  await expect(page.locator('#health-label')).toHaveText('FAIR');
});

// The case a "stays disabled after reload" rule gets backwards. The code was
// expired and unused, so it is replaced before first paint - and a fresh code
// must be copyable.
test('Copy is enabled after a reload replaces an expired unused code', async ({ page }) => {
  const stale = () => lifeSession({ expiresAt: Date.now() - 60000 });
  const fresh = () => lifeSession({ id: 'fresh-session', code: 'MHC-FRESH1' });

  await page.addInitScript(() => {
    window.WebSocket = class { addEventListener() {} close() {} };
    sessionStorage.setItem('mesh-health-check-session-id', 'life-session');
    sessionStorage.setItem('mesh-health-check-session-history', JSON.stringify(['life-session']));
  });
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mapBootstrap([])),
  }));
  await page.route('**/api/sessions', (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify(fresh()),
  }));
  await page.route('**/api/sessions/*', (route) => {
    const id = route.request().url().split('/').pop();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(id === 'fresh-session' ? fresh() : stale()),
    });
  });
  await page.goto('/app');

  await expect(page.locator('#session-code')).toHaveText('MHC-FRESH1');
  await expect(page.locator('#copy-session-code')).toBeEnabled();
});

// The narrower case where "stays disabled after reload" is right: the code was
// used at least once, so it is not replaceable and survives the load dead.
test('Copy stays disabled when a dead but used code survives the reload', async ({ page }) => {
  await openCodeLifePage(page, () => lifeSession({
    expiresAt: Date.now() - 60000,
    useCount: 1,
    usesRemaining: 2,
    matchedAt: Date.now() - 120000,
    status: 'matched',
    healthMeasured: true,
  }), { preseedId: 'life-session' });

  await expect(page.locator('#session-code')).toHaveText('MHC-LIFE01');
  await expect(page.locator('#session-code-expiry')).toHaveText('Expired');
  await expect(page.locator('#copy-session-code')).toBeDisabled();
});

// Pressing New Code is a request, not an outcome. If the mint fails the dead
// code is still on screen, and re-enabling Copy on the click would hand back a
// working button for a code the server rejects.
test('Copy stays disabled when pressing New Code fails to mint', async ({ page }) => {
  const dead = () => lifeSession({
    expiresAt: Date.now() - 60000,
    useCount: 1,
    usesRemaining: 2,
    matchedAt: Date.now() - 120000,
    status: 'matched',
    healthMeasured: true,
  });

  await page.addInitScript(() => {
    window.WebSocket = class { addEventListener() {} close() {} };
    sessionStorage.setItem('mesh-health-check-session-id', 'life-session');
    sessionStorage.setItem('mesh-health-check-session-history', JSON.stringify(['life-session']));
  });
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mapBootstrap([])),
  }));
  let mintAttempts = 0;
  await page.route('**/api/sessions', (route) => {
    mintAttempts += 1;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'mint unavailable' }),
    });
  });
  await page.route('**/api/sessions/*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(dead()),
  }));
  await page.goto('/app');

  await expect(page.locator('#copy-session-code')).toBeDisabled();
  await page.locator('#new-session-button').click();
  await expect.poll(() => mintAttempts).toBeGreaterThan(0);

  // The dead code is still the code on screen, so Copy is still wrong to offer.
  await expect(page.locator('#session-code')).toHaveText('MHC-LIFE01');
  await expect(page.locator('#copy-session-code')).toBeDisabled();
  // And it must not drift back to enabled on a later poll or ticker tick.
  await page.waitForTimeout(6500);
  await expect(page.locator('#copy-session-code')).toBeDisabled();
});

// Defence in depth. Disabling the button is a hint; the handler must refuse a
// dead code on its own, so a stale attribute cannot put one on the clipboard.
//
// The clipboard is stubbed rather than used for real. Chromium leaves a real
// clipboard write pending on an unfocused document instead of rejecting it,
// which made earlier versions of this test fail perhaps half the time for
// reasons having nothing to do with the code under test. The stub also removes
// the user-activation requirement, so both clicks can be dispatched
// synchronously and neither can race the one-second ticker.
test('the copy handler refuses a dead code even with the button re-enabled', async ({ page }) => {
  await page.addInitScript(() => {
    window.__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__clipboardWrites.push(value); } },
    });
  });

  const deadFields = {
    expiresAt: Date.now() - 60000,
    useCount: 1,
    usesRemaining: 2,
    matchedAt: Date.now() - 120000,
    status: 'matched',
    healthMeasured: true,
  };
  // A flag over the session data, not over the button attribute. Flipping the
  // attribute by hand is how the first draft fooled itself: toBeEnabled passed
  // because of the test's own override while the session was still dead, so
  // the handler correctly refused and the missing copy looked like a bug.
  let live = false;
  await openCodeLifePage(
    page,
    () => (live ? lifeSession() : lifeSession(deadFields)),
    { preseedId: 'life-session' },
  );

  const copy = page.locator('#copy-session-code');
  const writes = () => page.evaluate(() => window.__clipboardWrites);
  await expect(copy).toBeDisabled();

  // Simulate a stale attribute: clear it and click in one synchronous block,
  // because the ticker repairs the attribute within a second. That repair is
  // itself evidence the derived rule works; here it just has to be kept out of
  // the way so the handler's own guard is what gets tested.
  await page.evaluate(() => {
    const button = document.querySelector('#copy-session-code');
    button.disabled = false;
    button.click();
  });
  await page.waitForTimeout(400);
  expect(await writes()).toEqual([]);
  // Wait for the ticker to take the stale attribute back off before touching
  // the session data. Skipping this is what made the previous version flaky:
  // the button was still enabled from the override above, so the toBeEnabled
  // below passed on the test's own doing and the click that followed hit a
  // session that was still dead.
  await expect(copy).toBeDisabled({ timeout: 5000 });

  // Control. Without it the assertion above would also pass for a handler that
  // never runs, or a stub that never captures - both of which have already
  // happened while writing this test.
  live = true;
  await expect(copy).toBeEnabled({ timeout: 10000 });
  await page.evaluate(() => { document.querySelector('#copy-session-code').click(); });
  await expect.poll(writes).toEqual(['MHC-LIFE01']);
});
