import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');

const REGIONS = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { name: 'Alpha', group: 'North' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  }],
};

const CODES = { codes: { AAA: { group: 'North', label: 'Alpha Metro' } }, outOfArea: { XXX: 'Elsewhere' } };

// A stub for seed-observers.py: writes the store the app will reload and emits
// the one SEED_JSON line runObserverReseed() parses. Run through /bin/sh, so
// the pass can be exercised without CoreScope or python3.
const STUB_SCRIPT = `#!/bin/sh
cat > "$OBSERVERS_FILE" <<'JSON'
{}
JSON
echo 'SEED_JSON {"wrote":true,"backup":null,"profiles":{"total":0},"uplinks":{"total":0,"locatedBefore":0,"locatedAfter":0,"newlyLocated":[],"stillUnlocated":0},"hashWidth":{"newlyRecorded":0,"changed":[],"cleared":0}}'
`;

async function withApp(run, { reseedEnabled = true, seedLog = [] } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-reseed-test-'));
  const files = {
    observers: path.join(tempDir, 'observer.json'),
    activity: path.join(tempDir, 'observer-activity.json'),
    results: path.join(tempDir, 'session-results.json'),
    regions: path.join(tempDir, 'regions.geojson'),
    codes: path.join(tempDir, 'uplink-codes.json'),
    log: path.join(tempDir, 'reseed-log.jsonl'),
    stub: path.join(tempDir, 'stub-seed.sh'),
  };
  fs.writeFileSync(files.observers, '{}\n', 'utf8');
  fs.writeFileSync(files.activity, '{"version":1,"observers":{}}\n', 'utf8');
  fs.writeFileSync(files.results, '{"version":1,"sessions":[]}\n', 'utf8');
  fs.writeFileSync(files.regions, `${JSON.stringify(REGIONS)}\n`, 'utf8');
  fs.writeFileSync(files.codes, `${JSON.stringify(CODES)}\n`, 'utf8');
  fs.writeFileSync(files.stub, STUB_SCRIPT, { mode: 0o755 });
  if (seedLog.length) {
    fs.writeFileSync(files.log, `${seedLog.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }

  const envKeys = [
    'MESH_HEALTH_DISABLE_RUNTIME', 'TURNSTILE_ENABLED', 'LOG_LEVEL',
    'OBSERVERS_FILE', 'OBSERVER_ACTIVITY_FILE', 'RESULTS_FILE',
    'REGIONS_FILE', 'UPLINK_CODES_FILE', 'ADMIN_TOKEN',
    'OBSERVER_RESEED_ENABLED', 'OBSERVER_RESEED_LOG',
    'OBSERVER_RESEED_SCRIPT', 'OBSERVER_RESEED_PYTHON',
    'TEST_CHANNEL_NAME', 'SITE_URL',
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'error';
  process.env.OBSERVERS_FILE = files.observers;
  process.env.OBSERVER_ACTIVITY_FILE = files.activity;
  process.env.RESULTS_FILE = files.results;
  process.env.REGIONS_FILE = files.regions;
  process.env.UPLINK_CODES_FILE = files.codes;
  process.env.ADMIN_TOKEN = 'reseed-test-token';
  process.env.OBSERVER_RESEED_ENABLED = reseedEnabled ? 'true' : 'false';
  process.env.OBSERVER_RESEED_LOG = files.log;
  process.env.OBSERVER_RESEED_SCRIPT = files.stub;
  process.env.OBSERVER_RESEED_PYTHON = '/bin/sh';
  process.env.TEST_CHANNEL_NAME = 'healthcheck';
  delete process.env.SITE_URL;

  const serverModule = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?reseed-test=${Date.now()}-${Math.random()}`
  );

  try {
    await new Promise((resolve) => {
      serverModule.server.listen(0, '127.0.0.1', () => resolve());
    });
    const baseUrl = `http://127.0.0.1:${serverModule.server.address().port}`;
    await run({ module: serverModule, files, baseUrl });
  } finally {
    await new Promise((resolve) => serverModule.server.close(() => resolve()));
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function status(baseUrl) {
  return fetch(`${baseUrl}/api/admin/reseed`, { headers: { 'x-admin-token': 'reseed-test-token' } })
    .then((response) => response.json());
}

test('the fingerprint is stable and covers both region inputs', async () => {
  await withApp(async ({ module, files }) => {
    const first = module.computeRegionFingerprint();
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.equal(module.computeRegionFingerprint(), first, 'unchanged files must hash the same');

    // Boundary edit.
    const widened = structuredClone(REGIONS);
    widened.features.push({
      type: 'Feature',
      properties: { name: 'Beta', group: 'North' },
      geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]] },
    });
    fs.writeFileSync(files.regions, `${JSON.stringify(widened)}\n`, 'utf8');
    const afterBoundary = module.computeRegionFingerprint();
    assert.notEqual(afterBoundary, first, 'a new county must change the fingerprint');

    // Code moved between the two blocks: same file length, different meaning.
    fs.writeFileSync(files.codes, `${JSON.stringify({
      codes: {},
      outOfArea: { AAA: 'Alpha Metro', XXX: 'Elsewhere' },
    })}\n`, 'utf8');
    assert.notEqual(module.computeRegionFingerprint(), afterBoundary, 'an uplink-code move must change it too');
  });
});

test('an unreadable region file yields no fingerprint rather than a new one', async () => {
  await withApp(async ({ module, files }) => {
    fs.rmSync(files.regions);
    assert.equal(module.computeRegionFingerprint(), null);
  });
});

test('only a successful pass supplies the recorded fingerprint', async () => {
  const seedLog = [
    { ok: true, trigger: 'schedule', dayKey: '2026-09-01', regionFingerprint: 'aaaaaaaaaaaaaaaa' },
    { ok: true, trigger: 'api', dayKey: '2026-09-05', regionFingerprint: 'bbbbbbbbbbbbbbbb' },
    { ok: false, trigger: 'boot', dayKey: '2026-09-09', regionFingerprint: 'cccccccccccccccc', error: 'boom' },
  ];
  await withApp(async ({ module }) => {
    assert.equal(module.loadLastReseedFingerprint(), 'bbbbbbbbbbbbbbbb');
  }, { seedLog });
});

test('a boot pass records the fingerprint but does not claim the day key', async () => {
  await withApp(async ({ module, baseUrl, files }) => {
    const before = await status(baseUrl);
    assert.equal(before.lastDayKey, null);
    assert.equal(before.lastSeededFingerprint, null);
    assert.equal(before.bootPassPending, false, 'DISABLE_RUNTIME must not arm the boot timer');

    const result = await module.runObserverReseed('boot');
    assert.equal(result.ok, true, result.error || 'boot pass should succeed');
    assert.equal(result.regionFingerprint, module.computeRegionFingerprint());

    const after = await status(baseUrl);
    assert.equal(after.lastDayKey, null, 'a boot pass must leave the scheduled run for the day intact');
    assert.equal(after.lastSeededFingerprint, result.regionFingerprint);

    // A second boot with the same inputs has nothing to do.
    assert.equal(module.loadLastReseedFingerprint(), module.computeRegionFingerprint());

    // Widening the boundary makes the recorded fingerprint stale again.
    const widened = structuredClone(REGIONS);
    widened.features[0].properties.name = 'Alpha Prime';
    fs.writeFileSync(files.regions, `${JSON.stringify(widened)}\n`, 'utf8');
    assert.notEqual(module.loadLastReseedFingerprint(), module.computeRegionFingerprint());
  });
});

test('a scheduled or api pass still claims the day key', async () => {
  await withApp(async ({ module, baseUrl }) => {
    const result = await module.runObserverReseed('api');
    assert.equal(result.ok, true, result.error || 'api pass should succeed');
    const after = await status(baseUrl);
    assert.equal(after.lastDayKey, result.dayKey);
  });
});
