// MeshCore routing-scope recognition (bayarea.17). Adapted from upstream
// test/region-scopes.test.js (v1.4.0): JSON instead of YAML, the fork's session API,
// and a check that the shipped Bay Area file loads.
import './support/isolate-env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGroupTextEnvelope } from './support/build-meshcore-fixture.js';
import {
  loadMeshcoreScopes,
  recognizeMeshcoreScope,
  recordedMeshcoreScopes,
} from '../lib/meshcore-scopes.js';

const require = createRequire(import.meta.url);
const decoder = require('@michaelhart/meshcore-decoder');
const { calcRegionKey, calcTransportCodeForRegion } = decoder;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-scopes-'));
const scopesFile = path.join(tempDir, 'scopes.json');
const SCOPE_NAMES = Array.from({ length: 200 }, (_, index) => `#Fictional-${index}`);

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.LOG_LEVEL = 'warn';
process.env.OBSERVERS_FILE = path.join(tempDir, 'observer.json');
process.env.OBSERVER_ACTIVITY_FILE = path.join(tempDir, 'observer-activity.json');
process.env.RESULTS_FILE = path.join(tempDir, 'session-results.json');
process.env.TEST_CHANNEL_NAME = 'health-check';
process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
fs.writeFileSync(process.env.OBSERVERS_FILE, '{}\n');
fs.writeFileSync(process.env.OBSERVER_ACTIVITY_FILE, '{"version":1,"observers":{}}\n');
fs.writeFileSync(process.env.RESULTS_FILE, '{"version":1,"sessions":[]}\n');
fs.writeFileSync(scopesFile, JSON.stringify({ regions: SCOPE_NAMES }));

let importCounter = 0;
function importServer(scopesSetting) {
  process.env.MESHCORE_REGION_SCOPES_FILE = scopesSetting;
  importCounter += 1;
  return import(`${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?scopes=${Date.now()}-${importCounter}`);
}

async function listen(serverModule) {
  await new Promise((resolve) => serverModule.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${serverModule.server.address().port}`;
}

async function close(serverModule) {
  serverModule.flushScheduledWrites?.();
  await new Promise((resolve) => serverModule.server.close(resolve));
}

// Rewrite a fixture flood packet (header 0x15, empty path) as a transport packet.
function scoped(envelope, code, route = 0) {
  const bytes = Buffer.from(envelope.raw, 'hex');
  const transport = Buffer.alloc(4);
  transport.writeUInt16LE(code);
  transport.writeUInt16LE(54321, 2);
  return {
    ...envelope,
    raw: Buffer.concat([Buffer.from([(5 << 2) | route]), transport, bytes.subarray(1)]).toString('hex'),
  };
}

let api;
let baseUrl;
before(async () => {
  api = await importServer(scopesFile);
  baseUrl = await listen(api);
});
after(async () => {
  await close(api);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the shipped Bay Area scopes file loads', () => {
  const config = loadMeshcoreScopes(path.join(REPO_DIR, 'regions/us-ca-meshcore-scopes.json'));
  assert.equal(config.enabled, true);
  assert.ok(Array.isArray(config.regions));
  // The California tree from matkam/meshcore-settings: root chain, regions and the
  // Bay Area areas a local repeater carries. The file lists bare names; the loader
  // stores them with the implicit '#' the key is derived from.
  for (const name of ['us', 'west', 'california', 'bayarea', 'northbay', 'sonoma', 'centralcoast', 'slo']) {
    assert.ok(config.regions.includes(`#${name}`), `${name} should be listed`);
  }
  // A packet scoped to one of those names is recognised by that name.
  const payloadBytes = Buffer.from('shipped scope payload');
  const code = calcTransportCodeForRegion('sonoma', 5, payloadBytes);
  const result = recognizeMeshcoreScope(config, { routeType: 0, payloadType: 5, payloadBytes, transportCodes: [code, 0] });
  assert.ok(result.names.includes('#sonoma'));
  assert.ok(['known', 'ambiguous'].includes(result.state));
});

test('the loader accepts only a bounded public-name JSON list and fails loudly otherwise', () => {
  assert.deepEqual(loadMeshcoreScopes(''), { enabled: false, regions: [] });
  const file = path.join(tempDir, 'loader.json');
  const load = (text) => {
    fs.writeFileSync(file, text);
    return loadMeshcoreScopes(file);
  };
  assert.deepEqual(load('{"regions": []}'), { enabled: true, regions: [] });
  assert.deepEqual(load('{"_comment": "why", "regions": ["#Fictional-Cloud", "Fictional-Moon"]}').regions,
    ['#Fictional-Cloud', '#Fictional-Moon']);
  for (const text of [
    '[', '', '[]', '{"regions": "no"}', '{"regions": [null]}', '{"regions": [42]}', '{"regions": [""]}',
    '{"regions": ["#"]}', '{"regions": ["$private"]}', '{"regions": ["#$private"]}', '{"regions": ["*"]}',
    '{"regions": [" a"]}', '{"regions": ["a", "#a"]}', '{"regions": [], "extra": true}',
    '{"regions": [], "_comment": 5}', `{"regions": [${Array(1025).fill('"a"').join(',')}]}`, ' '.repeat(65537),
  ]) {
    assert.throws(() => load(text), /MESHCORE_REGION_SCOPES_FILE/, text.slice(0, 60));
  }
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
  assert.throws(() => loadMeshcoreScopes(file), /MESHCORE_REGION_SCOPES_FILE/);
  assert.throws(() => loadMeshcoreScopes(path.join(tempDir, 'missing.json')), /MESHCORE_REGION_SCOPES_FILE/);
  assert.throws(() => loadMeshcoreScopes(tempDir), /MESHCORE_REGION_SCOPES_FILE/);
});

test('names follow firmware characters and the 30-byte storage limit, never truncated', () => {
  const file = path.join(tempDir, 'names.json');
  const load = (name) => {
    fs.writeFileSync(file, JSON.stringify({ regions: [name] }));
    return loadMeshcoreScopes(file).regions;
  };
  for (const name of ['Fictional-Cloud', '#Fictional-Moon', 'a'.repeat(30), `#${'a'.repeat(29)}`,
    '\u00e9'.repeat(15), `#${'\u00e9'.repeat(14)}a`, 'A_Z[Q]^R']) {
    assert.deepEqual(load(name), [name.startsWith('#') ? name : `#${name}`]);
  }
  for (const name of ['a.b', 'a/b', 'a:b', 'a@b', 'a,b', 'a'.repeat(31), `#${'a'.repeat(30)}`,
    `${'\u00e9'.repeat(15)}a`, `#${'\u00e9'.repeat(15)}`]) {
    assert.throws(() => load(name), /MESHCORE_REGION_SCOPES_FILE.*(firmware|30 UTF-8 bytes)/, name);
  }
});

test('recognition states: known, ambiguous, unknown, unscoped, disabled and unavailable', () => {
  const payloadBytes = Buffer.from('0102030405060708090a0b0c0d0e0f10111213', 'hex');
  const code = calcTransportCodeForRegion('#Fictional-Cloud', 5, payloadBytes);
  const packet = { routeType: 0, payloadType: 5, payloadBytes, transportCodes: [code, 0] };
  assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: ['#Fictional-Cloud', '#fictional-cloud'] }, packet),
    { state: 'known', names: ['#Fictional-Cloud'] });
  assert.deepEqual(recognizeMeshcoreScope({ enabled: false, regions: [] }, packet), { state: 'disabled', names: [] });
  assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: [] }, packet), { state: 'unknown', names: [] });
  assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: ['#Fictional-Cloud'] },
    { ...packet, payloadBytes: Buffer.from('different encrypted payload') }), { state: 'unknown', names: [] });
  for (const incomplete of [null, { ...packet, payloadType: 4 }, { ...packet, payloadBytes: null },
    { ...packet, transportCodes: [] }]) {
    assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: [] }, incomplete), { state: 'unavailable', names: [] });
  }
  for (const ordinary of [1, 2]) {
    assert.equal(recognizeMeshcoreScope({ enabled: false, regions: [] }, { ...packet, routeType: ordinary }).state, 'unscoped');
  }
  assert.equal(recognizeMeshcoreScope({ enabled: false, regions: [] }, { ...packet, transportCodes: [0, code] }).state, 'unscoped');
  assert.deepEqual(recordedMeshcoreScopes(undefined), [{ state: 'not-present', names: [] }]);
  // A real 16-bit collision between two synthetic names on the same payload.
  const codes = new Map();
  let pair;
  for (let index = 0; index < 1024 && !pair; index += 1) {
    const name = `#Fictional-Collision-${index}`;
    const candidate = calcTransportCodeForRegion(name, 5, payloadBytes);
    if (codes.has(candidate)) {
      pair = [codes.get(candidate), name];
      packet.transportCodes = [candidate, 555];
    }
    codes.set(candidate, name);
  }
  assert.ok(pair, 'synthetic collision found');
  assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: pair }, packet), { state: 'ambiguous', names: pair });
});

test('matching agrees with the decoder, handles reserved codes and reads only the first code', () => {
  const config = { enabled: true, regions: Array.from({ length: 64 }, (_, index) => `#Fictional-Parity-${index}`) };
  for (const size of [1, 19, 180]) {
    const payloadBytes = Buffer.alloc(size, 0xab);
    const code = calcTransportCodeForRegion(config.regions[0], 5, payloadBytes);
    const names = config.regions.filter((name) => calcTransportCodeForRegion(name, 5, payloadBytes) === code);
    const packet = { routeType: 3, payloadType: 5, payloadBytes, transportCodes: [code, 12345] };
    assert.deepEqual(recognizeMeshcoreScope(config, packet), { state: names.length > 1 ? 'ambiguous' : 'known', names });
    assert.deepEqual(recognizeMeshcoreScope(config, { ...packet, transportCodes: [code, 54321] }),
      recognizeMeshcoreScope(config, packet));
  }
  const name = '#Fictional-Reserved';
  for (const [hex, rawCode, code] of [['347d0000', 0, 1], ['fa320000', 65535, 65534]]) {
    const payloadBytes = Buffer.from(hex, 'hex');
    assert.equal(createHmac('sha256', calcRegionKey(name)).update(Buffer.from([5])).update(payloadBytes).digest()
      .readUInt16LE(), rawCode);
    assert.equal(calcTransportCodeForRegion(name, 5, payloadBytes), code);
    const packet = { routeType: 0, payloadType: 5, payloadBytes, transportCodes: [code, 0] };
    assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: [name] }, packet), { state: 'known', names: [name] });
    assert.deepEqual(recognizeMeshcoreScope({ enabled: true, regions: [name] }, { ...packet, transportCodes: [12345, code] }),
      { state: 'unknown', names: [] });
  }
});

test('region keys are prepared once per list, not per packet', () => {
  // The decoder's exports are getters, so they are swapped by descriptor and restored the same way.
  const descriptors = {
    calcRegionKey: Object.getOwnPropertyDescriptor(decoder, 'calcRegionKey'),
    calcTransportCode: Object.getOwnPropertyDescriptor(decoder, 'calcTransportCode'),
  };
  const originals = { calcRegionKey: decoder.calcRegionKey, calcTransportCode: decoder.calcTransportCode };
  const swap = (name, value) => Object.defineProperty(decoder, name, { configurable: true, value });
  let keyCalls = 0;
  let codeCalls = 0;
  const payloadBytes = Buffer.alloc(180, 0xab);
  const regionNames = ['#Fictional-Cloud', '#Fictional-Moon'];
  const code = calcTransportCodeForRegion(regionNames[0], 5, payloadBytes);
  swap('calcRegionKey', (...args) => { keyCalls += 1; return originals.calcRegionKey(...args); });
  swap('calcTransportCode', (...args) => {
    codeCalls += 1;
    assert.strictEqual(args[2], payloadBytes, 'one binary payload reused for every comparison');
    return originals.calcTransportCode(...args);
  });
  try {
    const file = path.join(tempDir, 'cache.json');
    fs.writeFileSync(file, JSON.stringify({ regions: regionNames }));
    const config = loadMeshcoreScopes(file);
    assert.equal(keyCalls, 2, 'keys prepared at startup');
    const packet = { routeType: 0, payloadType: 5, payloadBytes, transportCodes: [code, 42] };
    const expected = { state: 'known', names: [regionNames[0]] };
    assert.deepEqual(recognizeMeshcoreScope(config, packet), expected);
    assert.deepEqual(recognizeMeshcoreScope(config, packet), expected);
    assert.equal(keyCalls, 2);
    assert.equal(codeCalls, 4);
    const direct = { enabled: true, regions: [...regionNames] };
    recognizeMeshcoreScope(direct, packet);
    recognizeMeshcoreScope(direct, packet);
    assert.equal(keyCalls, 4, 'a plain configuration also reuses its prepared keys');
    direct.regions[0] = '#Fictional-Replacement';
    assert.deepEqual(recognizeMeshcoreScope(direct, packet), { state: 'unknown', names: [] });
    assert.equal(keyCalls, 6, 'a mutated list never uses stale keys');
    recognizeMeshcoreScope({ enabled: false, regions: ['#Fictional-Unused'] }, packet);
    recognizeMeshcoreScope(direct, { ...packet, transportCodes: [0, code] });
    assert.equal(keyCalls, 6, 'disabled and unscoped packets prepare no keys');
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) Object.defineProperty(decoder, name, descriptor);
  }
});

test('receipts record each observer\'s scope without changing the score, and stored scopes survive config changes', async () => {
  api.resetTestState();
  const keys = ['1'.repeat(64), '2'.repeat(64)];
  for (const key of keys) {
    api.ingestMqttMessage(`meshcore/LAB/${key}/status`, Buffer.from(JSON.stringify({ name: 'Synthetic observer' })));
  }
  const created = await (await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedObserverKeys: keys }),
  })).json();
  const envelope = buildGroupTextEnvelope({
    secretHex: process.env.TEST_CHANNEL_SECRET,
    sender: 'Synthetic Scope',
    message: `scope ${created.code}`,
    messageHash: 'AABBCCDD11223344',
    timestamp: 1760000000,
  });
  const ingest = (env, key = keys[0]) => api.ingestMqttMessage(`meshcore/LAB/${key}/packets`, Buffer.from(JSON.stringify(env)));
  const get = async () => (await fetch(`${baseUrl}/api/sessions/${created.id}`)).json();
  const payload = Buffer.from(envelope.raw, 'hex').subarray(2);
  const code = calcTransportCodeForRegion(SCOPE_NAMES[0], 5, payload);
  const expectedNames = SCOPE_NAMES.filter((name) => calcTransportCodeForRegion(name, 5, payload) === code);

  ingest(scoped(envelope, code));
  let result = await get();
  assert.deepEqual(result.receipts[0].meshcoreScopes,
    [{ state: expectedNames.length > 1 ? 'ambiguous' : 'known', names: expectedNames }]);
  const scopedScore = { observed: result.observedCount, percent: result.healthPercent };

  ingest(envelope); // the same observer hears an unscoped copy: added, never written over
  ingest(scoped(envelope, 0), keys[1]); // transport code 0 is unscoped
  result = await get();
  const first = result.receipts.find((receipt) => receipt.observerKey.toUpperCase() === keys[0].toUpperCase());
  const second = result.receipts.find((receipt) => receipt.observerKey.toUpperCase() === keys[1].toUpperCase());
  assert.equal(first.count, 2);
  assert.equal(first.meshcoreScopes.length, 2);
  assert.deepEqual(first.meshcoreScopes.at(-1), { state: 'unscoped', names: [] });
  assert.deepEqual(second.meshcoreScopes, [{ state: 'unscoped', names: [] }]);
  assert.equal(result.observedCount, scopedScore.observed + 1, 'scope never changes who counts');

  let unknown = 1;
  while (SCOPE_NAMES.some((name) => calcTransportCodeForRegion(name, 5, payload) === unknown)) unknown += 1;
  ingest(scoped(envelope, unknown, 3));
  result = await get();
  assert.deepEqual(result.receipts.find((receipt) => receipt.observerKey.toUpperCase() === keys[0].toUpperCase())
    .meshcoreScopes.at(-1), { state: 'unknown', names: [] });
  const before = structuredClone(result.receipts);
  const scopesByObserver = (receipts) => Object.fromEntries(
    receipts.map((receipt) => [receipt.observerKey.toUpperCase(), receipt.meshcoreScopes]),
  );

  ingest({ ...envelope, raw: '140100' }); // a truncated transport packet adds nothing
  assert.deepEqual((await get()).receipts, before);
  api.flushScheduledWrites();

  // Stored observations are never recalculated against a changed or disabled file.
  fs.writeFileSync(scopesFile, JSON.stringify({ regions: ['#Fictional-Replacement'] }));
  for (const setting of ['', scopesFile]) {
    const reloaded = await importServer(setting);
    const url = await listen(reloaded);
    try {
      const restored = await (await fetch(`${url}/api/sessions/${created.id}`)).json();
      // Observer labels come from live state, which a fresh import has not learned.
      assert.deepEqual(scopesByObserver(restored.receipts), scopesByObserver(before));
    } finally {
      await close(reloaded);
    }
  }

  // A receipt stored before this feature reads as not recorded, never as unscoped.
  const store = JSON.parse(fs.readFileSync(process.env.RESULTS_FILE, 'utf8'));
  for (const record of store.sessions) for (const receipt of record.receipts) delete receipt.meshcoreScopes;
  fs.writeFileSync(process.env.RESULTS_FILE, JSON.stringify(store));
  const legacy = await importServer('');
  const legacyUrl = await listen(legacy);
  try {
    const old = await (await fetch(`${legacyUrl}/api/sessions/${created.id}`)).json();
    for (const receipt of old.receipts) {
      assert.deepEqual(receipt.meshcoreScopes, [{ state: 'not-present', names: [] }]);
    }
  } finally {
    await close(legacy);
  }
  fs.writeFileSync(scopesFile, JSON.stringify({ regions: SCOPE_NAMES }));
});

test('bootstrap reports whether name matching is on and how many names it knows', async () => {
  const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap`)).json();
  assert.deepEqual(bootstrap.meshcoreScopes, { enabled: true, count: SCOPE_NAMES.length });
  const off = await importServer('');
  const url = await listen(off);
  try {
    assert.deepEqual((await (await fetch(`${url}/api/bootstrap`)).json()).meshcoreScopes, { enabled: false, count: 0 });
  } finally {
    await close(off);
  }
  await assert.rejects(importServer(path.join(tempDir, 'missing.json')), /MESHCORE_REGION_SCOPES_FILE/);
  process.env.MESHCORE_REGION_SCOPES_FILE = '';
});
