// Regional scoring (1.1.0; keyed by place code since 1.2.0): the session payload
// carries one score per place at any depth, each computed over the observers
// placed there or below when the code was created, plus any that reported. The
// top-level score stays All.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGroupTextEnvelope } from './support/build-meshcore-fixture.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');

function squareFeature(properties, west, south, east, north) {
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Polygon',
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
  };
}

const key = (digit) => digit.repeat(64);
const ALPHA = [key('1'), key('2'), key('3')];
const BETA = key('4');
const GAMMA = [key('5'), key('6')];
const LATE = key('7');

test('session scores every place at every depth as of creation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-scope-test-'));
  const files = {
    OBSERVERS_FILE: path.join(tempDir, 'observer.json'),
    OBSERVER_ACTIVITY_FILE: path.join(tempDir, 'observer-activity.json'),
    RESULTS_FILE: path.join(tempDir, 'session-results.json'),
    REGIONS_FILE: path.join(tempDir, 'regions.geojson'),
  };
  fs.writeFileSync(files.OBSERVERS_FILE, '{}\n', 'utf8');
  fs.writeFileSync(files.OBSERVER_ACTIVITY_FILE, '{"version":1,"observers":{}}\n', 'utf8');
  fs.writeFileSync(files.RESULTS_FILE, '{"version":1,"sessions":[]}\n', 'utf8');
  fs.writeFileSync(files.REGIONS_FILE, `${JSON.stringify({
    type: 'FeatureCollection',
    features: [
      squareFeature({ label: 'Alpha', macro: 'North' }, 0, 0, 1, 1),
      squareFeature({ label: 'Beta', macro: 'North' }, 1, 0, 2, 1),
      squareFeature({ label: 'Gamma', macro: 'South', parentRegion: 'Hemisphere' }, 0, -1, 1, 0),
    ],
  })}\n`, 'utf8');

  const env = {
    ...files,
    MESH_HEALTH_DISABLE_RUNTIME: 'true',
    TURNSTILE_ENABLED: 'false',
    LOG_LEVEL: 'info',
    REGION_NAME_PROPERTY: 'label',
    REGION_GROUP_PROPERTY: 'macro',
    TEST_CHANNEL_NAME: 'health-check',
    TEST_CHANNEL_SECRET: 'E6D973AAC5101145AD3A3F3A0B3D52EB',
    OBSERVER_RETENTION_SECONDS: '14400',
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);

  const { flushScheduledWrites, ingestMqttMessage, resetTestState, server } = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?scope-test=${Date.now()}`
  );

  const place = (observerKey, latitude, longitude) => ingestMqttMessage(
    `meshcore/TEST/${observerKey}/status`,
    Buffer.from(JSON.stringify({ name: `Observer ${observerKey[0]}`, location: { latitude, longitude } })),
  );

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    resetTestState();

    for (const observerKey of ALPHA) place(observerKey, 0.5, 0.5);
    place(BETA, 0.5, 1.5);
    for (const observerKey of GAMMA) place(observerKey, -0.5, 0.5);

    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    // Beta moves into Gamma after the code exists. It stays a Beta observer for
    // this session: placement is taken at creation.
    place(BETA, -0.5, 0.5);
    // LATE appears in Gamma after creation and reports, so it joins the
    // denominator of every scope it sits in, as it joins All.
    place(LATE, -0.5, 0.5);

    const envelope = buildGroupTextEnvelope({
      secretHex: env.TEST_CHANNEL_SECRET,
      sender: 'Scope Tester',
      message: `scope ${created.code}`,
      messageHash: 'D1D1D1D1D1D1D1D1',
      timestamp: 1761000300,
    });
    for (const observerKey of [ALPHA[0], ALPHA[1], BETA, GAMMA[0], LATE]) {
      ingestMqttMessage(`meshcore/TEST/${observerKey}/packets`, Buffer.from(JSON.stringify(envelope)));
    }

    const session = await (await fetch(`${baseUrl}/api/sessions/${created.id}`)).json();

    // All: 6 active at creation plus LATE = 7; 5 reported.
    assert.equal(session.expectedCount, 7);
    assert.equal(session.observedCount, 5);
    assert.equal(session.healthPercent, 71);
    assert.equal(session.healthLabel, 'GOOD');
    // All counts the top-level places (1.2.0): Hemisphere, not its South.
    assert.deepEqual(session.regionCoverage, {
      reached: 2,
      total: 2,
      places: [
        { code: 'hemisphere', name: 'Hemisphere', observerCount: 3, seenCount: 2 },
        { code: 'north', name: 'North', observerCount: 4, seenCount: 3 },
      ],
    });

    const scopes = session.scopeScores;
    assert.deepEqual(Object.keys(scopes).sort(), ['alpha', 'beta', 'gamma', 'hemisphere', 'north', 'south']);

    const pick = (entry) => ({
      expectedCount: entry.expectedCount,
      observedCount: entry.observedCount,
      healthPercent: entry.healthPercent,
      healthRated: entry.healthRated,
      healthUnratedReason: entry.healthUnratedReason,
      healthLabel: entry.healthLabel,
    });
    assert.deepEqual(pick(scopes.alpha), {
      expectedCount: 3, observedCount: 2, healthPercent: 67, healthRated: true, healthUnratedReason: null, healthLabel: 'GOOD',
    });
    assert.equal(scopes.alpha.regionCoverage, null);
    // One observer: the percentage is real but too small a sample to grade.
    assert.deepEqual(pick(scopes.beta), {
      expectedCount: 1, observedCount: 1, healthPercent: 100, healthRated: false, healthUnratedReason: 'target-too-small', healthLabel: 'NOT RATED',
    });
    assert.deepEqual(pick(scopes.gamma), {
      expectedCount: 3, observedCount: 2, healthPercent: 67, healthRated: true, healthUnratedReason: null, healthLabel: 'GOOD',
    });
    assert.deepEqual(pick(scopes.north), {
      expectedCount: 4, observedCount: 3, healthPercent: 75, healthRated: true, healthUnratedReason: null, healthLabel: 'GOOD',
    });
    // A place's Regions Reached counts the level below it.
    assert.deepEqual(scopes.north.regionCoverage, {
      reached: 2,
      total: 2,
      places: [
        { code: 'alpha', name: 'Alpha', observerCount: 3, seenCount: 2 },
        { code: 'beta', name: 'Beta', observerCount: 1, seenCount: 1 },
      ],
    });
    assert.deepEqual(scopes.hemisphere.regionCoverage, {
      reached: 1,
      total: 1,
      places: [{ code: 'south', name: 'South', observerCount: 3, seenCount: 2 }],
    });
    assert.equal(scopes.hemisphere.expectedCount, 3);
    assert.equal(scopes.south.expectedCount, 3);

    // The placement snapshot is persisted with the session, keyed by observer.
    flushScheduledWrites();
    const stored = JSON.parse(fs.readFileSync(files.RESULTS_FILE, 'utf8'));
    const record = stored.sessions.find((entry) => entry.id === created.id);
    // Only the deepest code is stored; the path is derived from today's regions.
    assert.equal(record.activeObserverRegions, undefined);
    assert.deepEqual(record.activeObserverPlaces[BETA], { place: 'beta', coordinates: true });
    assert.equal(Object.keys(record.activeObserverPlaces).length, 6);
    assert.equal(record.activeObserverPlaces[LATE], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
