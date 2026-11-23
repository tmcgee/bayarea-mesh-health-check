// Distance for bridged copies when the bridge node is configured.
//
// A bridged copy keeps the original path and continues it on the far side. The
// bridge node is BD6E (💧Bridge-sacmesh.org, Sacramento). The hop before it is
// whichever Bay Area repeater the bridge's near side heard last, and it varies:
// 6236, 90FA and 6538 were all seen on 2026-11-23. The leg arriving at BD6E is the
// bridge, not a radio hop, so it is left out of the total, the crow-flies line and
// Longest Packet. The leg leaving BD6E is ordinary radio on the far side.
import './support/isolate-env.js';
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGroupTextEnvelope } from './support/build-meshcore-fixture.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-bridge-distance-'));
const observerFile = path.join(tempDir, 'observer.json');
const observerActivityFile = path.join(tempDir, 'observer-activity.json');
const resultsFile = path.join(tempDir, 'session-results.json');
fs.writeFileSync(observerFile, '{}\n', 'utf8');
fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.LOG_LEVEL = 'info';
process.env.OBSERVERS_FILE = observerFile;
process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
process.env.RESULTS_FILE = resultsFile;
process.env.TEST_CHANNEL_NAME = 'health-check';
process.env.TEST_CHANNEL_SECRET = SECRET;
process.env.OBSERVER_RETENTION_SECONDS = '14400';
process.env.BRIDGE_NODE_PREFIXES = 'BD6E';

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?bridge-distance=${Date.now()}`
);
const { flushScheduledWrites, ingestMqttMessage, server, resetTestState } = serverModule;

// One degree of longitude apart, along lat 1.
const NODES = {
  first: { key: '2F03000000000000000000000000000000000000000000000000000000000001', name: 'First Hop', lat: 1, lon: 0 },
  second: { key: 'E945000000000000000000000000000000000000000000000000000000000002', name: 'Second Hop', lat: 1, lon: 1 },
  lastBay: { key: '90FA000000000000000000000000000000000000000000000000000000000003', name: 'Last Bay Hop', lat: 1, lon: 2 },
  otherBay: { key: '6538000000000000000000000000000000000000000000000000000000000007', name: 'Other Bay Hop', lat: 1, lon: 1.5 },
  bridge: { key: 'BD6E333333280000000000000000000000000000000000000000000000000004', name: 'Bridge-sacmesh', lat: 1, lon: 5 },
  farHop: { key: '3903000000000000000000000000000000000000000000000000000000000008', name: 'Far Hop', lat: 1, lon: 5.5 },
  bridgedObserver: { key: 'A8DB000000000000000000000000000000000000000000000000000000000005', name: 'Bridged Observer', lat: 1, lon: 6 },
  directObserver: { key: 'EA54000000000000000000000000000000000000000000000000000000000006', name: 'Direct Observer', lat: 1, lon: 1.5 },
};

let baseUrl = '';

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  resetTestState();
  for (const node of Object.values(NODES)) {
    ingestMqttMessage(
      `meshcore/SFO/${node.key}/status`,
      Buffer.from(JSON.stringify({ name: node.name, location: { latitude: node.lat, longitude: node.lon } })),
    );
  }
});

after(async () => {
  flushScheduledWrites();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function createSession() {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 201);
  return response.json();
}

function hear(observer, fields) {
  const envelope = buildGroupTextEnvelope({ secretHex: SECRET, ...fields });
  ingestMqttMessage(`meshcore/SFO/${observer.key}/packets`, Buffer.from(JSON.stringify(envelope)));
}

test('the leg arriving at the bridge node is the bridge, and Longest Packet ignores it', async () => {
  const created = await createSession();
  const message = created.code;
  const timestamp = 1795413151;
  // Original: 2F03 → E945 → Direct Observer (1° then 0.5°, about 104 mi).
  hear(NODES.directObserver, { sender: 'KO6JOT-home', message, messageHash: '6B88DC8EAF9B1A53', timestamp, path: ['2F03', 'E945'] });
  // Bridged: 2F03 → E945 → 90FA ⇢ BD6E → 3903 → Bridged Observer (MHC-41C1FF shape).
  hear(NODES.bridgedObserver, { sender: '↔ KO6JOT-home', message, messageHash: '7670604F556B9DC8', timestamp, path: ['2F03', 'E945', '90FA', 'BD6E', '3903'] });

  const response = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await response.json();
  assert.equal(session.useCount, 1);
  const direct = session.receipts.find((receipt) => receipt.observerKey === NODES.directObserver.key);
  const bridged = session.receipts.find((receipt) => receipt.observerKey === NODES.bridgedObserver.key);

  assert.equal(bridged.viaBridge, true);
  assert.equal(bridged.bridgeHopIndex, 2);
  assert.equal(bridged.pathBridgeLeg.fromHash, '90FA');
  assert.equal(bridged.pathBridgeLeg.toHash, 'BD6E');
  assert.equal(bridged.pathBridgeLeg.fromLabel, 'Last Bay Hop');
  assert.equal(bridged.pathBridgeLeg.toLabel, 'Bridge-sacmesh');
  // The 3° bridge leg is gone. The far-side radio legs BD6E → 3903 → observer stay.
  assert.ok(!bridged.pathDistanceSegments.some((segment) => segment.fromHash === '90FA' && segment.toHash === 'BD6E'));
  assert.ok(bridged.pathDistanceSegments.some((segment) => segment.fromHash === 'BD6E' && segment.toHash === '3903'));
  assert.equal(bridged.pathDistanceSegments.length, 4);
  assert.equal(bridged.pathSpannedHopCount, 4);
  assert.equal(bridged.pathCrowFlies, null);
  // 1° + 1° + 0.5° + 0.5° = 3° of longitude near the equator, about 207 mi.
  assert.ok(bridged.pathDistance > 200 && bridged.pathDistance < 210, `got ${bridged.pathDistance}`);

  // Longest Packet is radio only: the direct receipt, though the bridged path is longer.
  assert.equal(direct.viaBridge, false);
  assert.ok(direct.pathDistance > 100 && direct.pathDistance < 108, `got ${direct.pathDistance}`);
  assert.equal(session.longestPacketDistance, direct.pathDistance);
});

test('whichever repeater precedes the bridge node, that leg is the bridge', async () => {
  const created = await createSession();
  // MHC-006457 shape: the near side heard 6538 last, not 90FA.
  hear(NODES.bridgedObserver, { sender: '↔ Other', message: created.code, messageHash: 'AC00000000000001', timestamp: 1795415000, path: ['2F03', '6538', 'BD6E'] });
  const response = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await response.json();
  const receipt = session.receipts[0];
  assert.equal(receipt.bridgeHopIndex, 1);
  assert.equal(receipt.pathBridgeLeg.fromHash, '6538');
  assert.equal(receipt.pathBridgeLeg.toHash, 'BD6E');
  // 2F03 → 6538 (1.5°) and BD6E → observer (1°) remain.
  assert.equal(receipt.pathDistanceSegments.length, 2);
  assert.ok(receipt.pathDistance > 170 && receipt.pathDistance < 176, `got ${receipt.pathDistance}`);
});

test('a bridge node in first place leaves the bridge leg unknown', async () => {
  const created = await createSession();
  // The leg into BD6E starts at the sender, which has no position in the path.
  hear(NODES.bridgedObserver, { sender: '↔ Edge', message: created.code, messageHash: 'AD00000000000001', timestamp: 1795416000, path: ['BD6E', '3903'] });
  const response = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await response.json();
  const receipt = session.receipts[0];
  assert.equal(receipt.viaBridge, true);
  assert.equal(receipt.bridgeHopIndex, null);
  assert.equal(receipt.pathBridgeLeg, null);
  assert.equal(receipt.pathDistance, null);
});

test('an original that passes the bridge node is not marked', async () => {
  const created = await createSession();
  // No bridge marker on the sender: a hop into BD6E here was radio.
  hear(NODES.bridgedObserver, { sender: 'Plain', message: created.code, messageHash: 'AB00000000000001', timestamp: 1795414000, path: ['2F03', '90FA', 'BD6E'] });
  const response = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await response.json();
  const receipt = session.receipts[0];
  assert.equal(receipt.viaBridge, false);
  assert.equal(receipt.bridgeHopIndex, null);
  assert.equal(receipt.pathBridgeLeg, null);
  assert.ok(receipt.pathDistance > 0);
});
