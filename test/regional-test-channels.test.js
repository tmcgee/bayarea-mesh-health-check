// Regional test channels (bayarea.19): #<region>-healthcheck is read alongside the
// primary channel, and a session on one compares the scope it was meant to carry with
// the scopes its copies were heard under.
import './support/isolate-env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGroupTextEnvelope } from './support/build-meshcore-fixture.js';
import { buildRegionalChannels, compareIntendedScope } from '../lib/regional-test-channels.js';
import { loadMeshcoreScopes } from '../lib/meshcore-scopes.js';

const require = createRequire(import.meta.url);
const { calcTransportCodeForRegion } = require('@michaelhart/meshcore-decoder');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const SHIPPED_SCOPES = path.join(REPO_DIR, 'regions/us-ca-meshcore-scopes.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-regional-'));

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.LOG_LEVEL = 'warn';
process.env.OBSERVERS_FILE = path.join(tempDir, 'observer.json');
process.env.OBSERVER_ACTIVITY_FILE = path.join(tempDir, 'observer-activity.json');
process.env.RESULTS_FILE = path.join(tempDir, 'session-results.json');
process.env.TEST_CHANNEL_NAME = 'healthcheck';
process.env.TEST_CHANNEL_SECRET = createHash('sha256').update('#healthcheck').digest('hex').slice(0, 32);
fs.writeFileSync(process.env.OBSERVERS_FILE, '{}\n');
fs.writeFileSync(process.env.OBSERVER_ACTIVITY_FILE, '{"version":1,"observers":{}}\n');
fs.writeFileSync(process.env.RESULTS_FILE, '{"version":1,"sessions":[]}\n');

const hashtagSecret = (name) => createHash('sha256').update(`#${name}`).digest('hex').slice(0, 32);
const KEYS = ['C1'.repeat(32), 'C2'.repeat(32), 'C3'.repeat(32)];

let importCounter = 0;
async function startServer(env) {
  Object.assign(process.env, env);
  importCounter += 1;
  const api = await import(`${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?regional=${Date.now()}-${importCounter}`);
  await new Promise((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  return { api, url: `http://127.0.0.1:${api.server.address().port}` };
}
async function stop({ api }) {
  api.flushScheduledWrites?.();
  await new Promise((resolve) => api.server.close(resolve));
}

// Rewrite a fixture flood packet (header 0x15, empty path) as a transport packet scoped to
// `scopeName`, or leave it unscoped when scopeName is null.
function scopedTo(envelope, scopeName) {
  if (!scopeName) return envelope;
  const bytes = Buffer.from(envelope.raw, 'hex');
  const code = calcTransportCodeForRegion(scopeName, 5, bytes.subarray(2));
  const transport = Buffer.alloc(4);
  transport.writeUInt16LE(code);
  return { ...envelope, raw: Buffer.concat([Buffer.from([(5 << 2) | 0]), transport, bytes.subarray(1)]).toString('hex') };
}

let server;
before(async () => {
  server = await startServer({ MESHCORE_REGION_SCOPES_FILE: SHIPPED_SCOPES, REGIONAL_TEST_CHANNELS: '' });
  for (const key of KEYS) {
    server.api.ingestMqttMessage(`meshcore/SFO/${key}/status`, Buffer.from(JSON.stringify({ name: `Obs ${key.slice(0, 2)}` })));
  }
});
after(async () => {
  await stop(server);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function newSession(url = server.url) {
  return (await fetch(`${url}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedObserverKeys: KEYS }),
  })).json();
}
const getSession = async (id, url = server.url) => (await fetch(`${url}/api/sessions/${id}`)).json();
const ingest = (api, envelope, key) => api.ingestMqttMessage(`meshcore/SFO/${key}/packets`, Buffer.from(JSON.stringify(envelope)));
let hashCounter = 0;
function envelopeOn(channel, code) {
  hashCounter += 1;
  return buildGroupTextEnvelope({
    secretHex: hashtagSecret(channel),
    sender: 'Regional Tester',
    message: `test ${code}`,
    messageHash: `${String(hashCounter).padStart(4, '0')}AABBCCDD1122`,
    timestamp: 1760000000 + hashCounter,
  });
}

test('the channel list covers every shipped scope name, and the snapshot carries it', async () => {
  const config = loadMeshcoreScopes(SHIPPED_SCOPES);
  const regional = buildRegionalChannels(config.regions, 'healthcheck');
  assert.equal(regional.names.length, config.regions.length);
  assert.equal(regional.byName.get('slo-healthcheck').scope, '#slo');
  // Seven pairs share a hash byte with the shipped list; the MAC tells them apart.
  assert.ok([...regional.byHash.values()].some((entries) => entries.length > 1));
  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json();
  assert.equal(bootstrap.testChannel.name, 'healthcheck');
  assert.equal(bootstrap.testChannel.regional.count, config.regions.length);
  assert.ok(bootstrap.testChannel.regional.names.includes('slo-healthcheck'));
});

test('a code on #slo-healthcheck scoped #slo is heard as intended; the primary channel has no check', async () => {
  const session = await newSession();
  const message = scopedTo(envelopeOn('slo-healthcheck', session.code), 'slo');
  ingest(server.api, message, KEYS[0]);
  ingest(server.api, message, KEYS[1]);
  let result = await getSession(session.id);
  assert.equal(result.channelName, 'slo-healthcheck');
  assert.equal(result.intendedScope, '#slo');
  assert.equal(result.observedCount, 2);
  assert.equal(result.scopeCheck.verdict, 'as-intended');
  assert.equal(result.scopeCheck.counts.asIntended + result.scopeCheck.counts.ambiguous, 2);

  const primary = await newSession();
  ingest(server.api, envelopeOn('healthcheck', primary.code), KEYS[0]);
  result = await getSession(primary.id);
  assert.equal(result.channelName, 'healthcheck');
  assert.equal(result.intendedScope, null);
  assert.equal(result.scopeCheck, null);
});

test('unscoped, other-scope and mixed copies are reported against the intended scope', async () => {
  const session = await newSession();
  const unscoped = envelopeOn('sonoma-healthcheck', session.code);
  ingest(server.api, unscoped, KEYS[0]);
  let result = await getSession(session.id);
  assert.equal(result.intendedScope, '#sonoma');
  assert.equal(result.scopeCheck.verdict, 'not-as-intended');
  assert.equal(result.scopeCheck.counts.unscoped, 1);

  // Same message (same hash) heard by a second observer under the intended scope,
  // and by a third under a different one: one session, three receipts.
  ingest(server.api, scopedTo(unscoped, 'sonoma'), KEYS[1]);
  ingest(server.api, scopedTo(unscoped, 'napa'), KEYS[2]);
  result = await getSession(session.id);
  assert.equal(result.observedCount, 3);
  assert.equal(result.scopeCheck.verdict, 'mixed');
  assert.equal(result.scopeCheck.counts.unscoped, 1);
  assert.equal(result.scopeCheck.counts.asIntended + result.scopeCheck.counts.ambiguous, 1);
  assert.equal(result.scopeCheck.counts.other, 1);
  assert.ok(result.scopeCheck.otherNames.includes('#napa'));
});

test('names sharing a hash byte resolve by MAC; unlisted names and other channels are ignored', async () => {
  // siskiyou-healthcheck and sacramento-healthcheck share hash byte; each must land on its own.
  for (const [channel, scope] of [['siskiyou-healthcheck', '#siskiyou'], ['sacramento-healthcheck', '#sacramento']]) {
    const session = await newSession();
    ingest(server.api, envelopeOn(channel, session.code), KEYS[0]);
    const result = await getSession(session.id);
    assert.equal(result.channelName, channel);
    assert.equal(result.intendedScope, scope);
  }
  for (const channel of ['cc-healthcheck', 'healthcheck-slo', 'chat']) {
    const session = await newSession();
    ingest(server.api, envelopeOn(channel, session.code), KEYS[0]);
    assert.equal((await getSession(session.id)).observedCount, 0, channel);
  }
});

test('REGIONAL_TEST_CHANNELS=false, or no scope names, leaves only the primary channel', async () => {
  for (const env of [
    { MESHCORE_REGION_SCOPES_FILE: SHIPPED_SCOPES, REGIONAL_TEST_CHANNELS: 'false' },
    { MESHCORE_REGION_SCOPES_FILE: '', REGIONAL_TEST_CHANNELS: '' },
  ]) {
    const other = await startServer(env);
    try {
      const bootstrap = await (await fetch(`${other.url}/api/bootstrap`)).json();
      assert.equal(bootstrap.testChannel.regional, null);
      const session = await newSession(other.url);
      ingest(other.api, envelopeOn('slo-healthcheck', session.code), KEYS[0]);
      assert.equal((await getSession(session.id, other.url)).observedCount, 0);
    } finally {
      await stop(other);
    }
  }
});

test('compareIntendedScope buckets every copy', () => {
  const r = (...scopes) => ({ meshcoreScopes: scopes });
  assert.equal(compareIntendedScope(null, [r({ state: 'known', names: ['#slo'] })]), null);
  assert.equal(compareIntendedScope('#slo', []).verdict, 'waiting');
  assert.equal(compareIntendedScope('#slo', [{}]).verdict, 'unrecorded');
  const check = compareIntendedScope('#slo', [
    r({ state: 'known', names: ['#slo'] }),
    r({ state: 'ambiguous', names: ['#slo', '#sf'] }),
    r({ state: 'ambiguous', names: ['#sf', '#napa'] }, { state: 'unknown', names: [] }),
    r({ state: 'unscoped', names: [] }),
  ]);
  assert.deepEqual(check.counts, { asIntended: 1, ambiguous: 1, unscoped: 1, other: 2, unrecorded: 0 });
  assert.deepEqual(check.otherNames, ['#napa', '#sf', '(unlisted)']);
  assert.equal(check.verdict, 'mixed');
});
