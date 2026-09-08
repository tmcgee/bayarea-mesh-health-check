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

function mapSession(expectedObservers, seenKeys = []) {
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
    receipts: [],
  };
}

async function openMockMapSession(
  page,
  observerDirectory,
  expectedObservers,
  cartoBasemapKey = 'test-carto-key',
  { seenKeys = [], boundaries = null } = {},
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
    body: JSON.stringify(mapSession(expectedObservers, seenKeys)),
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
