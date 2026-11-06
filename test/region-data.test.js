// Consistency guards over the shipped region data files.
//
// These assert properties of the shipped region files themselves - the uplink
// codes, the shape library (regions/shapes/), the overrides and the scope tree
// (1.2.0) - with no server booted. Every check here corresponds to a mistake
// that is easy to make by hand and that the running app either tolerates
// silently or reports only through a log line nobody reads:
//
//   - a code mapping to a place the tree does not define is dropped at load
//     with a warning (server.js loadUplinkCodes), so the observers it was
//     meant to place quietly lose their region
//   - a code listed in both blocks is contradictory; the loader resolves it by
//     skipping the `codes` entry, which is the opposite of what someone adding
//     an in-area code would expect
//   - a malformed code string fails normalizeUplinkCode and is ignored
//     entirely, in-area or not
//
// Kern County and the BFL/MCI reshuffle on 2026-09-10 were all hand edits to
// these files, which is exactly the situation these guards exist for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMeshcoreScopes } from '../lib/meshcore-scopes.js';
import { loadOverrides, loadShapeLibrary, resolvePlaces } from '../lib/region-places.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const CODES_PATH = path.join(REPO_DIR, 'regions/us-ca-uplink-codes.json');
const SCOPES_PATH = path.join(REPO_DIR, 'regions/us-ca-meshcore-scopes.json');
const SHAPES_DIR = path.join(REPO_DIR, 'regions/shapes');
const OVERRIDES_PATH = path.join(REPO_DIR, 'regions/region-overrides.json');

function resolvedRegions() {
  const library = loadShapeLibrary(SHAPES_DIR);
  const { overrides } = loadOverrides(OVERRIDES_PATH);
  return { library, resolved: resolvePlaces(loadMeshcoreScopes(SCOPES_PATH).tree, library, overrides) };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Keys that carry documentation rather than a code. The loader skips them
// because they fail the code shape test, but the assertions below need to
// exclude them deliberately rather than by accident.
const META_KEYS = new Set(['$comment', 'version']);

function codeEntries(block) {
  return Object.entries(block || {}).filter(([key]) => !META_KEYS.has(key));
}

// Mirrors normalizeUplinkCode in server.js. Kept as a literal copy rather than
// an import because the point is to catch drift between the data and what the
// server will actually accept.
const CODE_SHAPE = /^[A-Z0-9]{3,4}$/;

test('every uplink code is a shape the server will accept', () => {
  const codes = readJson(CODES_PATH);
  for (const block of ['codes', 'outOfArea']) {
    for (const [code] of codeEntries(codes[block])) {
      assert.match(
        code,
        CODE_SHAPE,
        `${block}.${code} does not match normalizeUplinkCode, so the server ignores it`,
      );
    }
  }
});

test('no uplink code is both in-area and out-of-area', () => {
  const codes = readJson(CODES_PATH);
  const inArea = new Set(codeEntries(codes.codes).map(([code]) => code));
  const overlap = codeEntries(codes.outOfArea)
    .map(([code]) => code)
    .filter((code) => inArea.has(code));
  assert.deepEqual(
    overlap,
    [],
    'a code in both blocks is silently dropped from codes and stays excluded',
  );
});

test('every in-area code maps to a place the scope tree defines', () => {
  const codes = readJson(CODES_PATH);
  assert.equal(codes.version, 2, 'v2 codes name a place code; v1 group names are only read for old files');
  const { resolved } = resolvedRegions();
  for (const [code, value] of codeEntries(codes.codes)) {
    assert.ok(
      resolved.byCode.has(value?.place),
      `code ${code} maps to place "${value?.place}", which the scope tree does not define`,
    );
  }
});

test('every in-area code carries a label and a known confidence', () => {
  const codes = readJson(CODES_PATH);
  // Only these two are defined in the file's own header, and the value is read
  // straight through into the observer record, so a typo becomes data.
  const allowed = new Set(['observed', 'anticipated']);
  for (const [code, value] of codeEntries(codes.codes)) {
    assert.equal(typeof value, 'object', `code ${code} should be an object with place/label/confidence`);
    assert.ok(String(value.label || '').trim(), `code ${code} has no label`);
    assert.ok(
      allowed.has(String(value.confidence || '').trim().toLowerCase()),
      `code ${code} has confidence "${value.confidence}", which is neither observed nor anticipated`,
    );
  }
});

test('every out-of-area code records why it was excluded', () => {
  const codes = readJson(CODES_PATH);
  // The reason string is the only record of the decision. BFL sat on this list
  // for months on the strength of its note alone, and that note is what made
  // it reviewable when Kern County was brought in.
  for (const [code, reason] of codeEntries(codes.outOfArea)) {
    assert.ok(
      typeof reason === 'string' && reason.trim().length > 0,
      `out-of-area code ${code} has no stated reason`,
    );
  }
});

test('the shape library matches its manifest and is well formed', () => {
  // loadShapeLibrary throws on a SHA-256 mismatch, so a hand edit to a shape
  // file fails here rather than at boot.
  const { library } = resolvedRegions();
  const bounds = { minLon: -125, maxLon: -114, minLat: 32, maxLat: 42.1 };
  assert.equal(library.shapes.size, 58, 'all 58 California counties');
  for (const [id, shape] of library.shapes) {
    assert.match(id, /^us-06\d{3}$/, `shape id ${id} is not us-<state FIPS><county FIPS>`);
    assert.ok(String(shape.name || '').trim(), `${id} has no name`);
    for (const polygon of shape.polygons) {
      for (const ring of polygon) {
        // An unclosed ring breaks ray casting at the seam, and a lat-first pair
        // moves a county to the far side of the planet; either way the point
        // test just returns no match and the observer loses its region.
        assert.ok(ring.length >= 4, `${id} has a ring with ${ring.length} points`);
        assert.deepEqual(ring[0], ring[ring.length - 1], `${id} has an unclosed ring`);
        for (const [lon, lat] of ring) {
          assert.ok(
            lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat,
            `${id} has a vertex outside California at ${lon}, ${lat}`,
          );
        }
      }
    }
  }
});

test('the regions resolve with no problems', () => {
  const { resolved } = resolvedRegions();
  assert.deepEqual(resolved.problems, []);
});

test('coverage is exactly the 1.1.0 boundary', () => {
  // The 33 counties of regions/us-ca-bay-area.geojson (Yuba-Sutter counted as
  // its two counties), which 1.2.0 replaced. Widening coverage is a decision
  // to show and score observers in more counties, so it must change this list
  // on purpose.
  const { resolved } = resolvedRegions();
  const covered = [...new Set(resolved.candidates.flatMap((entry) => entry.shapeIds))].sort();
  assert.deepEqual(covered, [
    '001', '003', '005', '007', '009', '013', '017', '019', '029', '031', '039',
    '041', '043', '047', '053', '055', '061', '067', '069', '075', '077', '079',
    '081', '085', '087', '095', '097', '099', '101', '107', '109', '113', '115',
  ].map((county) => `us-06${county}`));
});

test('the Bay Area reads short, sorts first and opens subdivided', () => {
  const { resolved } = resolvedRegions();
  const bayArea = resolved.byCode.get('bayarea');
  assert.equal(bayArea.name, 'Bay Area');
  // Shapes still come from the tree: the nine counties, matched by their own names.
  assert.equal(bayArea.shapeIds.length, 9);
  assert.equal(resolved.order.get('bayarea'), 0);
  assert.deepEqual([...resolved.expand], ['bayarea']);
});

test('Yuba and Sutter are one place, as in the scope tree', () => {
  // matkam/meshcore-settings has one place for the two counties, `yubasutter`,
  // under `sacramentofoothills`, so there is one chip where that tree, and the
  // repeaters following it, have one.
  const { resolved } = resolvedRegions();
  const entry = resolved.byCode.get('yubasutter');
  assert.deepEqual([...entry.shapeIds].sort(), ['us-06101', 'us-06115']);
  assert.deepEqual(entry.path, ['sacramentofoothills', 'yubasutter']);
});

test('the Bay Area env example points at files that exist', () => {
  // A rename that updates one side only fails at boot with a warning and no
  // regions at all, which looks like a code bug rather than a missing file.
  const env = fs.readFileSync(path.join(REPO_DIR, '.env.bayarea.example'), 'utf8');
  for (const key of ['MESHCORE_REGION_SCOPES_FILE', 'REGION_SHAPES_DIR', 'REGION_OVERRIDES_FILE', 'UPLINK_CODES_FILE']) {
    const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
    assert.ok(match, `${key} is not set in .env.bayarea.example`);
    const target = path.join(REPO_DIR, match[1].trim());
    assert.ok(fs.existsSync(target), `${key} points at ${match[1].trim()}, which does not exist`);
  }
  assert.doesNotMatch(env, /^REGIONS_FILE=/m, 'REGIONS_FILE would be ignored next to REGION_SHAPES_DIR');
});
