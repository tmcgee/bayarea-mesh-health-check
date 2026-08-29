import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');

function squareFeature(label, macro, west, south, east, north) {
  return {
    type: 'Feature',
    properties: { label, macro },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}

const OBSERVER_KEYS = {
  located: '1111111111111111111111111111111111111111111111111111111111111111',
  inferred: '2222222222222222222222222222222222222222222222222222222222222222',
  outOfArea: '3333333333333333333333333333333333333333333333333333333333333333',
  conflicting: '4444444444444444444444444444444444444444444444444444444444444444',
  unknownCode: '5555555555555555555555555555555555555555555555555555555555555555',
};

async function withServer(run, { regionFallback = 'uplink-code' } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-uplink-test-'));
  const observerFile = path.join(tempDir, 'observer.json');
  const observerActivityFile = path.join(tempDir, 'observer-activity.json');
  const resultsFile = path.join(tempDir, 'session-results.json');
  const regionsFile = path.join(tempDir, 'regions.geojson');
  const uplinkFile = path.join(tempDir, 'uplink-codes.json');

  fs.writeFileSync(observerFile, '{}\n', 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  fs.writeFileSync(regionsFile, `${JSON.stringify({
    type: 'FeatureCollection',
    features: [
      squareFeature('Alpha', 'North', 0, 0, 1, 1),
      squareFeature('Gamma', 'South', 0, -1, 1, 0),
    ],
  })}\n`, 'utf8');
  fs.writeFileSync(uplinkFile, `${JSON.stringify({
    codes: {
      AAA: { group: 'North', label: 'Alpha Metro' },
      // Deliberately maps to a different group than the polygon this observer
      // sits in, to prove coordinates win.
      GGG: { group: 'South', label: 'Gamma Metro' },
      ZZZ: 'Nonexistent Group',
    },
    outOfArea: {
      XXX: 'Somewhere Else',
    },
  })}\n`, 'utf8');

  const envKeys = [
    'MESH_HEALTH_DISABLE_RUNTIME',
    'TURNSTILE_ENABLED',
    'LOG_LEVEL',
    'OBSERVERS_FILE',
    'OBSERVER_ACTIVITY_FILE',
    'RESULTS_FILE',
    'REGIONS_FILE',
    'REGION_NAME_PROPERTY',
    'REGION_GROUP_PROPERTY',
    'UPLINK_CODES_FILE',
    'REGION_FALLBACK',
    'TEST_CHANNEL_NAME',
    'TEST_CHANNEL_SECRET',
    'OBSERVER_RETENTION_SECONDS',
    'REQUIRE_REGION_MATCH',
    'SITE_URL',
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'error';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;
  process.env.REGIONS_FILE = regionsFile;
  process.env.REGION_NAME_PROPERTY = 'label';
  process.env.REGION_GROUP_PROPERTY = 'macro';
  process.env.UPLINK_CODES_FILE = uplinkFile;
  process.env.REGION_FALLBACK = regionFallback;
  process.env.TEST_CHANNEL_NAME = 'health-check';
  process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
  process.env.OBSERVER_RETENTION_SECONDS = '14400';
  process.env.REQUIRE_REGION_MATCH = 'false';
  delete process.env.SITE_URL;

  const serverModule = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?uplink-test=${Date.now()}-${Math.random()}`
  );
  const { ingestMqttMessage, resetTestState, server } = serverModule;

  try {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    resetTestState();

    // Coordinates inside Alpha/North, uplinked through AAA -> polygon wins.
    ingestMqttMessage(
      `meshcore/AAA/${OBSERVER_KEYS.located}/status`,
      Buffer.from(JSON.stringify({
        name: 'Located Observer',
        location: { latitude: 0.5, longitude: 0.5 },
      })),
    );
    // No coordinates, in-area code -> group inferred from the uplink code.
    ingestMqttMessage(
      `meshcore/AAA/${OBSERVER_KEYS.inferred}/status`,
      Buffer.from(JSON.stringify({ name: 'Inferred Observer' })),
    );
    // Out-of-area code -> excluded from the directory entirely.
    ingestMqttMessage(
      `meshcore/XXX/${OBSERVER_KEYS.outOfArea}/status`,
      Buffer.from(JSON.stringify({ name: 'Out Of Area Observer' })),
    );
    // Coordinates in Alpha/North but uplinked through GGG (South).
    ingestMqttMessage(
      `meshcore/GGG/${OBSERVER_KEYS.conflicting}/status`,
      Buffer.from(JSON.stringify({
        name: 'Conflicting Observer',
        location: { latitude: 0.5, longitude: 0.5 },
      })),
    );
    // Code absent from the table -> no region, but still listed.
    ingestMqttMessage(
      `meshcore/QQQ/${OBSERVER_KEYS.unknownCode}/status`,
      Buffer.from(JSON.stringify({ name: 'Unknown Code Observer' })),
    );

    const response = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(response.status, 200);
    // Second argument exposes the live origin so a test can exercise a real
    // session rather than only the bootstrap snapshot.
    await run(await response.json(), {
      baseUrl,
      async post(pathname, body) {
        const created = await fetch(`${baseUrl}${pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(created.status, 201);
        return created.json();
      },
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function byKey(directory) {
  return new Map(directory.map((observer) => [observer.key, observer]));
}

test('uplink code infers a region group only when coordinates are missing', async () => {
  await withServer((payload) => {
    const directory = byKey(payload.observerDirectory);

    const located = directory.get(OBSERVER_KEYS.located);
    assert.equal(located.region, 'Alpha');
    assert.equal(located.regionGroup, 'North');
    assert.equal(located.regionSource, 'coordinates');
    assert.equal(located.regionInferred, false);
    assert.equal(located.uplinkCode, 'AAA');

    const inferred = directory.get(OBSERVER_KEYS.inferred);
    assert.equal(inferred.region, null, 'inferred observers never get a county');
    assert.equal(inferred.regionGroup, 'North');
    assert.equal(inferred.regionSource, 'uplink-code');
    assert.equal(inferred.regionInferred, true);
    assert.equal(inferred.hasLocation, false);
    assert.equal(inferred.uplinkLabel, 'Alpha Metro');
  });
});

test('coordinates win over a conflicting uplink code', async () => {
  await withServer((payload) => {
    const conflicting = byKey(payload.observerDirectory).get(OBSERVER_KEYS.conflicting);
    assert.equal(conflicting.uplinkCode, 'GGG');
    assert.equal(conflicting.regionGroup, 'North', 'polygon group, not the GGG code group');
    assert.equal(conflicting.region, 'Alpha');
    assert.equal(conflicting.regionSource, 'coordinates');
    assert.equal(conflicting.regionInferred, false);
  });
});

test('out-of-area uplink codes are excluded from the observer directory', async () => {
  await withServer((payload) => {
    const directory = byKey(payload.observerDirectory);
    assert.equal(directory.has(OBSERVER_KEYS.outOfArea), false);
    assert.equal(payload.observerStats.outOfAreaCount, 1);
    assert.equal(
      payload.defaultObservers.some((observer) => observer.key === OBSERVER_KEYS.outOfArea),
      false,
      'excluded observers must never enter the default target',
    );
  });
});

test('unknown uplink codes leave the region unresolved without excluding the observer', async () => {
  await withServer((payload) => {
    const unknown = byKey(payload.observerDirectory).get(OBSERVER_KEYS.unknownCode);
    assert.ok(unknown, 'an unrecognised code is not the same as out-of-area');
    assert.equal(unknown.uplinkCode, 'QQQ');
    assert.equal(unknown.regionGroup, null);
    assert.equal(unknown.regionInferred, false);
  });
});

test('inferred observers are counted separately in the region hierarchy', async () => {
  await withServer((payload) => {
    const north = payload.regionHierarchy.find((entry) => entry.group === 'North');
    assert.equal(north.inferredCount, 1);
    // Two located observers sit in Alpha; the inferred one adds no county count.
    assert.equal(north.regions.find((region) => region.name === 'Alpha').count, 2);
    assert.equal(payload.observerStats.inferredRegionCount, 1);
    assert.equal(payload.observerStats.regionFallback, 'uplink-code');
  });
});

// An observer with no position still hears the channel and still publishes a
// receipt, so it is scored. What it must NOT do is earn map or region credit off
// a group that was only inferred from its uplink gateway.
test('inferred observers are in the default scoring target', async () => {
  await withServer((payload) => {
    const targetKeys = payload.defaultObservers.map((observer) => observer.key);
    assert.equal(targetKeys.includes(OBSERVER_KEYS.inferred), true);
    assert.equal(targetKeys.includes(OBSERVER_KEYS.located), true);
    // Scored, but still unlocated and still not a county member.
    const inferred = byKey(payload.observerDirectory).get(OBSERVER_KEYS.inferred);
    assert.equal(inferred.regionInferred, true);
    assert.equal(inferred.hasLocation, false);
    assert.equal(inferred.lat, null);
    assert.equal(inferred.region, null);
  });
});

test('an inferred observer earns no Regions Reached credit', async () => {
  await withServer(async (payload, ctx) => {
    const created = await ctx.post('/api/sessions', {
      expectedObserverKeys: [OBSERVER_KEYS.inferred],
      allowlistEnabled: true,
    });
    // The server accepted it as a target at all, which is the first half of the
    // contract: a coordinate-less observer is scoring-eligible.
    assert.deepEqual(
      created.expectedObservers.map((observer) => observer.key),
      [OBSERVER_KEYS.inferred],
    );

    const session = await (await fetch(`${ctx.baseUrl}/api/sessions/${created.id}`)).json();
    // Second half: its group came from an uplink code, so regionCoverageFor()
    // ignores it and the denominator is zero rather than one. We do not claim
    // reach into a region we never confirmed a position in.
    assert.equal(session.regionCoverage.total, 0);
    assert.equal(session.regionCoverage.reached, 0);
  });
});

test('out-of-area exclusion applies even when REGION_FALLBACK is off', async () => {
  await withServer((payload) => {
    const directory = byKey(payload.observerDirectory);
    assert.equal(directory.has(OBSERVER_KEYS.outOfArea), false, 'exclusion is unconditional');
    assert.equal(payload.observerStats.outOfAreaCount, 1);
    assert.equal(payload.observerStats.regionFallback, null);

    // With the fallback disabled the coordinate-less observer keeps no region.
    const inferred = directory.get(OBSERVER_KEYS.inferred);
    assert.equal(inferred.regionGroup, null);
    assert.equal(inferred.regionInferred, false);
    assert.equal(payload.observerStats.inferredRegionCount, 0);
    // ...and it is still a target: a missing position never disqualified it.
    assert.equal(
      payload.defaultObservers.some((observer) => observer.key === OBSERVER_KEYS.inferred),
      true,
    );
  }, { regionFallback: '' });
});
