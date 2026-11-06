// seed-observers.py decides "inside the boundary" with the server's own
// resolver (1.2.0): scripts/region-candidates.js prints the covered places in
// match order, and the Python script tests points against them. This pins the
// helper to resolvePlaces, and the Python side to assignPlace on real towns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMeshcoreScopes } from '../lib/meshcore-scopes.js';
import { assignPlace, loadOverrides, loadShapeLibrary, resolvePlaces } from '../lib/region-places.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const ENV = {
  PATH: process.env.PATH,
  MESHCORE_REGION_SCOPES_FILE: 'regions/us-ca-meshcore-scopes.json',
  REGION_SHAPES_DIR: 'regions/shapes',
  REGION_OVERRIDES_FILE: 'regions/region-overrides.json',
};

function resolved() {
  return resolvePlaces(
    loadMeshcoreScopes(path.join(REPO_DIR, ENV.MESHCORE_REGION_SCOPES_FILE)).tree,
    loadShapeLibrary(path.join(REPO_DIR, ENV.REGION_SHAPES_DIR)),
    loadOverrides(path.join(REPO_DIR, ENV.REGION_OVERRIDES_FILE)).overrides,
  );
}

test('the candidates helper prints the resolver\'s candidates in match order', () => {
  const output = JSON.parse(execFileSync(process.execPath, ['scripts/region-candidates.js'], {
    cwd: REPO_DIR, env: ENV, maxBuffer: 16 * 1024 * 1024,
  }));
  const expected = resolved();
  assert.deepEqual(output.problems, []);
  assert.deepEqual(output.candidates.map((entry) => entry.code), expected.candidates.map((entry) => entry.code));
  for (const entry of output.candidates) {
    for (const id of entry.shapes) assert.ok(output.shapes[id], `${entry.code} names shape ${id}, which is not in the output`);
  }
});

test('the candidates helper fails loudly without a shape library', () => {
  const result = spawnSync(process.execPath, ['scripts/region-candidates.js'], {
    cwd: REPO_DIR, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REGION_SHAPES_DIR is not set/);
});

const python = spawnSync('python3', ['--version']).status === 0;

test('seed-observers.py keeps and drops the same points as the server', { skip: !python && 'python3 not installed' }, () => {
  // Town centres inside coverage, then points outside it: Eureka (Humboldt,
  // not covered), Reno (Nevada), Los Angeles (socal, not covered), the Pacific.
  const points = [
    [-122.4580, 38.2919], [-122.4194, 37.7749], [-121.8863, 37.3382], [-119.7871, 36.7378],
    [-119.8213, 38.6935], [-120.6596, 35.2828], [-121.6169, 39.1404], [-121.8375, 39.7285],
    [-124.1637, 40.8021], [-119.8138, 39.5296], [-118.2437, 34.0522], [-123.3, 38.0],
  ];
  const script = [
    'import json, runpy, sys',
    'seed = runpy.run_path("seed-observers.py", run_name="seed_test")',
    'regions = seed["load_regions"]()',
    'points = json.loads(sys.argv[1])',
    'print(json.dumps([bool(seed["region_for"](lon, lat, regions)) for lon, lat in points]))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, JSON.stringify(points)], {
    cwd: REPO_DIR, env: { ...ENV, SEED_NODE_BINARY: process.execPath }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const kept = JSON.parse(result.stdout.trim().split('\n').at(-1));
  const places = resolved();
  assert.deepEqual(kept, points.map(([lon, lat]) => Boolean(assignPlace(places, lon, lat))));
  assert.deepEqual(kept, [true, true, true, true, true, true, true, true, false, false, false, false]);
});
