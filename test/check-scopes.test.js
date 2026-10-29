// Read-only scope drift check (+bayarea.22). Offline: compares against a committed copy
// of matkam/meshcore-settings data/regions.json at the pinned commit, never the network.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_COMMIT,
  SHIPPED_FILE,
  compareScopes,
  flattenTree,
  formatReport,
} from '../scripts/check-scopes.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(TEST_DIR, 'fixtures', `meshcore-settings-regions-${PINNED_COMMIT.slice(0, 8)}.json`);
const pinned = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const shippedFile = JSON.parse(fs.readFileSync(SHIPPED_FILE, 'utf8'));
const shipped = shippedFile.regions;
const clone = () => structuredClone(pinned);
const findPlace = (doc, code) => {
  const walk = (places) => {
    for (const place of places) {
      if (place.code === code) return place;
      const hit = walk(place.children || []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(doc.places);
};

test('the shipped scope list equals the pinned tree, in order', () => {
  const codes = flattenTree(pinned).map((entry) => entry.code);
  assert.equal(codes.length, 73);
  assert.deepEqual(shipped, codes);
  const report = compareScopes({ shipped, pinned, current: pinned });
  assert.equal(report.drift, false);
  assert.equal(report.shippedMatchesPin, true);
});

test('the pin in the script matches the commit named in the shipped file', () => {
  assert.match(PINNED_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(shippedFile._comment, new RegExp(`commit ${PINNED_COMMIT.slice(0, 8)}\\b`));
});

test('a code renamed with the same outline is reported as a probable rename', () => {
  const current = clone();
  const valley = findPlace(current, 'centralvalley');
  valley.code = 'sanjoaquinvalley';
  valley.name = 'San Joaquin Valley';
  const report = compareScopes({ shipped, pinned, current });
  assert.equal(report.drift, true);
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.removed, []);
  assert.equal(report.renamed.length, 1);
  assert.equal(report.renamed[0].from, 'centralvalley');
  assert.equal(report.renamed[0].to, 'sanjoaquinvalley');
  // Its eight counties now sit under the new code.
  assert.equal(report.changed.filter((entry) => entry.fields.some((f) => f.field === 'parent')).length, 8);
  assert.match(formatReport(report, { pinnedRef: PINNED_COMMIT, currentRef: 'main' }),
    /renamed\? centralvalley -> sanjoaquinvalley/);
});

test('added, removed, moved and re-outlined codes are each reported', () => {
  const current = clone();
  const southbay = findPlace(current, 'southbay');
  southbay.children = [...(southbay.children || []), { code: 'sanjose', name: 'San Jose', outline: ['Santa Clara'] }];
  const tahoe = findPlace(current, 'sierranevada');
  tahoe.children = tahoe.children.filter((child) => child.code !== 'tahoe');
  const cv = findPlace(current, 'centralvalley');
  const kings = cv.children.find((child) => child.code === 'kingscounty');
  cv.children = cv.children.filter((child) => child !== kings);
  findPlace(current, 'centralcoast').children.push(kings);
  findPlace(current, 'sonoma').outline = ['Sonoma', 'Marin'];

  const report = compareScopes({ shipped, pinned, current });
  assert.equal(report.drift, true);
  assert.deepEqual(report.added, ['sanjose (San Jose, under southbay)']);
  assert.equal(report.removed.length, 1);
  assert.match(report.removed[0], /^tahoe /);
  const byCode = Object.fromEntries(report.changed.map((entry) => [entry.code, entry.fields]));
  assert.deepEqual(byCode.kingscounty, [{ field: 'parent', from: 'centralvalley', to: 'centralcoast' }]);
  assert.deepEqual(byCode.sonoma, [{ field: 'outline', gained: ['Marin'], lost: [] }]);
});

test('a hand edit to the shipped list is drift even when the repo has not moved', () => {
  const edited = shipped.filter((name) => name !== 'kern').concat('#bakersfield');
  const report = compareScopes({ shipped: edited, pinned, current: pinned });
  assert.equal(report.drift, true);
  assert.equal(report.shippedMatchesPin, false);
  assert.deepEqual(report.shippedOnly, ['bakersfield']);
  assert.deepEqual(report.pinOnly, ['kern']);
});

test('tags count as scope names, and a new format is flagged', () => {
  const current = clone();
  current.tags = [{ code: 'sierraridges', name: 'Sierra ridges' }];
  current.format = 3;
  const report = compareScopes({ shipped, pinned, current });
  assert.equal(report.drift, true);
  assert.equal(report.formatChanged, true);
  assert.deepEqual(report.added, ['sierraridges (Sierra ridges)']);
  assert.throws(() => flattenTree({ format: 3, regions: [] }), /not a regions tree/);
});
