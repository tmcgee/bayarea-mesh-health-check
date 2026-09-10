// Consistency guards over the shipped region data files.
//
// These assert properties of `regions/us-ca-uplink-codes.json` and
// `regions/us-ca-bay-area.geojson` themselves, with no server booted. Every
// check here corresponds to a mistake that is easy to make by hand and that
// the running app either tolerates silently or reports only through a log
// line nobody reads:
//
//   - a code mapping to a group the boundary file does not define is dropped
//     at load with a warning (server.js loadUplinkCodes), so the observers it
//     was meant to place quietly lose their region
//   - a code listed in both blocks is contradictory; the loader resolves it by
//     skipping the `codes` entry, which is the opposite of what someone adding
//     an in-area code would expect
//   - a malformed code string fails normalizeUplinkCode and is ignored
//     entirely, in-area or not
//
// Kern County and the BFL/MCI reshuffle on 2026-09-10 were all hand edits to
// these two files, which is exactly the situation these guards exist for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const CODES_PATH = path.join(REPO_DIR, 'regions/us-ca-uplink-codes.json');
const BOUNDARY_PATH = path.join(REPO_DIR, 'regions/us-ca-bay-area.geojson');

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

test('every in-area code maps to a group the boundary file defines', () => {
  const codes = readJson(CODES_PATH);
  const boundary = readJson(BOUNDARY_PATH);
  const groups = new Set(
    boundary.features.map((feature) => feature.properties.group).filter(Boolean),
  );
  assert.ok(groups.size > 0, 'the boundary file must define at least one group');

  for (const [code, value] of codeEntries(codes.codes)) {
    const group = typeof value === 'string' ? value : value?.group;
    assert.ok(
      groups.has(group),
      `code ${code} maps to group "${group}", which no feature in the boundary file carries`,
    );
  }
});

test('every in-area code carries a label and a known confidence', () => {
  const codes = readJson(CODES_PATH);
  // Only these two are defined in the file's own header, and the value is read
  // straight through into the observer record, so a typo becomes data.
  const allowed = new Set(['observed', 'anticipated']);
  for (const [code, value] of codeEntries(codes.codes)) {
    assert.equal(typeof value, 'object', `code ${code} should be an object with group/label/confidence`);
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

test('boundary features carry the properties the server reads', () => {
  const boundary = readJson(BOUNDARY_PATH);
  assert.equal(boundary.type, 'FeatureCollection');
  assert.ok(Array.isArray(boundary.features) && boundary.features.length > 0);

  const names = new Set();
  const fipsCodes = new Set();
  for (const feature of boundary.features) {
    const { name, group, fips } = feature.properties || {};
    // REGION_NAME_PROPERTY=name and REGION_GROUP_PROPERTY=group in the Bay Area
    // env, so a feature missing either is unreachable from the region filter.
    assert.ok(String(name || '').trim(), 'a feature has no name');
    assert.ok(String(group || '').trim(), `feature ${name} has no group`);
    assert.match(String(fips || ''), /^\d{5}$/, `feature ${name} has no five-digit FIPS code`);
    assert.equal(name, name.trim(), `feature name "${name}" has surrounding whitespace`);
    assert.equal(group, group.trim(), `group "${group}" on ${name} has surrounding whitespace`);
    assert.ok(!names.has(name), `duplicate feature name ${name}`);
    assert.ok(!fipsCodes.has(fips), `duplicate FIPS code ${fips} on ${name}`);
    names.add(name);
    fipsCodes.add(fips);
  }
});

test('boundary geometry is closed and lands in Northern California', () => {
  const boundary = readJson(BOUNDARY_PATH);
  // A ring whose last point is not its first breaks ray casting at the seam,
  // and a coordinate pair written lat-first would silently move a county to
  // the far side of the planet. Both have to be caught here, because
  // deriveRegionInfo just returns no match and the observer loses its region
  // with no error anywhere.
  const bounds = { minLon: -125, maxLon: -117, minLat: 32, maxLat: 42 };

  for (const feature of boundary.features) {
    const { type, coordinates } = feature.geometry;
    assert.ok(type === 'Polygon' || type === 'MultiPolygon', `${feature.properties.name} is a ${type}`);
    const polygons = type === 'Polygon' ? [coordinates] : coordinates;

    for (const polygon of polygons) {
      for (const ring of polygon) {
        assert.ok(ring.length >= 4, `${feature.properties.name} has a ring with ${ring.length} points`);
        assert.deepEqual(
          ring[0],
          ring[ring.length - 1],
          `${feature.properties.name} has an unclosed ring`,
        );
        for (const [lon, lat] of ring) {
          assert.ok(
            lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat,
            `${feature.properties.name} has a vertex outside California at ${lon}, ${lat}`,
          );
        }
      }
    }
  }
});

test('the Bay Area env example points at files that exist', () => {
  // A rename that updates one side only fails at boot with a warning and no
  // regions at all, which looks like a code bug rather than a missing file.
  const env = fs.readFileSync(path.join(REPO_DIR, '.env.bayarea.example'), 'utf8');
  for (const key of ['REGIONS_FILE', 'UPLINK_CODES_FILE']) {
    const match = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
    assert.ok(match, `${key} is not set in .env.bayarea.example`);
    const target = path.join(REPO_DIR, match[1].trim());
    assert.ok(fs.existsSync(target), `${key} points at ${match[1].trim()}, which does not exist`);
  }
});
