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

async function withApp(run, { reseedEnabled = true, seedLog = [], adminToken = 'reseed-test-token' } = {}) {
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
  process.env.ADMIN_TOKEN = adminToken;
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

function publicStatus(baseUrl) {
  return fetch(`${baseUrl}/api/reseed-status`).then(async (response) => ({
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json(),
  }));
}

test('the public status needs no token and reports counts and observer names', async () => {
  const seedLog = [
    { ok: true, trigger: 'schedule', dayKey: '2026-10-27', regionFingerprint: 'aaaaaaaaaaaaaaaa' },
    {
      ok: true, trigger: 'boot', dayKey: '2026-10-28', regionFingerprint: 'bbbbbbbbbbbbbbbb',
      at: '2026-10-28T14:03:30.000Z', ms: 4120, profilesChangedInMemory: 3,
      profiles: { total: 48, located: 41 },
      uplinks: {
        total: 40, locatedBefore: 33, locatedAfter: 35, newlyLocated: ['Mt Diablo', 'Napa Ridge'],
        stillUnlocated: 3, stillUnlocatedNames: ['Chico North', 'Yuba City'], stillUnlocatedOutside: 1,
      },
      hashWidth: {
        newlyRecorded: 1, cleared: 0,
        changed: [{ name: 'Vollmer Peak', from: 1, to: 2, extra: 'dropped' }],
        examples: [{ name: 'Mt Diablo', bytes: 2 }],
      },
      backup: '/opt/mesh-health-check/data/observer.json.bak-20261028-0703',
    },
  ];
  await withApp(async ({ baseUrl }) => {
    const { status, cache, body } = await publicStatus(baseUrl);
    assert.equal(status, 200);
    assert.equal(cache, 'no-store');
    assert.equal(body.lastSeededFingerprint, 'bbbbbbbbbbbbbbbb', 'a restart must still see the logged pass');
    assert.equal(body.upToDate, false, 'the test inputs do not match the logged fingerprint');
    assert.deepEqual(body.last, {
      ok: true, trigger: 'boot', at: '2026-10-28T14:03:30.000Z', ms: 4120, profilesChangedInMemory: 3,
      profiles: { total: 48, located: 41 },
      uplinks: {
        total: 40, locatedBefore: 33, locatedAfter: 35, newlyLocated: ['Mt Diablo', 'Napa Ridge'],
        stillUnlocated: 3, stillUnlocatedNames: ['Chico North', 'Yuba City'], stillUnlocatedOutside: 1,
      },
      hashWidth: {
        newlyRecorded: 1, cleared: 0,
        changed: [{ name: 'Vollmer Peak', from: 1, to: 2 }],
        examples: [{ name: 'Mt Diablo', bytes: 2 }],
      },
    });
    const text = JSON.stringify(body);
    for (const secret of ['/opt/', 'backup', 'logPath', 'dayKey', 'dropped']) {
      assert.equal(text.includes(secret), false, `public status must not carry ${secret}`);
    }
  }, { seedLog });
});

test('a failed last pass shows as failed without its error text', async () => {
  const seedLog = [
    { ok: true, trigger: 'schedule', dayKey: '2026-10-27', regionFingerprint: 'aaaaaaaaaaaaaaaa' },
    {
      ok: false, trigger: 'boot', dayKey: '2026-10-28', regionFingerprint: 'bbbbbbbbbbbbbbbb',
      at: '2026-10-28T14:03:30.000Z', ms: 900,
      error: 'Command failed: python3 /app/seed-observers.py', stderr: 'urlopen error | /app/data/observer.json',
    },
  ];
  await withApp(async ({ baseUrl }) => {
    const { body } = await publicStatus(baseUrl);
    assert.equal(body.lastSeededFingerprint, 'aaaaaaaaaaaaaaaa', 'only a successful pass counts as seeded');
    assert.equal(body.last.ok, false);
    assert.equal(body.last.trigger, 'boot');
    assert.equal(body.last.profilesChangedInMemory, null);
    const text = JSON.stringify(body);
    assert.equal(text.includes('urlopen'), false);
    assert.equal(text.includes('/app/'), false);
  }, { seedLog });
});

test('a successful pass makes the public status up to date', async () => {
  await withApp(async ({ module, baseUrl }) => {
    const before = (await publicStatus(baseUrl)).body;
    assert.equal(before.last, null);
    assert.equal(before.lastSeededFingerprint, null);
    assert.equal(before.upToDate, false);
    assert.equal(before.bootPassPending, false);
    assert.equal(before.running, false);
    assert.equal(before.regionFingerprint, module.computeRegionFingerprint());

    const result = await module.runObserverReseed('boot');
    assert.equal(result.ok, true, result.error || 'boot pass should succeed');

    const after = (await publicStatus(baseUrl)).body;
    assert.equal(after.upToDate, true);
    assert.equal(after.lastSeededFingerprint, result.regionFingerprint);
    assert.equal(after.last.ok, true);
    assert.equal(after.last.trigger, 'boot');
    assert.equal(after.last.at, result.at);
  });
});

test('the public status works with the admin routes disabled', async () => {
  await withApp(async ({ baseUrl }) => {
    assert.equal((await fetch(`${baseUrl}/api/admin/reseed`)).status, 404);
    const { status, body } = await publicStatus(baseUrl);
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    const posted = await fetch(`${baseUrl}/api/reseed-status`, { method: 'POST' });
    assert.notEqual(posted.status, 200, 'the public route must not start a pass');
  }, { adminToken: '' });
});

test('a pass logged before names were recorded reports null name lists', async () => {
  const seedLog = [{
    ok: true, trigger: 'schedule', dayKey: '2026-10-27', regionFingerprint: 'aaaaaaaaaaaaaaaa',
    uplinks: { total: 3, locatedBefore: 3, locatedAfter: 3, newlyLocated: [], stillUnlocated: 0 },
    hashWidth: { newlyRecorded: 0, changed: [], cleared: 0 },
  }];
  await withApp(async ({ baseUrl }) => {
    const { body } = await publicStatus(baseUrl);
    assert.deepEqual(body.last.uplinks.newlyLocated, []);
    assert.equal(body.last.uplinks.stillUnlocatedNames, null, 'an absent list is unknown, not empty');
    assert.equal(body.last.uplinks.stillUnlocatedOutside, null);
    assert.deepEqual(body.last.hashWidth.changed, []);
    assert.equal(body.last.hashWidth.examples, null);
  }, { seedLog });
});
