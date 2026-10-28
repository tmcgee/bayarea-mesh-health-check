// Passive repeater scope evidence (bayarea.18): advert default scopes and scoped
// flood paths, end to end through ingestMqttMessage, plus the store on its own.
import './support/isolate-env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createScopeEvidence } from '../lib/scope-evidence.js';
import { loadMeshcoreScopes } from '../lib/meshcore-scopes.js';

const require = createRequire(import.meta.url);
const { calcTransportCodeForRegion } = require('@michaelhart/meshcore-decoder');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-evidence-'));
const scopesFile = path.join(tempDir, 'scopes.json');
const evidenceFile = path.join(tempDir, 'evidence.json');
const NAMES = ['#Fictional-Valley', '#Fictional-Ridge'];

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.LOG_LEVEL = 'warn';
process.env.OBSERVERS_FILE = path.join(tempDir, 'observer.json');
process.env.OBSERVER_ACTIVITY_FILE = path.join(tempDir, 'observer-activity.json');
process.env.RESULTS_FILE = path.join(tempDir, 'session-results.json');
process.env.MESHCORE_SCOPE_EVIDENCE_FILE = evidenceFile;
process.env.MESHCORE_REGION_SCOPES_FILE = scopesFile;
process.env.REGIONS_FILE = 'regions/us-ca-bay-area.geojson';
process.env.UPLINK_CODES_FILE = 'regions/us-ca-uplink-codes.json';
fs.writeFileSync(process.env.OBSERVERS_FILE, '{}\n');
fs.writeFileSync(process.env.OBSERVER_ACTIVITY_FILE, '{"version":1,"observers":{}}\n');
fs.writeFileSync(process.env.RESULTS_FILE, '{"version":1,"sessions":[]}\n');
fs.writeFileSync(scopesFile, JSON.stringify({ regions: NAMES }));

const OBSERVER = 'A1'.repeat(32);
const REPEATER = 'B2'.repeat(32);

// An unsigned advert: the decoder parses it without verifying the signature.
function advertPayload(key, name, timestamp, role = 2) {
  const body = Buffer.alloc(101);
  Buffer.from(key, 'hex').copy(body, 0);
  body.writeUInt32LE(timestamp, 32);
  body[100] = 0x80 | role; // has name + role
  return Buffer.concat([body, Buffer.from(name, 'utf8')]);
}

// header | [transport codes] | path len | path | payload
function packetHex({ payloadType, payload, scopeName = null, path: hops = [], routeType = null }) {
  const route = routeType ?? (scopeName ? 0 : 1);
  const header = Buffer.from([(payloadType << 2) | route]);
  const parts = [header];
  if (route === 0 || route === 3) {
    const codes = Buffer.alloc(4);
    codes.writeUInt16LE(scopeName ? calcTransportCodeForRegion(scopeName, payloadType, payload) : 0, 0);
    parts.push(codes);
  }
  parts.push(Buffer.from([hops.length]), Buffer.from(hops.join(''), 'hex'), payload);
  return Buffer.concat(parts).toString('hex');
}

let api;
let baseUrl;
before(async () => {
  api = await import(`${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?evidence=${Date.now()}`);
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${api.server.address().port}`;
});
after(async () => {
  api.flushScheduledWrites?.();
  await new Promise((resolve) => api.server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const send = (raw, observer = OBSERVER, code = 'SFO') => api.ingestMqttMessage(
  `meshcore/${code}/${observer}/packets`, Buffer.from(JSON.stringify({ raw })),
);
const evidence = async (query = '') => (await fetch(`${baseUrl}/api/meshcore-scope-evidence${query}`)).json();

test('a scoped advert records the repeater default scope; unscoped adverts are counted but listed only on request', async () => {
  api.resetTestState();
  send(packetHex({ payloadType: 4, payload: advertPayload(REPEATER, 'Ridge Rptr', 1000), scopeName: NAMES[0], path: ['C3'] }));
  send(packetHex({ payloadType: 4, payload: advertPayload('D4'.repeat(32), 'Plain Rptr', 1000) }));
  let body = await evidence();
  assert.deepEqual(body.matching, { enabled: true, count: 2 });
  assert.equal(body.advertisers, 2);
  assert.equal(body.scopedAdvertisers, 1);
  assert.equal(body.nodes.length, 1);
  assert.equal(body.nodes[0].name, 'Ridge Rptr');
  assert.equal(body.nodes[0].role, 'repeater');
  assert.deepEqual(body.nodes[0].advertScope, { state: 'known', names: [NAMES[0]] });
  // The advert's own path also counts as forwarding evidence.
  assert.equal(body.forwarders.length, 1);
  assert.equal(body.forwarders[0].hop, 'C3');
  assert.equal(body.forwarders[0].scopes[NAMES[0]].packets, 1);
  body = await evidence('?all=1');
  assert.equal(body.nodes.length, 2);
  assert.deepEqual(body.nodes.find((node) => node.name === 'Plain Rptr').advertScope, { state: 'unscoped', names: [] });
  const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  assert.deepEqual(bootstrap.scopeEvidence, { retentionDays: 7, advertisers: 2, scopedAdvertisers: 1, forwarderHops: 1 });
});

test('copies of one packet heard by several observers credit each hop once, and hops resolve to advertised repeaters', async () => {
  api.resetTestState();
  send(packetHex({ payloadType: 4, payload: advertPayload(REPEATER, 'Ridge Rptr', 1000) }));
  const payload = Buffer.from('0102030405060708090a0b0c0d0e0f', 'hex');
  const raw = packetHex({ payloadType: 2, payload, scopeName: NAMES[1], path: ['B2', 'E5'] });
  send(raw);
  send(raw, 'F6'.repeat(32));
  // Unscoped traffic and direct routes add nothing.
  send(packetHex({ payloadType: 2, payload, path: ['99'] }));
  send(packetHex({ payloadType: 2, payload, scopeName: NAMES[1], path: ['98'], routeType: 3 }));
  const body = await evidence();
  assert.deepEqual(body.forwarders.map((entry) => entry.hop).sort(), ['B2', 'E5']);
  const b2 = body.forwarders.find((entry) => entry.hop === 'B2');
  assert.equal(b2.scopes[NAMES[1]].packets, 1);
  assert.deepEqual(b2.candidates.map((item) => item.name), ['Ridge Rptr']);
  assert.equal(body.forwarders.find((entry) => entry.hop === 'E5').candidateCount, 0);
});

test('a scope not in the names file is kept as unlisted; out-of-area observers contribute nothing', async () => {
  api.resetTestState();
  const payload = Buffer.from('aabbccddeeff00112233', 'hex');
  send(packetHex({ payloadType: 2, payload, scopeName: '#not-in-the-file', path: ['A7'] }));
  let body = await evidence();
  assert.deepEqual(Object.keys(body.forwarders[0].scopes), ['(unlisted)']);
  api.resetTestState();
  // MCO (Orlando) is in the shipped table's out-of-area block.
  send(packetHex({ payloadType: 2, payload, scopeName: NAMES[0], path: ['A8'] }), 'F7'.repeat(32), 'MCO');
  send(packetHex({ payloadType: 4, payload: advertPayload(REPEATER, 'Far Rptr', 3000), scopeName: NAMES[0] }),
    'F7'.repeat(32), 'MCO');
  body = await evidence('?all=1');
  assert.equal(body.forwarders.length, 0);
  assert.equal(body.advertisers, 0);
});

test('evidence is written to its own file and survives a restart', async () => {
  api.resetTestState();
  send(packetHex({ payloadType: 4, payload: advertPayload(REPEATER, 'Ridge Rptr', 2000), scopeName: NAMES[0] }));
  api.flushScheduledWrites();
  const stored = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.nodes[0].key, REPEATER);
  const reloaded = await import(`${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?evidence-reload=${Date.now()}`);
  await new Promise((resolve) => reloaded.server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${reloaded.server.address().port}`;
    const body = await (await fetch(`${url}/api/meshcore-scope-evidence`)).json();
    assert.equal(body.scopedAdvertisers, 1);
    assert.deepEqual(body.nodes[0].advertScope, { state: 'known', names: [NAMES[0]] });
  } finally {
    await new Promise((resolve) => reloaded.server.close(resolve));
  }
});

test('the store: one count per advert, retention pruning, bounded size and defensive restore', () => {
  let now = 1_000_000;
  const store = createScopeEvidence({ now: () => now, maxNodes: 2, retentionMs: 1000 });
  const config = loadMeshcoreScopes(scopesFile);
  const payload = advertPayload(REPEATER, 'Ridge', 5);
  const packet = {
    routeType: 0, payloadType: 4, payloadBytes: payload, path: [], pathHashSize: 1,
    transportCodes: [calcTransportCodeForRegion(NAMES[0], 4, payload), 0],
  };
  const advert = { publicKey: REPEATER, name: 'Ridge', role: 'repeater', timestamp: 5 };
  store.notePacket(config, packet, advert);
  store.notePacket(config, packet, advert);
  assert.equal(store.view({ includeUnscoped: true }).nodes[0].scopedAdverts, 1);
  for (const key of ['C3', 'D4', 'E5']) {
    now += 1;
    store.notePacket(config, { ...packet, routeType: 1, transportCodes: null },
      { publicKey: key.repeat(32), name: key, role: 'repeater', timestamp: 1 });
  }
  assert.equal(store.size().nodes, 2, 'oldest entries dropped past maxNodes');
  now += 5000;
  assert.equal(store.view({ includeUnscoped: true }).nodes.length, 0, 'pruned after retention');
  store.restore({ version: 1, nodes: [{ key: 'not-a-key' }, { key: REPEATER, lastHeardAt: now, role: 'admin' }], hops: [{ hop: 'zz' }] });
  assert.equal(store.size().nodes, 1);
  assert.equal(store.view({ includeUnscoped: true }).nodes[0].role, null);
  store.restore({ version: 99, nodes: [{ key: REPEATER, lastHeardAt: now }] });
  assert.equal(store.size().nodes, 0, 'an unknown file version starts empty');
});
