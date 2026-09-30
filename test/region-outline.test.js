// The map draws one outline per region group, produced by dissolveRings in
// server.js: it deletes every border segment two subregions walk in opposite
// directions and stitches the rest into rings. That only works where
// neighbouring counties share exact vertices and wind the same way. Where they
// do not, the shared border survives as a line through the middle of the
// region, and the region reads as several polygons on the map.
//
// That is what the shipped file did until 2026-09-29: Mariposa, Alpine and
// the five San Joaquin South counties were simplified one county at a time,
// so their shared borders kept different vertices (up to ~300 m apart), and they
// wound the opposite way to the rest of the file. Sierra Foothills drew as three
// shapes and San Joaquin South carried stray interior lines. Nothing failed;
// this test is what would have said so.
//
// It checks the served outline of every group in the shipped boundary file:
//   - no ring passes through the same vertex twice (a pinch, where an interior
//     border meets the outline)
//   - no two outline edges cross
//   - every outline edge has the region on exactly one side. An interior
//     border that failed to cancel has the region on both sides; a gap between
//     two counties has it on neither.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const BOUNDARY_PATH = path.join(REPO_DIR, 'regions/us-ca-bay-area.geojson');

// ~10 m at these latitudes: well clear of the 5-decimal (~1 m) rounding of the
// served outline, and far narrower than any real part of a county.
const SIDE_OFFSET_DEG = 1e-4;

function polygonsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

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

function outlineProblems(rings, counties) {
  const problems = [];
  const key = (p) => `${p[0]},${p[1]}`;

  // Consecutive repeats are not pinches: the served outline is rounded to five
  // decimals, which merges source vertices under ~1 m apart (Contra Costa has a
  // pair 0.6 m apart) into a zero-length edge.
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

test('every region group in the shipped boundary file merges into a clean outline', async () => {
  const boundary = JSON.parse(fs.readFileSync(BOUNDARY_PATH, 'utf8'));
  const countiesByGroup = new Map();
  boundary.features.forEach((feature) => {
    const group = feature.properties.group;
    if (!countiesByGroup.has(group)) countiesByGroup.set(group, []);
    countiesByGroup.get(group).push(...polygonsOf(feature.geometry));
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-outline-test-'));
  const previousEnv = {};
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
  };
  fs.writeFileSync(env.OBSERVERS_FILE, '{}\n', 'utf8');
  fs.writeFileSync(env.OBSERVER_ACTIVITY_FILE, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(env.RESULTS_FILE, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  for (const [name, value] of Object.entries(env)) {
    previousEnv[name] = process.env[name];
    process.env[name] = value;
  }

  try {
    const { regionBoundaryCollection } = await import(
      `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?outline-test=${Date.now()}`
    );
    const groups = [...countiesByGroup.keys()];
    const payload = regionBoundaryCollection(groups);
    assert.deepEqual(
      payload.features.map((feature) => feature.properties.group).sort(),
      [...groups].sort(),
      'every group in the boundary file should get an outline',
    );

    const failures = [];
    for (const feature of payload.features) {
      const group = feature.properties.group;
      const rings = feature.geometry.coordinates.map((polygon) => polygon[0]);
      const problems = outlineProblems(rings, countiesByGroup.get(group));
      if (problems.length) {
        failures.push(`${group}: ${problems.length} problem(s), e.g. ${problems.slice(0, 3).join('; ')}`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
