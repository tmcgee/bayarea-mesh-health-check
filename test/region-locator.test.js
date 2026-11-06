// Location opt-in (1.1.0). The browser picks a place from "Use my location"
// or "Use map center" by testing the point against /api/region-locator, so the
// coordinates never reach the server. This checks the three things that path
// depends on:
//   - every covered place has a scope; in tree mode (1.2.0) the place code is
//     the scope, and points land where the scope tree says;
//   - the served outlines are simplified, small enough to fetch on a click,
//     and still place a point in the right place;
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
import { assignPlace, loadOverrides, loadShapeLibrary, resolvePlaces } from '../lib/region-places.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const MESHCORE_SCOPES_PATH = path.join(REPO_DIR, 'regions/us-ca-meshcore-scopes.json');
const SHAPES_DIR = path.join(REPO_DIR, 'regions/shapes');
const OVERRIDES_PATH = path.join(REPO_DIR, 'regions/region-overrides.json');

function resolvedRegions() {
  const config = loadMeshcoreScopes(MESHCORE_SCOPES_PATH);
  const resolved = resolvePlaces(config.tree, loadShapeLibrary(SHAPES_DIR), loadOverrides(OVERRIDES_PATH).overrides);
  return { config, resolved };
}

// Town centres, well inside their counties, and the place each lands in.
const TOWNS = [
  ['sonoma', -122.4580, 38.2919], // Sonoma plaza; inside northbay and bayarea too
  ['napa', -122.2869, 38.2975],
  ['sf', -122.4194, 37.7749],
  ['peninsula', -122.3255, 37.5630], // San Mateo
  ['southbay', -121.8863, 37.3382], // San Jose
  ['fresno', -119.7871, 36.7378],
  ['kingscounty', -119.6457, 36.3275], // Hanford
  ['eastsierra', -119.8213, 38.6935], // Markleeville, Alpine
  ['slo', -120.6596, 35.2828], // San Luis Obispo
  ['yubasutter', -121.6169, 39.1404], // Yuba City
];

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
    MESHCORE_REGION_SCOPES_FILE: MESHCORE_SCOPES_PATH,
    REGION_SHAPES_DIR: SHAPES_DIR,
    REGION_OVERRIDES_FILE: OVERRIDES_PATH,
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

test('every covered place is a scope, and towns land where the tree says', () => {
  const { config, resolved } = resolvedRegions();
  for (const entry of resolved.places.filter((place) => place.covered)) {
    assert.ok(config.regions.includes(`#${entry.code}`), `${entry.code} is not a scope in the tree`);
  }
  for (const [code, lon, lat] of TOWNS) {
    assert.equal(assignPlace(resolved, lon, lat)?.code, code, `${lon},${lat}`);
  }
  // Flat files still find scopes by name in the tree's own county outlines.
  assert.equal(scopeForSubregion(config, 'Sonoma'), '#sonoma');
  assert.equal(scopeForSubregion(config, 'Atlantis'), null);
  assert.equal(scopeForSubregion(loadMeshcoreScopes(''), 'Sonoma'), null);
});

test('shared-border simplification keeps ends, drops points inside the tolerance', async () => {
  const { simplifySharedOutlines } = await import('../lib/outline-simplify.js');
  const one = (ring) => [[[ring]]];
  // A lone ring: anchored at its smallest vertex, near-collinear points dropped.
  const ring = [[0, 0], [1, 0.00001], [2, 0], [2, 2], [1, 2.00001], [0, 2], [0, 0]];
  assert.deepEqual(simplifySharedOutlines(one(ring), 0.001)[0][0][0], [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]);
  // A corner further out than the tolerance stays.
  const notched = [[0, 0], [1, 0.5], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.deepEqual(simplifySharedOutlines(one(notched), 0.001)[0][0][0], notched);
  // A ring that would collapse is returned as it was.
  const tiny = [[0, 0], [1, 0], [1, 1], [0, 0]];
  assert.equal(simplifySharedOutlines(one(tiny), 10)[0][0][0], tiny);
});

test('neighbours thinned together keep the same border vertices', async () => {
  const { simplifySharedOutlines } = await import('../lib/outline-simplify.js');
  // West and East share a wiggly border x = 1 (+/- 0.01). Thinned alone at
  // 0.05, each would straighten it from its own anchor; together, the border is
  // one run with the same thinned vertices in both.
  const border = [];
  for (let i = 0; i <= 20; i += 1) border.push([1 + (i % 2 ? 0.01 : -0.01) * (i % 4 ? 1 : 0.5), i / 10]);
  border[10] = [1.2, 1]; // a bump past the tolerance, which both must keep
  // Both counter-clockwise, so East walks the border downwards.
  const west = [[0, 0], ...border, [0, 2], [0, 0]];
  const eastClosed = [[3, 0], [3, 2], ...[...border].reverse(), [3, 0]];
  const [w, e] = simplifySharedOutlines([[[west]], [[eastClosed]]], 0.05).map((g) => g[0][0]);
  const onBorder = (ring) => [...new Set(ring.filter(([x]) => x > 0.5 && x < 1.5).map((p) => p.join(',')))].sort();
  assert.deepEqual(onBorder(w), onBorder(e));
  assert.ok(onBorder(w).includes('1.2,1'), 'the bump past the tolerance stays');
  assert.ok(onBorder(w).length <= 5, `the border was thinned (${onBorder(w).length} of ${border.length} kept)`);
});

test('the locator serves simplified places that still place known points', async () => {
  const { regionOutlineCollection } = await loadServer('collection');
  const { resolved } = resolvedRegions();
  const covered = resolved.places.filter((entry) => entry.covered && entry.polygons.length);
  const tree = covered.map((entry) => ({
    code: entry.code, name: entry.name, parent: entry.path.at(-2) || '', depth: entry.path.length,
  }));
  const payload = regionOutlineCollection(tree);

  assert.equal(payload.features.length, covered.length);
  const sonoma = payload.features.find((feature) => feature.properties.code === 'sonoma');
  assert.deepEqual(sonoma.properties, { code: 'sonoma', name: 'Sonoma County', parent: 'northbay', depth: 3, scope: 'sonoma' });
  // Every covered place at once is the locator's worst case; it is fetched on
  // the first click only, as in 1.1.0.
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(bytes < 700_000, `locator payload is ${bytes} bytes`);

  // The deepest containing outline is the answer, as in placeFromPoint.
  for (const [code, lon, lat] of TOWNS) {
    const hits = payload.features
      .filter((feature) => pointInFeature(lon, lat, feature))
      .sort((left, right) => right.properties.depth - left.properties.depth);
    assert.equal(hits[0]?.properties.code, code, `${lon},${lat}`);
  }
  // The Pacific, off Point Reyes, is in no place.
  assert.equal(payload.features.filter((feature) => pointInFeature(-123.3, 38.0, feature)).length, 0);
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
