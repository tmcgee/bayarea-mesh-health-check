// Distance for bridged copies when the bridge node is configured.
//
// A bridged copy keeps the original path and continues it on the far side
// (2026-11-23: 2F03 → E945 → 6236 → BD6E → …, where 6236 is BlackDiamondMine and
// BD6E is about 104 km away in Sacramento). The 6236 → BD6E leg is the bridge, not
// a radio hop, so it is left out of the total, the crow-flies line and Longest Packet.
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
process.env.BRIDGE_NODE_PREFIXES = '6236';

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?bridge-distance=${Date.now()}`
);
const { flushScheduledWrites, ingestMqttMessage, server, resetTestState } = serverModule;

// One degree of latitude apart each, on the equator-ish line lat 1.
const NODES = {
  first: { key: '2F03000000000000000000000000000000000000000000000000000000000001', name: 'First Hop', lat: 1, lon: 0 },
  second: { key: 'E945000000000000000000000000000000000000000000000000000000000002', name: 'Second Hop', lat: 1, lon: 1 },
  bridge: { key: '6236000000000000000000000000000000000000000000000000000000000003', name: 'Bridge Near', lat: 1, lon: 2 },
  farSide: { key: 'BD6E000000000000000000000000000000000000000000000000000000000004', name: 'Bridge Far', lat: 1, lon: 5 },
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

test('the bridge leg is left out of a bridged receipt and out of Longest Packet', async () => {
  const created = await createSession();
  const message = created.code;
  const timestamp = 1795413151;
  // Original: 2F03 → E945 → Direct Observer (1° then 0.5°, about 104 mi).
  hear(NODES.directObserver, { sender: 'KO6JOT-home', message, messageHash: '6B88DC8EAF9B1A53', timestamp, path: ['2F03', 'E945'] });
  // Bridged: 2F03 → E945 → 6236 ⇢ BD6E → Bridged Observer.
  hear(NODES.bridgedObserver, { sender: '↔ KO6JOT-home', message, messageHash: '7670604F556B9DC8', timestamp, path: ['2F03', 'E945', '6236', 'BD6E'] });

  const response = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await response.json();
  assert.equal(session.useCount, 1);
  const direct = session.receipts.find((receipt) => receipt.observerKey === NODES.directObserver.key);
  const bridged = session.receipts.find((receipt) => receipt.observerKey === NODES.bridgedObserver.key);

  assert.equal(bridged.viaBridge, true);
  assert.equal(bridged.bridgeHopIndex, 2);
  assert.equal(bridged.pathBridgeLeg.fromHash, '6236');
  assert.equal(bridged.pathBridgeLeg.toHash, 'BD6E');
  assert.equal(bridged.pathBridgeLeg.fromLabel, 'Bridge Near');
  assert.equal(bridged.pathBridgeLeg.toLabel, 'Bridge Far');
  // Three 1° legs remain (2F03-E945, E945-6236, BD6E-observer); the 3° bridge leg is gone.
  assert.equal(bridged.pathDistanceSegments.length, 3);
  assert.ok(!bridged.pathDistanceSegments.some((segment) => segment.fromHash === '6236' && segment.toHash === 'BD6E'));
  assert.equal(bridged.pathSpannedHopCount, 3);
  assert.equal(bridged.pathCrowFlies, null);
  assert.ok(bridged.pathDistance > 200 && bridged.pathDistance < 210, `got ${bridged.pathDistance}`);

  // Longest Packet is radio only: the direct receipt, though the bridged path is longer.
  assert.equal(direct.viaBridge, false);
  assert.ok(direct.pathDistance > 100 && direct.pathDistance < 108, `got ${direct.pathDistance}`);
  assert.equal(session.longestPacketDistance, direct.pathDistance);
});

test('the bridge node on the original side does not mark an original receipt', async () => {
  const created = await createSession();
  // The original also passes through 6236 on its own side, where the next leg is radio.
  hear(NODES.directObserver, { sender: 'Plain', message: created.code, messageHash: 'AB00000000000001', timestamp: 1795414000, path: ['2F03', '6236'] });
  const response = await fetch(`${baseUrl}/api/sessions/${created.id}`);
  const session = await response.json();
  const receipt = session.receipts[0];
  assert.equal(receipt.viaBridge, false);
  assert.equal(receipt.bridgeHopIndex, null);
  assert.equal(receipt.pathBridgeLeg, null);
  assert.ok(receipt.pathDistance > 0);
});
