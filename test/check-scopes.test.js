// Read-only scope drift check (+bayarea.22). Offline: the shipped scope file is
// matkam/meshcore-settings data/regions.json at the pinned commit (1.1.0), so it is the
// pinned tree here too; the network is never used.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import {
  PINNED_COMMIT,
  PINNED_SHA256,
  SHIPPED_FILE,
  compareScopes,
  flattenTree,
  formatReport,
} from '../scripts/check-scopes.js';

const shipped = fs.readFileSync(SHIPPED_FILE, 'utf8');
const pinnedText = shipped;
const pinned = JSON.parse(pinnedText);
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
  const report = compareScopes({ shipped, pinned, current: pinned, pinnedText });
  assert.equal(report.drift, false);
  assert.equal(report.shippedMatchesPin, true);
});

test('the shipped scope file is the pinned upstream file, byte for byte', () => {
  assert.match(PINNED_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(createHash('sha256').update(fs.readFileSync(SHIPPED_FILE)).digest('hex'), PINNED_SHA256);
  assert.equal(pinned.format, 2);
  assert.equal(pinned.source, 'https://github.com/matkam/meshcore-settings');
});

test('a code renamed with the same outline is reported as a probable rename', () => {
  const current = clone();
  const valley = findPlace(current, 'centralvalley');
  valley.code = 'sanjoaquinvalley';
  valley.name = 'San Joaquin Valley';
  const report = compareScopes({ shipped, pinned, current, pinnedText });
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

  const report = compareScopes({ shipped, pinned, current, pinnedText });
  assert.equal(report.drift, true);
  assert.deepEqual(report.added, ['sanjose (San Jose, under southbay)']);
  assert.equal(report.removed.length, 1);
  assert.match(report.removed[0], /^tahoe /);
  const byCode = Object.fromEntries(report.changed.map((entry) => [entry.code, entry.fields]));
  assert.deepEqual(byCode.kingscounty, [{ field: 'parent', from: 'centralvalley', to: 'centralcoast' }]);
  assert.deepEqual(byCode.sonoma, [{ field: 'outline', gained: ['Marin'], lost: [] }]);
});

test('a hand edit to the shipped file is drift even when the repo has not moved', () => {
  const doc = clone();
  findPlace(doc, 'kern').code = 'bakersfield';
  const edited = `${JSON.stringify(doc, null, 2)}\n`;
  const report = compareScopes({ shipped: edited, pinned, current: pinned, pinnedText });
  assert.equal(report.drift, true);
  assert.equal(report.shippedMatchesPin, false);
  assert.deepEqual(report.shippedOnly, ['bakersfield']);
  assert.deepEqual(report.pinOnly, ['kern']);
});

test('tags count as scope names, and a new format is flagged', () => {
  const current = clone();
  current.tags = [{ code: 'sierraridges', name: 'Sierra ridges' }];
  current.format = 3;
  const report = compareScopes({ shipped, pinned, current, pinnedText });
  assert.equal(report.drift, true);
  assert.equal(report.formatChanged, true);
  assert.deepEqual(report.added, ['sierraridges (Sierra ridges)']);
  assert.throws(() => flattenTree({ format: 3, regions: [] }), /not a regions tree/);
});
