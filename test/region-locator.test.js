// Location opt-in (1.1.0). The browser picks a subregion from "Use my location"
// or "Use map center" by testing the point against /api/region-locator, so the
// coordinates never reach the server. This checks the three things that path
// depends on:
//   - every subregion finds a scope in the MeshCore scope tree's own county
//     outlines (no table);
//   - the served outlines are simplified, small, and still place a point in
//     the right subregion;
//   - the Permissions-Policy header lets this origin, and only this origin,
//     ask for location.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadMeshcoreScopes, scopeForSubregion } from '../lib/meshcore-scopes.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const BOUNDARY_PATH = path.join(REPO_DIR, 'regions/us-ca-bay-area.geojson');
const MESHCORE_SCOPES_PATH = path.join(REPO_DIR, 'regions/us-ca-meshcore-scopes.json');

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInFeature(lon, lat, feature) {
  const geometry = feature.geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((rings) => pointInRing(lon, lat, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(lon, lat, hole)));
}

async function loadServer(tag) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-locator-test-'));
  const env = {
    MESH_HEALTH_DISABLE_RUNTIME: 'true',
    TURNSTILE_ENABLED: 'false',
    LOG_LEVEL: 'warn',
    OBSERVERS_FILE: path.join(tempDir, 'observer.json'),
    OBSERVER_ACTIVITY_FILE: path.join(tempDir, 'observer-activity.json'),
    RESULTS_FILE: path.join(tempDir, 'session-results.json'),
    REGIONS_FILE: BOUNDARY_PATH,
    REGION_NAME_PROPERTY: 'name',
    REGION_GROUP_PROPERTY: 'group',
    MESHCORE_REGION_SCOPES_FILE: MESHCORE_SCOPES_PATH,
  };
  fs.writeFileSync(env.OBSERVERS_FILE, '{}\n', 'utf8');
  fs.writeFileSync(env.OBSERVER_ACTIVITY_FILE, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(env.RESULTS_FILE, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  const previous = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    return await import(`${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?locator-${tag}=${Date.now()}`);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('every shipped subregion finds its scope in the upstream tree\'s own outlines', () => {
  // No table: scopeForSubregion reads the county outlines in the scope file.
  const boundary = JSON.parse(fs.readFileSync(BOUNDARY_PATH, 'utf8'));
  const config = loadMeshcoreScopes(MESHCORE_SCOPES_PATH);
  const found = Object.fromEntries(boundary.features.map((feature) => [
    feature.properties.name, scopeForSubregion(config, feature.properties.name),
  ]));
  for (const [name, scope] of Object.entries(found)) {
    assert.ok(scope && config.regions.includes(scope), `${name} has no scope`);
  }
  // The deepest place wins: Sonoma is inside northbay and bayarea too.
  assert.equal(found.Sonoma, '#sonoma');
  // Counties whose scope is not named after them.
  assert.equal(found['San Francisco'], '#sf');
  assert.equal(found['San Mateo'], '#peninsula');
  assert.equal(found['Santa Clara'], '#southbay');
  assert.equal(found.Kings, '#kingscounty');
  // Alpine has no place of its own; eastsierra's outline lists it.
  assert.equal(found.Alpine, '#eastsierra');
  // Outline before name: the place named "San Luis Obispo" is the city.
  assert.equal(found['San Luis Obispo'], '#slo');
  // Matched by name: one upstream place for the two counties.
  assert.equal(found['Yuba-Sutter'], '#yubasutter');
  // Nothing to match, or no scope file: no scope.
  assert.equal(scopeForSubregion(config, 'Atlantis'), null);
  assert.equal(scopeForSubregion(loadMeshcoreScopes(''), 'Sonoma'), null);
});

test('simplifyRing keeps the ends and drops points inside the tolerance', async () => {
  const { simplifyRing } = await loadServer('simplify');
  const ring = [[0, 0], [1, 0.00001], [2, 0], [2, 2], [1, 2.00001], [0, 2], [0, 0]];
  const simplified = simplifyRing(ring, 0.001);
  assert.deepEqual(simplified, [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]);
  // A corner further out than the tolerance stays.
  const notched = [[0, 0], [1, 0.5], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.deepEqual(simplifyRing(notched, 0.001), notched);
  // Too short to simplify: returned as is.
  const tiny = [[0, 0], [1, 0], [1, 1], [0, 0]];
  assert.equal(simplifyRing(tiny, 10), tiny);
});

test('the locator serves simplified subregions that still place known points', async () => {
  const { regionLocatorCollection } = await loadServer('collection');
  const boundary = JSON.parse(fs.readFileSync(BOUNDARY_PATH, 'utf8'));
  const groups = [...new Set(boundary.features.map((feature) => feature.properties.group))];
  const payload = regionLocatorCollection(groups);

  assert.equal(payload.features.length, boundary.features.length);
  const sonoma = payload.features.find((feature) => feature.properties.name === 'Sonoma');
  assert.deepEqual(sonoma.properties, { name: 'Sonoma', group: 'North Bay', scope: 'sonoma' });
  // Small enough to fetch on a click: the full file is ~500 KB of coastline.
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(bytes < 360_000, `locator payload is ${bytes} bytes`);

  // Town centres, well inside their counties.
  const places = [
    ['Sonoma', -122.4580, 38.2919], // Sonoma plaza
    ['Napa', -122.2869, 38.2975],
    ['San Francisco', -122.4194, 37.7749],
    ['San Mateo', -122.3255, 37.5630],
    ['Santa Clara', -121.8863, 37.3382], // San Jose
    ['Fresno', -119.7871, 36.7378],
    ['Alpine', -119.8213, 38.6935], // Markleeville
  ];
  for (const [name, lon, lat] of places) {
    const hits = payload.features.filter((feature) => pointInFeature(lon, lat, feature));
    assert.deepEqual(hits.map((feature) => feature.properties.name), [name], `${lon},${lat}`);
  }
  // The Pacific, off Point Reyes, is in no subregion.
  assert.equal(payload.features.filter((feature) => pointInFeature(-123.3, 38.0, feature)).length, 0);

  // Only the groups asked for, the same rule as the map outlines.
  const northBay = regionLocatorCollection(['North Bay']);
  assert.deepEqual(
    [...new Set(northBay.features.map((feature) => feature.properties.group))],
    ['North Bay'],
  );
});

test('this origin may ask for location; nothing else is opened', async () => {
  const { app } = await loadServer('policy');
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/region-locator`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('permissions-policy'), 'camera=(), geolocation=(self), microphone=()');
    const payload = await response.json();
    assert.equal(payload.type, 'FeatureCollection');
  } finally {
    server.close();
  }
});
