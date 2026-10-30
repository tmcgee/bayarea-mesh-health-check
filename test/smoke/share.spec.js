import { expect, test } from '@playwright/test';

// Mirrors the shape /api/bootstrap sends for a keyed CARTO deployment. The
// share page renders the same coverage map component as the dashboard, so it
// needs the same map/site/observer fields even though nothing here is
// exercised by these tests beyond keeping the page from erroring out.
function shareBootstrap(cartoBasemapKey = 'test-carto-key') {
  const tileUrl = cartoBasemapKey
    ? `https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(cartoBasemapKey)}`
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const map = {
    darkTileUrl: tileUrl,
    lightTileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    darkAttribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    lightAttribution: '&copy; OpenStreetMap contributors',
    cartoBasemapKey,
    darkBasemapAvailable: Boolean(cartoBasemapKey),
    cartoKeyConfigured: Boolean(cartoBasemapKey),
  };
  return {
    map,
    site: {
      title: 'MeshCore Observer Coverage',
      eyebrow: 'MeshCore Observer Coverage',
      headline: 'Check your mesh reach.',
      description: 'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.',
      version: '1.0.0+upstream.1.3.8',
      repoUrl: 'https://github.com/tmcgee/bayarea-mesh-health-check',
      changesUrl: 'https://github.com/tmcgee/bayarea-mesh-health-check/blob/main/CHANGES.md',
      map,
    },
    mqtt: { connected: false, broker: 'mqtt.example.test', topics: ['meshcore/BOS/#'] },
    testChannel: { name: 'health-check', hash: '99' },
    turnstile: { enabled: false, verified: true },
    defaultObserverSource: 'configured',
    defaultObserverKeys: [],
    defaultObservers: [],
    observerDirectory: [],
    activeObservers: [],
    observerStats: {
      activeCount: 0,
      windowSeconds: 900,
      configuredCount: 0,
      retentionSeconds: 0,
      topWindowDays: 7,
      topCount: 10,
      hashDisplayBytes: 1,
      distanceUnit: 'mi',
    },
    availableRegions: [],
    regionHierarchy: [],
    results: { retentionSeconds: 604800 },
  };
}

// A session with nothing heard yet - the state a freshly shared code is in
// before any #health-check message has matched it.
function waitingSession(id = 'share-session', code = 'MHC-7F98BB') {
  const now = Date.now();
  return {
    id,
    code,
    instructions: `Send ${code} to #health-check`,
    status: 'active',
    createdAt: now,
    expiresAt: now + 600000,
    resultExpiresAt: now + 604800000,
    maxUses: 3,
    useCount: 0,
    usesRemaining: 3,
    expectedCount: 0,
    observedCount: 0,
    healthPercent: 0,
    healthLabel: 'WAITING',
    healthMeasured: false,
    expectedObserverSource: 'selected observers',
    expectedObservers: [],
    receipts: [],
  };
}

// A session that has already been heard, so the health card and receipts list
// inside the collapsed panel have real values to render, not just '--'.
function heardSession(id = 'share-session', code = 'MHC-7F98BB') {
  const now = Date.now();
  const observerA = {
    key: 'AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B',
    hash: 'AF',
    label: 'Smoke Observer 01',
    seen: true,
  };
  const observerB = {
    key: '01F0E86393494B0BE83E3D93BD528456DE39F389B9DCF802BC90B21F66EA88A6',
    hash: '01',
    label: 'Smoke Observer 02',
    seen: false,
  };
  return {
    id,
    code,
    instructions: `Send ${code} to #health-check`,
    status: 'complete',
    createdAt: now - 120000,
    matchedAt: now - 60000,
    expiresAt: now + 600000,
    resultExpiresAt: now + 604800000,
    maxUses: 3,
    useCount: 1,
    usesRemaining: 2,
    expectedCount: 2,
    observedCount: 1,
    healthPercent: 50,
    healthLabel: 'FAIR',
    healthMeasured: true,
    healthRated: true,
    repeaterCount: 1,
    longestPacketDistanceText: '2.1 mi',
    longestPacketDistanceSource: 'observer-span',
    messageHash: 'a1b2c3',
    sender: 'N6ABC',
    channelName: 'health-check',
    messageBody: 'MHC-7F98BB test transmission',
    expectedObserverSource: 'selected observers',
    expectedObservers: [observerA, observerB],
    receipts: [
      {
        observerKey: observerA.key,
        observerLabel: observerA.label,
        heard: true,
        distanceText: '2.1 mi',
      },
    ],
  };
}

async function mockShareRoutes(page, { session, cartoBasemapKey = 'test-carto-key' } = {}) {
  await page.addInitScript(() => {
    window.WebSocket = class {
      addEventListener() {}
      close() {}
    };
  });
  await page.route('**/api/bootstrap', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(shareBootstrap(cartoBasemapKey)),
  }));
  await page.route('**/api/sessions/share-session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(session),
  }));
  await page.route('**/api/region-boundaries', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
  }));
}

test('share page loads with the additional-info toggle collapsed and the copy button hidden', async ({ page }) => {
  await mockShareRoutes(page, { session: waitingSession() });
  await page.goto('/share/share-session');

  await expect(page).toHaveTitle(/Shared Result/i);
  await expect(page.locator('#session-code')).toHaveText('MHC-7F98BB');

  // The panels that carry the toggle live inside #additional-info and start
  // collapsed - same convention as the dashboard, just seeded via /share/:id
  // instead of a freshly created session.
  await expect(page.locator('#additional-info-label')).toHaveText('Show Additional Information');
  await expect(page.locator('#observer-reports')).not.toBeVisible();
  await expect(page.locator('#system-metrics')).not.toBeVisible();

  await page.locator('#additional-info-toggle').click();
  await expect(page.locator('#additional-info-label')).toHaveText('Hide Additional Information');
  await expect(page.locator('#observer-reports')).toBeVisible();
  await expect(page.locator('#system-metrics')).toBeVisible();

  // The copy-code button has no value on a read-only shared result - it stays
  // in the DOM (app.js binds a click listener to it unconditionally) but is
  // visually and functionally hidden via the page's own share-hidden rule.
  const copyButton = page.locator('#copy-session-code');
  await expect(copyButton).toBeAttached();
  await expect(copyButton).toBeHidden();
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
});

test('share page renders a heard session inside the collapsed section', async ({ page }) => {
  await mockShareRoutes(page, { session: heardSession() });
  await page.goto('/share/share-session');

  await expect(page.locator('#session-code')).toHaveText('MHC-7F98BB');
  await expect(page.locator('#health-label')).toHaveText('FAIR', { timeout: 10000 });
  await expect(page.locator('#observed-count')).toHaveText('1 / 2');
  await expect(page.locator('#sender-name')).toHaveText('N6ABC');
  await expect(page.locator('#message-preview')).toHaveText('MHC-7F98BB test transmission');

  // Observer Reports and System Telemetry are gated behind the toggle even
  // when the session already has data to show.
  await expect(page.locator('#observer-reports')).not.toBeVisible();
  await page.locator('#additional-info-toggle').click();
  await expect(page.locator('#observer-reports')).toBeVisible();
  await expect(page.getByText('Smoke Observer 01')).toBeVisible();
});

test('share page never shows the read/write session controls dashboard visitors get', async ({ page }) => {
  await mockShareRoutes(page, { session: waitingSession() });
  await page.goto('/share/share-session');

  await expect(page.locator('#session-code')).toContainText('MHC-', { timeout: 10000 });
  // A shared result is read-only: the "New Code" control ships in the markup
  // (app.js still queries it unconditionally) but stays CSS-hidden on this
  // page, unlike the dashboard where it is the primary action.
  await expect(page.locator('#new-session-button')).toHaveClass(/hidden/);
  await expect(page.locator('#new-session-button')).toBeHidden();
});

// A shared result is a historical record. Its code expired long before anyone
// followed the link, and counting that down - or striking it through as though
// something had gone wrong - would report a fault where there is none. The
// dashboard's code-lifetime treatment is suppressed here entirely.
test('share page shows no code countdown and never marks the shared code dead', async ({ page }) => {
  const expired = waitingSession();
  expired.expiresAt = Date.now() - 86400000;
  expired.usesRemaining = 0;
  expired.useCount = 3;
  await mockShareRoutes(page, { session: expired });
  await page.goto('/share/share-session');

  await expect(page.locator('#session-code')).toHaveText('MHC-7F98BB');
  const expiry = page.locator('#session-code-expiry');
  await expect(expiry).toBeAttached();
  await expect(expiry).toBeHidden();
  await expect(page.locator('#session-code')).not.toHaveClass(/is-dead/);
  await expect(page.locator('#session-code')).not.toHaveClass(/is-expiring/);
  await expect(page.locator('#session-instructions')).not.toContainText('no longer accepted');
  // The share page has its own label and the dashboard's states never touch it.
  await expect(page.locator('#session-code-label')).toHaveText('Shared Code');
  // Nor does the dead-code headline correction reach a saved result.
  await expect(page.locator('#health-label')).not.toHaveText('No result');
});

// A shared result is a permanent record and its copy controls are about the
// link, not about sending anything. The dashboard's dead-code rule must not
// reach across and switch them off.
test('share page keeps its copy controls usable for a long-dead shared code', async ({ page }) => {
  const expired = waitingSession();
  expired.expiresAt = Date.now() - 86400000;
  expired.usesRemaining = 0;
  expired.useCount = 3;
  // The share button is governed by whether there is a link to copy, never by
  // the code's liveness, so the session needs one for this to mean anything.
  expired.shareUrl = 'https://healthcheck.example.test/share/share-session';
  await mockShareRoutes(page, { session: expired });
  await page.goto('/share/share-session');

  await expect(page.locator('#session-code')).toHaveText('MHC-7F98BB');
  // The share link button is the one that matters here and it stays live.
  await expect(page.locator('#share-session')).toBeEnabled();
  // The dashboard's own copy button is hidden on this page rather than
  // repurposed, and the dead-code rule must not have touched it either.
  await expect(page.locator('#copy-session-code')).toBeHidden();
});
