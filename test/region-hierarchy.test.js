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

test('bootstrap exposes a flat regions file as a place tree for observer filters', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-regions-test-'));
  const observerFile = path.join(tempDir, 'observer.json');
  const observerActivityFile = path.join(tempDir, 'observer-activity.json');
  const resultsFile = path.join(tempDir, 'session-results.json');
  const regionsFile = path.join(tempDir, 'regions.geojson');
  const observerKeys = [
    '1111111111111111111111111111111111111111111111111111111111111111',
    '2222222222222222222222222222222222222222222222222222222222222222',
    '3333333333333333333333333333333333333333333333333333333333333333',
    '4444444444444444444444444444444444444444444444444444444444444444',
  ];

  fs.writeFileSync(observerFile, '{}\n', 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  fs.writeFileSync(regionsFile, `${JSON.stringify({
    type: 'FeatureCollection',
    features: [
      squareFeature('Alpha', 'North', 0, 0, 1, 1),
      squareFeature('Beta', 'North', 1, 0, 2, 1),
      // Deliberately long decimals: the boundary endpoint rounds drawing
      // geometry, while region detection keeps using the full precision.
      // South sits under a parent region (bayarea.21), read from the default
      // `parentRegion` property; North has none and must come back unchanged.
      { ...squareFeature('Gamma', 'South', 0.1234567891, -1, 1, 0), properties: { label: 'Gamma', macro: 'South', parentRegion: 'Hemisphere' } },
      squareFeature('Outside Census places', 'North', 0, 0, 3, 1),
      // No observer ever falls inside Delta, but it belongs to a group that has
      // one, so it forms part of that region's outline.
      { ...squareFeature('Delta', 'South', 5, 5, 6, 6), properties: { label: 'Delta', macro: 'South', parentRegion: 'Hemisphere' } },
      // Epsilon's whole group is observerless, so none of it is ever served.
      squareFeature('Epsilon', 'West', 9, 9, 10, 10),
    ],
  })}\n`, 'utf8');

  const previousEnv = {
    MESH_HEALTH_DISABLE_RUNTIME: process.env.MESH_HEALTH_DISABLE_RUNTIME,
    TURNSTILE_ENABLED: process.env.TURNSTILE_ENABLED,
    LOG_LEVEL: process.env.LOG_LEVEL,
    OBSERVERS_FILE: process.env.OBSERVERS_FILE,
    OBSERVER_ACTIVITY_FILE: process.env.OBSERVER_ACTIVITY_FILE,
    RESULTS_FILE: process.env.RESULTS_FILE,
    REGIONS_FILE: process.env.REGIONS_FILE,
    REGION_NAME_PROPERTY: process.env.REGION_NAME_PROPERTY,
    REGION_GROUP_PROPERTY: process.env.REGION_GROUP_PROPERTY,
    TEST_CHANNEL_NAME: process.env.TEST_CHANNEL_NAME,
    TEST_CHANNEL_SECRET: process.env.TEST_CHANNEL_SECRET,
    OBSERVER_RETENTION_SECONDS: process.env.OBSERVER_RETENTION_SECONDS,
  };

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'info';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;
  process.env.REGIONS_FILE = regionsFile;
  process.env.REGION_NAME_PROPERTY = 'label';
  process.env.REGION_GROUP_PROPERTY = 'macro';
  process.env.TEST_CHANNEL_NAME = 'health-check';
  process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
  process.env.OBSERVER_RETENTION_SECONDS = '14400';

  const serverModule = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?regions-test=${Date.now()}`
  );
  const {
    flushScheduledWrites,
    ingestMqttMessage,
    resetTestState,
    server,
  } = serverModule;

  let baseUrl = '';
  try {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    resetTestState();
    const locations = [
      { key: observerKeys[0], name: 'Alpha Observer', latitude: 0.5, longitude: 0.5 },
      { key: observerKeys[1], name: 'Beta Observer', latitude: 0.5, longitude: 1.5 },
      { key: observerKeys[2], name: 'Gamma Observer', latitude: -0.5, longitude: 0.5 },
      { key: observerKeys[3], name: 'Fallback Observer', latitude: 0.5, longitude: 2.5 },
    ];
    for (const location of locations) {
      ingestMqttMessage(
        `meshcore/TEST/${location.key}/status`,
        Buffer.from(JSON.stringify({
          name: location.name,
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
          },
        })),
      );
    }

    const response = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    // A flat REGIONS_FILE becomes a tree through the adapter (1.2.0): parent
    // region, group and subregion are depths 1-3, codes are slugs of the names,
    // and only places holding observers (with their ancestors) are listed.
    assert.equal(payload.availableRegions, undefined);
    assert.equal(payload.regionHierarchy, undefined);
    assert.deepEqual(payload.regionTree.map((node) => [node.code, node.parent, node.depth, node.count]), [
      ['hemisphere', '', 1, 1],
      ['north', '', 1, 3],
      ['alpha', 'north', 2, 1],
      ['beta', 'north', 2, 1],
      ['outside-census-places', 'north', 2, 1],
      ['south', 'hemisphere', 2, 1],
      ['gamma', 'south', 3, 1],
    ]);
    assert.deepEqual(payload.regionTree.find((node) => node.code === 'north').children,
      ['alpha', 'beta', 'outside-census-places']);
    assert.equal(payload.regionTree.find((node) => node.code === 'gamma').name, 'Gamma');

    const alphaObserver = payload.observerDirectory.find((entry) => entry.key === observerKeys[0]);
    assert.equal(alphaObserver?.place, 'alpha');
    assert.deepEqual(alphaObserver?.placePath, ['north', 'alpha']);

    // The deepest, then smallest, containing place wins: Alpha sits inside the
    // larger 'Outside Census places' too, and the Fallback observer only there.
    const fallbackObserver = payload.observerDirectory.find((entry) => entry.key === observerKeys[3]);
    assert.equal(fallbackObserver?.place, 'outside-census-places');

    const boundaryResponse = await fetch(`${baseUrl}/api/region-boundaries`);
    assert.equal(boundaryResponse.status, 200);
    const boundaries = await boundaryResponse.json();
    assert.equal(boundaries.type, 'FeatureCollection');

    // One outline per place holding observers, at every depth, plus the
    // observer-less children of those places (empty: true). West and Epsilon -
    // a real group in the file with nobody inside it - are absent, which is
    // what keeps a 32,656-feature regions file from being shipped.
    assert.deepEqual(
      boundaries.features.map((feature) => feature.properties.code).sort(),
      ['alpha', 'beta', 'delta', 'gamma', 'hemisphere', 'north', 'outside-census-places', 'south'],
    );
    for (const feature of boundaries.features) {
      assert.equal(feature.type, 'Feature');
      assert.deepEqual(Object.keys(feature.properties).filter((key) => key !== 'empty'),
        ['code', 'name', 'parent', 'depth']);
      assert.equal(feature.geometry.type, 'MultiPolygon');
    }
    assert.deepEqual(boundaries.features.filter((feature) => feature.properties.empty)
      .map((feature) => [feature.properties.code, feature.properties.parent]), [['delta', 'south']]);

    // ?parent= serves one level: the map draws one at a time.
    const topLevel = await (await fetch(`${baseUrl}/api/region-boundaries?parent=`)).json();
    assert.deepEqual(topLevel.features.map((feature) => feature.properties.code).sort(), ['hemisphere', 'north']);
    const underSouth = await (await fetch(`${baseUrl}/api/region-boundaries?parent=south`)).json();
    assert.deepEqual(underSouth.features.map((feature) => feature.properties.code).sort(), ['delta', 'gamma']);
    // A comma list serves several levels in one request; '' in it is the top.
    const several = await (await fetch(`${baseUrl}/api/region-boundaries?parent=,south`)).json();
    assert.deepEqual(several.features.map((feature) => feature.properties.code).sort(), ['delta', 'gamma', 'hemisphere', 'north']);
    // ?code= picks outlines by code (the zoomed-in map's full-detail fetch), and
    // ?detail=coarse serves the same places at the coarse tolerance.
    const byCode = await (await fetch(`${baseUrl}/api/region-boundaries?code=gamma,north`)).json();
    assert.deepEqual(byCode.features.map((feature) => feature.properties.code).sort(), ['gamma', 'north']);
    const coarse = await (await fetch(`${baseUrl}/api/region-boundaries?parent=,south&detail=coarse`)).json();
    assert.deepEqual(coarse.features.map((feature) => feature.properties.code).sort(), ['delta', 'gamma', 'hemisphere', 'north']);
    const unknown = await (await fetch(`${baseUrl}/api/region-boundaries?parent=nowhere`)).json();
    assert.deepEqual(unknown.features, []);
    // The locator gets every level at once.
    const locator = await (await fetch(`${baseUrl}/api/region-locator`)).json();
    assert.equal(locator.features.length, boundaries.features.length);

    const ringsOf = (code) => boundaries.features
      .find((feature) => feature.properties.code === code)
      .geometry.coordinates.flat();

    // Alpha (0,0)-(1,1) and Beta (1,0)-(2,1) are neighbours in North, so the
    // border they share is dissolved away and they draw as one 0..2 rectangle.
    // Simplification keeps the collinear midpoints (1,0) and (1,1): Alpha and
    // Beta are outlined too, and those are where their border meets North's,
    // so all three keep the same vertices there (lib/outline-simplify.js).
    const north = ringsOf('north');
    const merged = north.find((ring) => ring.some(([longitude]) => longitude === 2)
      && ring.every(([longitude]) => longitude <= 2));
    assert.ok(merged, 'the two adjacent North subregions merge into a single ring');
    assert.deepEqual(
      [...new Set(merged.map((point) => point.join(',')))].sort(),
      ['0,0', '0,1', '1,0', '1,1', '2,0', '2,1'],
    );
    for (const ring of north) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const segment = [ring[i].join(','), ring[i + 1].join(',')].sort().join('>');
        assert.notEqual(segment, '1,0>1,1', 'the shared Alpha/Beta border is not drawn');
      }
    }
    // 'Outside Census places' overlaps rather than abuts its neighbours, so it
    // has no border to cancel and stays a ring of its own.
    assert.equal(north.length, 2);

    // Delta holds no observers, but its parent does, so the South outline covers
    // it: an outline describes the place, not the coverage inside it.
    const south = ringsOf('south');
    assert.equal(south.length, 2);
    assert.ok(
      south.some((ring) => ring.every(([longitude]) => longitude >= 5)),
      'an observerless subregion still forms part of its region outline',
    );

    const gammaRing = south.find((ring) => ring.some(([longitude]) => longitude < 5));
    const gammaLongitudes = gammaRing.map(([longitude]) => longitude);
    assert.ok(gammaLongitudes.includes(0.1235), 'drawing geometry is rounded to four decimals');
    assert.ok(!gammaLongitudes.includes(0.1234567891), 'full precision is not shipped to the client');

    // Region detection still uses the unrounded boundary: the Gamma observer at
    // longitude 0.5 stays inside Gamma.
    const gammaObserver = payload.observerDirectory.find((entry) => entry.key === observerKeys[2]);
    assert.equal(gammaObserver?.place, 'gamma');
    assert.deepEqual(gammaObserver?.placePath, ['hemisphere', 'south', 'gamma']);
  } finally {
    flushScheduledWrites();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
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
});

test('a regions file with no group property gives top-level places only', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-regions-flat-test-'));
  const observerFile = path.join(tempDir, 'observer.json');
  const observerActivityFile = path.join(tempDir, 'observer-activity.json');
  const resultsFile = path.join(tempDir, 'session-results.json');
  const regionsFile = path.join(tempDir, 'regions.geojson');
  const observerKeys = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ];

  fs.writeFileSync(observerFile, '{}\n', 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  fs.writeFileSync(regionsFile, `${JSON.stringify({
    type: 'FeatureCollection',
    features: [
      squareFeature('Alpha', undefined, 0, 0, 1, 1),
      squareFeature('Beta', undefined, 1, 0, 2, 1),
    ].map((feature) => ({
      ...feature,
      properties: { label: feature.properties.label },
    })),
  })}\n`, 'utf8');

  const previousEnv = {
    MESH_HEALTH_DISABLE_RUNTIME: process.env.MESH_HEALTH_DISABLE_RUNTIME,
    TURNSTILE_ENABLED: process.env.TURNSTILE_ENABLED,
    LOG_LEVEL: process.env.LOG_LEVEL,
    OBSERVERS_FILE: process.env.OBSERVERS_FILE,
    OBSERVER_ACTIVITY_FILE: process.env.OBSERVER_ACTIVITY_FILE,
    RESULTS_FILE: process.env.RESULTS_FILE,
    REGIONS_FILE: process.env.REGIONS_FILE,
    REGION_NAME_PROPERTY: process.env.REGION_NAME_PROPERTY,
    REGION_GROUP_PROPERTY: process.env.REGION_GROUP_PROPERTY,
    TEST_CHANNEL_NAME: process.env.TEST_CHANNEL_NAME,
    TEST_CHANNEL_SECRET: process.env.TEST_CHANNEL_SECRET,
    OBSERVER_RETENTION_SECONDS: process.env.OBSERVER_RETENTION_SECONDS,
  };

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'info';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;
  process.env.REGIONS_FILE = regionsFile;
  process.env.REGION_NAME_PROPERTY = 'label';
  process.env.REGION_GROUP_PROPERTY = 'macro';
  process.env.TEST_CHANNEL_NAME = 'health-check';
  process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
  process.env.OBSERVER_RETENTION_SECONDS = '14400';

  const serverModule = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?regions-flat-test=${Date.now()}`
  );
  const {
    flushScheduledWrites,
    ingestMqttMessage,
    resetTestState,
    server,
  } = serverModule;

  let baseUrl = '';
  try {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    resetTestState();
    const locations = [
      { key: observerKeys[0], name: 'Alpha Observer', latitude: 0.5, longitude: 0.5 },
      { key: observerKeys[1], name: 'Beta Observer', latitude: 0.5, longitude: 1.5 },
    ];
    for (const location of locations) {
      ingestMqttMessage(
        `meshcore/TEST/${location.key}/status`,
        Buffer.from(JSON.stringify({
          name: location.name,
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
          },
        })),
      );
    }

    const response = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    // No group property: every feature is a top-level place.
    assert.deepEqual(payload.regionTree.map((node) => [node.code, node.parent, node.depth, node.count]), [
      ['alpha', '', 1, 1],
      ['beta', '', 1, 1],
    ]);
    const alpha = payload.observerDirectory.find((entry) => entry.key === observerKeys[0].toUpperCase());
    assert.deepEqual(alpha?.placePath, ['alpha']);
  } finally {
    flushScheduledWrites();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
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
});
