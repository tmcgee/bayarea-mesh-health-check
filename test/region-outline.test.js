// The map draws one outline per place (1.2.0), produced by dissolveRings in
// server.js: it deletes every border segment two counties walk in opposite
// directions and stitches the rest into rings. That only works where
// neighbouring counties share exact vertices and wind the same way. Where they
// do not, the shared border survives as a line through the middle of the
// place, and the place reads as several polygons on the map.
//
// That is what the 1.1.0 boundary file did until 2026-09-29: Mariposa, Alpine
// and the five San Joaquin South counties were simplified one county at a
// time, so their shared borders kept different vertices (up to ~300 m apart).
// The 1.2.0 shape library is the Census file unsimplified, so this should hold
// by construction; this test is what would say otherwise.
//
// For every covered place with a shape it checks the dissolved outline, before
// simplification:
//   - no ring passes through the same vertex twice (a pinch, where an interior
//     border meets the outline)
//   - no two outline edges cross
//   - every outline edge has the place on exactly one side. An interior border
//     that failed to cancel has the place on both sides; a gap between two
//     counties has it on neither.
// and, on the served (simplified, rounded) outline, the first two only: the
// 50 m simplification moves edges further than any side offset small enough
// to sample a county with.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const SCOPES_PATH = path.join(REPO_DIR, 'regions/us-ca-meshcore-scopes.json');
const SHAPES_DIR = path.join(REPO_DIR, 'regions/shapes');
const OVERRIDES_PATH = path.join(REPO_DIR, 'regions/region-overrides.json');

// ~10 m at these latitudes: far narrower than any real part of a county, and
// the dissolved outline it samples is unrounded.
const SIDE_OFFSET_DEG = 1e-4;

function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonContains(polygon, x, y) {
  if (!ringContains(polygon[0], x, y)) return false;
  return !polygon.slice(1).some((hole) => ringContains(hole, x, y));
}

function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function outlineProblems(rings, counties, { sides = true } = {}) {
  const problems = [];
  const key = (p) => `${p[0]},${p[1]}`;

  // Consecutive repeats are not pinches: the served outline is rounded, which
  // merges nearby source vertices into a zero-length edge.
  const seen = new Map();
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const k = key(ring[i]);
      if (i > 0 && k === key(ring[i - 1])) continue;
      if (seen.has(k)) problems.push(`vertex ${k} visited twice`);
      seen.set(k, r);
    }
  });

  const edges = rings.flatMap((ring, r) => ring.slice(0, -1).map((p, i) => ({ r, i, a: p, b: ring[i + 1], n: ring.length - 1 })));
  const cell = 0.05;
  const grid = new Map();
  edges.forEach((edge, index) => {
    const x0 = Math.floor(Math.min(edge.a[0], edge.b[0]) / cell);
    const x1 = Math.floor(Math.max(edge.a[0], edge.b[0]) / cell);
    const y0 = Math.floor(Math.min(edge.a[1], edge.b[1]) / cell);
    const y1 = Math.floor(Math.max(edge.a[1], edge.b[1]) / cell);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(index);
      }
    }
  });
  const reported = new Set();
  grid.forEach((members) => {
    for (let p = 0; p < members.length; p += 1) {
      for (let q = p + 1; q < members.length; q += 1) {
        const e = edges[members[p]];
        const f = edges[members[q]];
        const pair = `${members[p]}:${members[q]}`;
        if (reported.has(pair)) continue;
        if (segmentsCross(e.a, e.b, f.a, f.b)) {
          reported.add(pair);
          problems.push(`edges cross near ${key(e.a)}`);
        }
      }
    }
  });

  if (!sides) return problems;
  const inGroup = (x, y) => counties.some((polygon) => polygonContains(polygon, x, y));
  edges.forEach(({ a, b }) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 5 * SIDE_OFFSET_DEG) return; // too short to sample both sides cleanly
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const nx = (-dy / length) * SIDE_OFFSET_DEG;
    const ny = (dx / length) * SIDE_OFFSET_DEG;
    const left = inGroup(mx + nx, my + ny);
    const right = inGroup(mx - nx, my - ny);
    if (left === right) {
      problems.push(`edge ${key(a)} -> ${key(b)} has the region on ${left ? 'both sides (an interior border)' : 'neither side (a gap)'}`);
    }
  });
  return problems;
}

test('every covered place dissolves into a clean outline', async () => {
  const { loadMeshcoreScopes } = await import('../lib/meshcore-scopes.js');
  const { loadOverrides, loadShapeLibrary, placeOutlinePolygons, resolvePlaces } = await import('../lib/region-places.js');
  const library = loadShapeLibrary(SHAPES_DIR);
  const resolved = resolvePlaces(loadMeshcoreScopes(SCOPES_PATH).tree, library, loadOverrides(OVERRIDES_PATH).overrides);
  const places = resolved.places.filter((entry) => entry.covered && entry.polygons.length);
  assert.ok(places.length >= 30, `only ${places.length} covered places with shapes`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-outline-test-'));
  const previousEnv = {};
  const env = {
    MESH_HEALTH_DISABLE_RUNTIME: 'true',
    TURNSTILE_ENABLED: 'false',
    LOG_LEVEL: 'warn',
    OBSERVERS_FILE: path.join(tempDir, 'observer.json'),
    OBSERVER_ACTIVITY_FILE: path.join(tempDir, 'observer-activity.json'),
    RESULTS_FILE: path.join(tempDir, 'session-results.json'),
    MESHCORE_REGION_SCOPES_FILE: SCOPES_PATH,
    REGION_SHAPES_DIR: SHAPES_DIR,
    REGION_OVERRIDES_FILE: OVERRIDES_PATH,
  };
  fs.writeFileSync(env.OBSERVERS_FILE, '{}\n', 'utf8');
  fs.writeFileSync(env.OBSERVER_ACTIVITY_FILE, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(env.RESULTS_FILE, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  for (const [name, value] of Object.entries(env)) {
    previousEnv[name] = process.env[name];
    process.env[name] = value;
  }

  try {
    const { placeOutlineGeometry, regionOutlineCollection } = await import(
      `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?outline-test=${Date.now()}`
    );
    const failures = [];
    for (const entry of places) {
      const counties = placeOutlinePolygons(resolved, entry.code);
      const rings = placeOutlineGeometry(entry.code).map((polygon) => polygon[0]);
      const problems = outlineProblems(rings, counties);
      if (problems.length) {
        failures.push(`${entry.code}: ${problems.length} problem(s), e.g. ${problems.slice(0, 3).join('; ')}`);
      }
    }

    // The served copy, as if every covered place held an observer.
    const tree = places.map((entry) => ({
      code: entry.code, name: entry.name, parent: entry.path.at(-2) || '', depth: entry.path.length,
    }));
    const payload = regionOutlineCollection(tree);
    assert.deepEqual(
      payload.features.map((feature) => feature.properties.code).sort(),
      tree.map((node) => node.code).sort(),
      'every covered place should get an outline',
    );
    for (const feature of payload.features) {
      const rings = feature.geometry.coordinates.map((polygon) => polygon[0]);
      const problems = outlineProblems(rings, [], { sides: false });
      if (problems.length) {
        failures.push(`${feature.properties.code} (served): ${problems.length} problem(s), e.g. ${problems.slice(0, 3).join('; ')}`);
      }
    }
    // The coarse copy the map loads first: no pinches or crossings either.
    for (const feature of payload.coarse.features) {
      const rings = feature.geometry.coordinates.map((polygon) => polygon[0]);
      const problems = outlineProblems(rings, [], { sides: false });
      if (problems.length) {
        failures.push(`${feature.properties.code} (coarse): ${problems.length} problem(s), e.g. ${problems.slice(0, 3).join('; ')}`);
      }
    }
    // Outlines are thinned together, so at either level a parent's outline is
    // made of its children's edges, vertex for vertex: the faint lines meet the
    // bold ones exactly, and neighbours never part along a shared border.
    for (const [label, collection] of [['full', payload], ['coarse', payload.coarse]]) {
      const edgesOf = (feature) => feature.geometry.coordinates.flatMap((polygon) => polygon.flatMap((ring) => ring.slice(1)
        .map((point, i) => [ring[i].join(','), point.join(',')].sort().join('|'))
        .filter((edge) => edge.split('|')[0] !== edge.split('|')[1])));
      for (const parent of collection.features) {
        const children = collection.features.filter((feature) => feature.properties.parent === parent.properties.code);
        if (!children.length) continue;
        const childEdges = new Set(children.flatMap(edgesOf));
        const stray = edgesOf(parent).filter((edge) => !childEdges.has(edge));
        if (stray.length) failures.push(`${parent.properties.code} (${label}): ${stray.length} outline edge(s) not on a child, e.g. ${stray[0]}`);
      }
    }
    assert.ok(JSON.stringify(payload.coarse).length < JSON.stringify(payload).length / 3, 'coarse should be well under a third of full');
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
