// lib/region-places.js (1.2.0): the shape library, overrides and the resolver
// that turns a MeshCore scope tree into places. Pure functions over a small
// synthetic library, so each rule of docs/design-scalable-regions.md §5.2-5.3
// is pinned on its own, without the Census file.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assignPlace, currentCode, loadShapeLibrary, parseOverrides, placeOutlinePolygons, placePath,
  comparePlaces, placeTree, resolveFlatBoundaries, resolvePlaces,
} from '../lib/region-places.js';

const square = (west, south, east, north) => ({
  type: 'Polygon',
  coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
});

// Testland, four counties in a row west to east (A, B, D) plus C above A.
//   C (0..1, 1..2)
//   A (0..1, 0..1)  B (1..2, 0..1)  D (2..3, 0..1)
// "Twin" appears twice, to exercise an ambiguous outline name.
const COUNTIES = [
  ['us-99001', 'Alder', square(0, 0, 1, 1)],
  ['us-99003', 'Birch', square(1, 0, 2, 1)],
  ['us-99005', 'Cedar', square(0, 1, 1, 2)],
  ['us-99007', 'Dogwood', square(2, 0, 3, 1)],
  ['us-99009', 'Twin', square(5, 5, 6, 6)],
  ['us-99011', 'Twin', square(7, 7, 8, 8)],
];

function writeLibrary(dir, { tamper = false, duplicate = false } = {}) {
  const features = COUNTIES.map(([id, name, geometry]) => ({
    type: 'Feature', properties: { id, name, kind: 'county', state: 'us-zz' }, geometry,
  }));
  if (duplicate) features.push({ ...features[0] });
  const text = `${JSON.stringify({ type: 'FeatureCollection', features })}\n`;
  fs.writeFileSync(path.join(dir, 'us-99.geojson'), tamper ? text.replace('Alder', 'Aldor') : text);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format: 1,
    files: {
      'us-99.geojson': {
        state: 'us-zz', stateName: 'Testland', stateFips: '99',
        sha256: crypto.createHash('sha256').update(text).digest('hex'),
      },
    },
  }));
}

function library(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-shapes-test-'));
  try {
    writeLibrary(dir, options);
    return loadShapeLibrary(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// matkam-shaped: the state is the root, places start below it.
function tree(places) {
  return { format: 2, root: [{ code: 'testland', name: 'Testland' }], places };
}

const SHAPED = () => tree([
  {
    code: 'west',
    name: 'West',
    outline: ['Alder', 'Cedar'],
    children: [
      { code: 'alder', name: 'Alder County', kind: 'county' },
      { code: 'cedar', name: 'Cedar', kind: 'county' },
    ],
  },
  {
    code: 'east',
    name: 'East',
    children: [
      { code: 'birch', name: 'Birch County', kind: 'county' },
      { code: 'dogwood', name: 'Dogwood County', kind: 'county' },
      { code: 'town', name: 'Some Town', kind: 'city' },
    ],
  },
  { code: 'later', name: 'Later', placeholder: true },
]);

test('the shape library checks every file against its manifest', () => {
  const lib = library();
  assert.equal(lib.shapes.size, COUNTIES.length);
  assert.equal(lib.shapes.get('us-99001').name, 'Alder');
  assert.equal(lib.states.get('us-zz').name, 'Testland');
  assert.match(lib.manifestSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => library({ tamper: true }), /SHA-256 does not match/);
  assert.throws(() => library({ duplicate: true }), /duplicate shape id us-99001/);
});

test('overrides accept the known keys only and refuse regroup', () => {
  const parsed = parseOverrides({ format: 1, coverage: ['west'], shapes: { east: ['us-99003'] }, exclude: [], renamed: { old: 'west' } });
  assert.deepEqual(parsed.coverage, ['west']);
  assert.deepEqual(parsed.shapes, { east: ['us-99003'] });
  assert.throws(() => parseOverrides({ format: 2 }), /format 1/);
  assert.throws(() => parseOverrides({ format: 1, colour: 'red' }), /unknown override keys: colour/);
  assert.throws(() => parseOverrides({ format: 1, regroup: { a: 'b' } }), /regroup overrides are not supported/);
  assert.throws(() => parseOverrides({ format: 1, coverage: [3] }), /coverage must be a list/);
  assert.throws(() => parseOverrides({ format: 1, shapes: { east: [] } }), /shapes.east must list shape ids/);
});

test('places resolve by outline, then county name, then children; others are point-only', () => {
  const resolved = resolvePlaces(SHAPED(), library());
  const get = (code) => resolved.byCode.get(code);
  assert.deepEqual(resolved.problems, []);
  assert.deepEqual(get('west').shapeIds, ['us-99001', 'us-99005']);
  assert.equal(get('west').source, 'outline');
  // "Alder County" matches the library's "Alder": the suffix is dropped.
  assert.deepEqual(get('alder').shapeIds, ['us-99001']);
  assert.equal(get('alder').source, 'name');
  assert.equal(get('cedar').source, 'name');
  assert.deepEqual([...get('east').shapeIds].sort(), ['us-99003', 'us-99007']);
  assert.equal(get('east').source, 'children');
  // A city is not matched by name: it has no shape of its own.
  assert.deepEqual(resolved.pointOnly, ['town']);
  // Placeholders are not places.
  assert.equal(get('later'), undefined);
  assert.deepEqual(get('dogwood').path, ['east', 'dogwood']);
  assert.equal(get('dogwood').depth, 2);
});

test('an overrides shape list wins, and naming problems are reported, not thrown', () => {
  const lib = library();
  const overridden = resolvePlaces(SHAPED(), lib, parseOverrides({ format: 1, shapes: { west: ['us-99001'] } }));
  assert.deepEqual(overridden.byCode.get('west').shapeIds, ['us-99001']);
  assert.equal(overridden.byCode.get('west').source, 'override');

  const broken = resolvePlaces(tree([
    { code: 'twin', name: 'Twin', outline: ['Twin'] },
    { code: 'ghost', name: 'Ghost', outline: ['Nowhere'] },
    { code: 'twin', name: 'Again' },
  ]), lib, parseOverrides({ format: 1, coverage: ['missing'], shapes: { ghost: ['us-00000'] } }));
  assert.deepEqual([...broken.problems].sort(), [
    'duplicate place code twin; the second is dropped',
    'ghost: override shapes not in the library: us-00000',
    'overrides name unknown place missing',
    'twin: outline "Twin" matches 2 shapes in us-zz',
  ]);
});

test('a point lands in the deepest covered place, then the smallest', () => {
  const resolved = resolvePlaces(SHAPED(), library());
  assert.equal(assignPlace(resolved, 0.5, 0.5).code, 'alder');
  assert.equal(assignPlace(resolved, 0.5, 1.5).code, 'cedar');
  assert.equal(assignPlace(resolved, 2.5, 0.5).code, 'dogwood');
  assert.equal(assignPlace(resolved, 9, 9), null);
  assert.equal(assignPlace(resolved, Number.NaN, 0), null);
  assert.deepEqual(placePath(resolved, 'dogwood'), ['east', 'dogwood']);
});

test('coverage narrows to listed subtrees, and an excluded place takes its ground with it', () => {
  const lib = library();
  const westOnly = resolvePlaces(SHAPED(), lib, parseOverrides({ format: 1, coverage: ['west'] }));
  assert.deepEqual(westOnly.candidates.map((entry) => entry.code).sort(), ['alder', 'cedar', 'west']);
  assert.equal(assignPlace(westOnly, 2.5, 0.5), null, 'east is outside coverage');

  // West's own outline lists Cedar too; excluding cedar must not leave that
  // ground covered by west.
  const noCedar = resolvePlaces(SHAPED(), lib, parseOverrides({ format: 1, exclude: ['cedar'] }));
  assert.equal(noCedar.byCode.get('cedar').covered, false);
  assert.deepEqual(noCedar.byCode.get('west').shapeIds, ['us-99001']);
  assert.equal(assignPlace(noCedar, 0.5, 1.5), null);
  assert.equal(assignPlace(noCedar, 0.5, 0.5).code, 'alder');
});

test('a partly covered place is outlined as its covered part only', () => {
  const lib = library();
  // Only dogwood is listed: east itself is not covered, so its outline is Dogwood's.
  const resolved = resolvePlaces(SHAPED(), lib, parseOverrides({ format: 1, coverage: ['dogwood'] }));
  assert.equal(resolved.byCode.get('east').covered, false);
  const outline = placeOutlinePolygons(resolved, 'east');
  assert.deepEqual(outline, lib.shapes.get('us-99007').polygons);
  const full = placeOutlinePolygons(resolvePlaces(SHAPED(), lib), 'east');
  assert.equal(full.length, 2);
});

test('the place tree lists places holding observers with their ancestors', () => {
  const resolved = resolvePlaces(SHAPED(), library());
  const nodes = placeTree(resolved, [
    { place: 'alder', inferred: false },
    { place: 'alder', inferred: false },
    { place: 'east', inferred: true },
    { place: 'nowhere', inferred: false },
  ]);
  assert.deepEqual(nodes.map((node) => [node.code, node.parent, node.depth, node.count, node.inferredCount, node.children]), [
    ['east', '', 1, 0, 1, []],
    ['west', '', 1, 2, 0, ['alder']],
    ['alder', 'west', 2, 2, 0, []],
  ]);
});

test('codes do not depend on where the state sits in the tree', () => {
  // matkam's tree has the state as its root; the North America tree has it as
  // a place. Every code below the state, its shapes and where a point lands
  // must come out the same, so a switch of trees (phase 3) moves no observer.
  const lib = library();
  const matkam = resolvePlaces(SHAPED(), lib);
  const northAmerica = resolvePlaces({
    format: 2,
    root: [{ code: 'na', name: 'North America' }],
    places: [{ code: 'us-zz', name: 'Testland', children: SHAPED().places }],
  }, lib);
  assert.deepEqual(northAmerica.problems, []);
  for (const entry of matkam.places) {
    const other = northAmerica.byCode.get(entry.code);
    assert.ok(other, `${entry.code} is missing under the North America tree`);
    assert.deepEqual(other.shapeIds, entry.shapeIds, entry.code);
    assert.deepEqual(other.path.slice(1), entry.path, entry.code);
  }
  for (const [lon, lat] of [[0.5, 0.5], [0.5, 1.5], [1.5, 0.5], [2.5, 0.5]]) {
    assert.equal(assignPlace(northAmerica, lon, lat).code, assignPlace(matkam, lon, lat).code);
  }
});

test('names, order and expand change how places read, never what they match', () => {
  const overrides = parseOverrides({
    format: 1,
    names: { alder: 'Alder', west: 'Zed West' },
    order: ['west', 'ghost'],
    expand: ['west', 'phantom'],
  });
  const resolved = resolvePlaces(SHAPED(), library(), overrides);
  // Alder County still matched its shape by the tree's name, then took the short one.
  assert.equal(resolved.byCode.get('alder').name, 'Alder');
  assert.equal(resolved.byCode.get('alder').source, 'name');
  assert.equal(resolved.byCode.get('west').name, 'Zed West');
  assert.deepEqual(resolved.problems.filter((problem) => /order|expand/.test(problem)).sort(), [
    'overrides.expand names unknown place phantom',
    'overrides.order names unknown place ghost',
  ]);

  const nodes = placeTree(resolved, [
    { place: 'alder', inferred: false },
    { place: 'birch', inferred: false },
    { place: 'dogwood', inferred: false },
  ]);
  // "Zed West" would sort last by name; the order list puts it first.
  assert.deepEqual(nodes.filter((node) => node.depth === 1).map((node) => node.code), ['west', 'east']);
  assert.deepEqual(nodes.find((node) => node.code === 'east').children, ['birch', 'dogwood']);
  assert.equal(nodes.find((node) => node.code === 'west').expand, true);
  assert.equal('expand' in nodes.find((node) => node.code === 'east'), false);

  // Unlisted siblings fall back to name; listed ones keep the list's order.
  const compare = comparePlaces({ order: new Map([['b', 0], ['a', 1]]) });
  const sorted = [{ code: 'c', name: 'A' }, { code: 'a', name: 'Z' }, { code: 'd', name: 'B' }, { code: 'b', name: 'Y' }].sort(compare);
  assert.deepEqual(sorted.map((entry) => entry.code), ['b', 'a', 'c', 'd']);

  assert.throws(() => parseOverrides({ format: 1, names: { west: '  ' } }), /names\.west must be a display name/);
  assert.throws(() => parseOverrides({ format: 1, order: 'west' }), /order must be a list/);
});

test('renamed codes read as their new code', () => {
  const resolved = resolvePlaces(SHAPED(), library(), parseOverrides({ format: 1, renamed: { westside: 'west' } }));
  assert.equal(currentCode(resolved, 'westside'), 'west');
  assert.equal(currentCode(resolved, 'west'), 'west');
  assert.equal(currentCode(resolved, 'gone'), '');
  assert.deepEqual(placePath(resolved, 'westside'), ['west']);
});

test('a flat boundary file becomes parent, group and subregion places', () => {
  const resolved = resolveFlatBoundaries([
    { name: 'Alpha', group: 'North', geometry: square(0, 0, 1, 1) },
    { name: 'Gamma', group: 'South', parentRegion: 'Hemisphere', geometry: square(0, -1, 1, 0) },
    { name: 'North', geometry: square(5, 5, 6, 6) },
  ]);
  assert.deepEqual(resolved.places.map((entry) => [entry.code, entry.path.join('/')]), [
    ['north', 'north'],
    ['alpha', 'north/alpha'],
    ['hemisphere', 'hemisphere'],
    ['south', 'hemisphere/south'],
    ['gamma', 'hemisphere/south/gamma'],
    // A name reused at another level gets a suffix, not a clash.
    ['north-2', 'north-2'],
  ]);
  assert.equal(assignPlace(resolved, 0.5, -0.5).code, 'gamma');
  assert.equal(assignPlace(resolved, 0.5, 0.5).code, 'alpha');
});
