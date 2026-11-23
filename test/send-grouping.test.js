// One transmission is one use, however many copies arrive.
//
// Since #healthcheck was bridged to Sacramento (2026-11-23), every test message
// reaches the broker twice: the original, and a bridged copy whose sender reads
// "↔ <name>". The copy keeps the sender's timestamp and text, but its packet hash
// differs. Before send grouping, the copy counted as a second use and a late
// original as a third, so a brand-new code showed "used up" mid-check
// (MHC-2FA19A). These tests pin the send-grouping rules.
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

const OBSERVERS = [
  'AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B',
  '01F0E86393494B0BE83E3D93BD528456DE39F389B9DCF802BC90B21F66EA88A6',
  'C689DF3FEB9A7A5EF05E9642C75ABB8C10DF13D974F196027AA7945BEA996FA4',
  '34945E9CDD2680CD8F2B760211271A9C2E99289A70872B5B224DC616BE357048',
];

// Results written before this change (1.2.1): one linked hash list, no sends.
const LEGACY_ID = '00000000-0000-4000-8000-00000000a001';
const LEGACY_CODE = 'MHC-LEGA01';
const LEGACY_HASH = 'AAAA000000000001';
// Results written by this change: two sends, the second one current.
const STORED_ID = '00000000-0000-4000-8000-00000000a002';
const STORED_CODE = 'MHC-STOR02';
const STORED_FIRST_HASH = 'BBBB000000000001';
const STORED_SECOND_HASH = 'BBBB000000000002';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-send-grouping-'));
const observerFile = path.join(tempDir, 'observer.json');
const observerActivityFile = path.join(tempDir, 'observer-activity.json');
const resultsFile = path.join(tempDir, 'session-results.json');
const bootNow = Date.now();
fs.writeFileSync(observerFile, '{}\n', 'utf8');
fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
fs.writeFileSync(resultsFile, JSON.stringify({
  version: 1,
  sessions: [
    {
      id: LEGACY_ID,
      code: LEGACY_CODE,
      createdAt: bootNow - 30_000,
      expiresAt: bootNow + 570_000,
      status: 'active',
      useCount: 1,
      maxUses: 3,
      messageHash: LEGACY_HASH,
      messageHashes: [LEGACY_HASH],
      matchedAt: bootNow - 20_000,
      messageBody: LEGACY_CODE,
      sender: 'Legacy Sender',
      channelHash: '',
      channelName: 'health-check',
      receipts: [],
    },
    {
      id: STORED_ID,
      code: STORED_CODE,
      createdAt: bootNow - 30_000,
      expiresAt: bootNow + 570_000,
      status: 'active',
      useCount: 2,
      maxUses: 3,
      messageHash: STORED_SECOND_HASH,
      messageHashes: [STORED_FIRST_HASH, STORED_SECOND_HASH],
      sends: [
        { hashes: [STORED_FIRST_HASH], sendTimestamp: 1795000001, sendSender: 'stored sender', displaySender: 'Stored Sender', startedAt: bootNow - 25_000 },
        { hashes: [STORED_SECOND_HASH], sendTimestamp: 1795000002, sendSender: 'stored sender', displaySender: 'Stored Sender', startedAt: bootNow - 20_000 },
      ],
      matchedAt: bootNow - 20_000,
      messageBody: STORED_CODE,
      sender: 'Stored Sender',
      channelHash: '',
      channelName: 'health-check',
      receipts: [],
    },
  ],
}, null, 2), 'utf8');

process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
process.env.TURNSTILE_ENABLED = 'false';
process.env.LOG_LEVEL = 'info';
process.env.OBSERVERS_FILE = observerFile;
process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
process.env.RESULTS_FILE = resultsFile;
process.env.TEST_CHANNEL_NAME = 'health-check';
process.env.TEST_CHANNEL_SECRET = SECRET;
process.env.OBSERVER_RETENTION_SECONDS = '14400';

// Date.now() drives packet arrival times; tests move it forward to step past the
// sender-and-text window.
const realDateNow = Date.now;
let clockOffsetMs = 0;
Date.now = () => realDateNow() + clockOffsetMs;

const serverModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?send-grouping=${realDateNow()}`
);
const { flushScheduledWrites, ingestMqttMessage, server, resetTestState } = serverModule;

let baseUrl = '';
let restoredStateChecked = false;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  clockOffsetMs = 0;
  // The two restore tests need the sessions loaded at boot; they run first.
  if (restoredStateChecked) {
    resetTestState();
  }
});

after(async () => {
  Date.now = realDateNow;
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

async function getSession(id) {
  const response = await fetch(`${baseUrl}/api/sessions/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

function hear(observerKey, { sender, message, hash, timestamp }) {
  const envelope = buildGroupTextEnvelope({
    secretHex: SECRET,
    sender,
    message,
    messageHash: hash,
    timestamp,
  });
  ingestMqttMessage(`meshcore/SFO/${observerKey}/packets`, Buffer.from(JSON.stringify(envelope)));
}

function receiptKeys(session) {
  return session.receipts.map((receipt) => receipt.observerKey).sort();
}

test('restored 1.2.1 results: a late copy of the linked send still adds a receipt', async () => {
  hear(OBSERVERS[0], { sender: 'Legacy Sender', message: LEGACY_CODE, hash: LEGACY_HASH, timestamp: 1795000000 });
  const session = await getSession(LEGACY_ID);
  assert.equal(session.useCount, 1);
  assert.deepEqual(receiptKeys(session), [OBSERVERS[0]]);
});

test('restored sends: copies of an earlier send are ignored, the current send counts', async () => {
  hear(OBSERVERS[0], { sender: 'Stored Sender', message: STORED_CODE, hash: STORED_FIRST_HASH, timestamp: 1795000001 });
  let session = await getSession(STORED_ID);
  assert.equal(session.useCount, 2);
  assert.equal(session.receipts.length, 0);

  hear(OBSERVERS[1], { sender: 'Stored Sender', message: STORED_CODE, hash: STORED_SECOND_HASH, timestamp: 1795000002 });
  session = await getSession(STORED_ID);
  assert.equal(session.useCount, 2);
  assert.equal(session.messageHash, STORED_SECOND_HASH);
  assert.deepEqual(receiptKeys(session), [OBSERVERS[1]]);
  restoredStateChecked = true;
});

test('MHC-2FA19A replay: original, bridged copy, late original is one use', async () => {
  const created = await createSession();
  const message = created.code;
  const timestamp = 1795413151;
  hear(OBSERVERS[0], { sender: 'KO6JOT-home 🏡', message, hash: '6B88DC8EAF9B1A53', timestamp });
  clockOffsetMs = 4_000;
  hear(OBSERVERS[1], { sender: '↔ KO6JOT-home 🏡', message, hash: '7670604F556B9DC8', timestamp });
  clockOffsetMs = 9_000;
  hear(OBSERVERS[2], { sender: 'KO6JOT-home 🏡', message, hash: '6B88DC8EAF9B1A53', timestamp });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  assert.equal(session.status, 'active');
  assert.equal(session.messageHash, '6B88DC8EAF9B1A53');
  assert.equal(session.sender, 'KO6JOT-home 🏡');
  assert.deepEqual(receiptKeys(session), [OBSERVERS[0], OBSERVERS[1], OBSERVERS[2]].sort());
});

test('bridged copy heard first: one use, sender shown without the marker', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: '↔ armooo', message, hash: 'C0C0000000000001', timestamp: 1795400000 });
  hear(OBSERVERS[1], { sender: 'armooo', message, hash: 'C0C0000000000002', timestamp: 1795400000 });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  assert.equal(session.sender, 'armooo');
  assert.equal(session.receipts.length, 2);
});

test('a copy with the same timestamp still groups after the sender-and-text window', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'platinum', message, hash: 'D0D0000000000001', timestamp: 1795401000 });
  clockOffsetMs = 210_000;
  hear(OBSERVERS[1], { sender: '↔ platinum', message, hash: 'D0D0000000000002', timestamp: 1795401000 });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  assert.equal(session.receipts.length, 2);
});

test('a re-stamped copy groups inside the window and is a new use outside it', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'BuddhasBrother', message, hash: 'E0E0000000000001', timestamp: 1795402000 });
  clockOffsetMs = 30_000;
  hear(OBSERVERS[1], { sender: '↔ BuddhasBrother', message, hash: 'E0E0000000000002', timestamp: 1795402031 });
  let session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  assert.equal(session.receipts.length, 2);

  clockOffsetMs = 200_000;
  hear(OBSERVERS[2], { sender: 'BuddhasBrother', message, hash: 'E0E0000000000003', timestamp: 1795402200 });
  session = await getSession(created.id);
  assert.equal(session.useCount, 2);
  assert.deepEqual(receiptKeys(session), [OBSERVERS[2]]);
});

test('repeated bridge markers are stripped before senders are compared', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'tribbie · ∞', message, hash: 'F0F0000000000001', timestamp: 1795403000 });
  hear(OBSERVERS[1], { sender: '↔ ↔ tribbie · ∞', message, hash: 'F0F0000000000002', timestamp: 1795403000 });
  hear(OBSERVERS[2], { sender: '↔↔tribbie · ∞', message, hash: 'F0F0000000000003', timestamp: 1795403000 });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  assert.equal(session.receipts.length, 3);
});

test('a different sender with the same text and timestamp is a new use', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'Alpha', message, hash: 'A1A1000000000001', timestamp: 1795404000 });
  hear(OBSERVERS[1], { sender: 'Bravo', message, hash: 'A1A1000000000002', timestamp: 1795404000 });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 2);
});

test('after a real resend, late copies of the first send are ignored', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'KO6JOT-home 🏡', message, hash: 'B1B1000000000001', timestamp: 1795405000 });
  hear(OBSERVERS[1], { sender: '↔ KO6JOT-home 🏡', message, hash: 'B1B1000000000002', timestamp: 1795405000 });
  clockOffsetMs = 210_000;
  hear(OBSERVERS[2], { sender: 'KO6JOT-home 🏡', message, hash: 'B1B1000000000003', timestamp: 1795405210 });
  // Late copies of send 1, original and bridged.
  hear(OBSERVERS[3], { sender: 'KO6JOT-home 🏡', message, hash: 'B1B1000000000001', timestamp: 1795405000 });
  hear(OBSERVERS[0], { sender: '↔ KO6JOT-home 🏡', message, hash: 'B1B1000000000002', timestamp: 1795405000 });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 2);
  assert.equal(session.status, 'active');
  assert.equal(session.messageHash, 'B1B1000000000003');
  assert.deepEqual(receiptKeys(session), [OBSERVERS[2]]);
});

test('without a matching timestamp, sender and text group for 180 s, not longer', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'Windowed', message, hash: 'F1F1000000000001', timestamp: 1795408000 });
  clockOffsetMs = 170_000;
  hear(OBSERVERS[1], { sender: '↔ Windowed', message, hash: 'F1F1000000000002', timestamp: 1795408170 });
  let session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  assert.deepEqual(receiptKeys(session), [OBSERVERS[0], OBSERVERS[1]].sort());

  clockOffsetMs = 190_000;
  hear(OBSERVERS[2], { sender: 'Windowed', message, hash: 'F1F1000000000003', timestamp: 1795408190 });
  session = await getSession(created.id);
  assert.equal(session.useCount, 2);
  assert.deepEqual(receiptKeys(session), [OBSERVERS[2]]);
});

test('three real sends exhaust the code; a copy of the third still adds receipts', async () => {
  const created = await createSession();
  const message = created.code;
  for (let send = 0; send < 3; send += 1) {
    clockOffsetMs = send * 210_000;
    hear(OBSERVERS[0], { sender: 'Resender', message, hash: `C1C100000000000${send}`, timestamp: 1795406000 + send * 210 });
  }
  let session = await getSession(created.id);
  assert.equal(session.useCount, 3);
  assert.equal(session.status, 'exhausted');

  // The bridged copy of the third send arrives after the code is used up.
  hear(OBSERVERS[1], { sender: '↔ Resender', message, hash: 'C1C1000000000009', timestamp: 1795406420 });
  // A fourth real send is refused.
  clockOffsetMs = 630_000;
  hear(OBSERVERS[2], { sender: 'Resender', message, hash: 'C1C100000000000A', timestamp: 1795406630 });

  session = await getSession(created.id);
  assert.equal(session.useCount, 3);
  assert.equal(session.messageHash, 'C1C1000000000002');
  assert.deepEqual(receiptKeys(session), [OBSERVERS[0], OBSERVERS[1]].sort());
});

test('sends are written to the results file with every linked hash', async () => {
  const created = await createSession();
  const message = created.code;
  hear(OBSERVERS[0], { sender: 'Writer', message, hash: 'D1D1000000000001', timestamp: 1795407000 });
  hear(OBSERVERS[1], { sender: '↔ Writer', message, hash: 'D1D1000000000002', timestamp: 1795407000 });
  clockOffsetMs = 210_000;
  hear(OBSERVERS[2], { sender: 'Writer', message, hash: 'D1D1000000000003', timestamp: 1795407210 });
  flushScheduledWrites();

  const stored = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const record = stored.sessions.find((entry) => entry.id === created.id);
  assert.ok(record);
  assert.deepEqual(record.messageHashes, ['D1D1000000000001', 'D1D1000000000002', 'D1D1000000000003']);
  assert.equal(record.sends.length, 2);
  assert.deepEqual(record.sends[0].hashes, ['D1D1000000000001', 'D1D1000000000002']);
  assert.equal(record.sends[0].sendTimestamp, 1795407000);
  assert.equal(record.sends[0].sendSender, 'writer');
  assert.equal(record.sends[0].displaySender, 'Writer');
  assert.deepEqual(record.sends[1].hashes, ['D1D1000000000003']);
});

// --- Bridged receipts and duplicate deliveries (brief sections D and E). ---
// No BRIDGE_NODE_PREFIXES in this file, so the bridge leg is never known here.

function hearEnvelope(observerKey, fields) {
  const envelope = buildGroupTextEnvelope({ secretHex: SECRET, ...fields });
  ingestMqttMessage(`meshcore/SFO/${observerKey}/packets`, Buffer.from(JSON.stringify(envelope)));
}

test('a bridged copy is labelled, and with no known bridge node its distance is withheld', async () => {
  const created = await createSession();
  const message = created.code;
  hearEnvelope(OBSERVERS[0], { sender: 'Lab', message, messageHash: 'E1E1000000000001', timestamp: 1795408000, path: ['2F03', 'E945'] });
  hearEnvelope(OBSERVERS[1], { sender: '↔ Lab', message, messageHash: 'E1E1000000000002', timestamp: 1795408000, path: ['2F03', 'E945', '6236', 'BD6E'] });

  const session = await getSession(created.id);
  const original = session.receipts.find((receipt) => receipt.observerKey === OBSERVERS[0]);
  const bridged = session.receipts.find((receipt) => receipt.observerKey === OBSERVERS[1]);
  assert.equal(original.viaBridge, false);
  assert.equal(bridged.viaBridge, true);
  assert.equal(bridged.bridgeHopIndex, null);
  assert.equal(bridged.pathDistance, null);
  assert.equal(bridged.pathBridgeLeg, null);
  assert.match(bridged.pathDistanceNote, /bridge leg is not known/);
  // Bridged receipts are scored like any other.
  assert.equal(session.observedCount, 2);
});

test('an identical repeat delivery changes nothing', async () => {
  // Same packet bytes; only the envelope's telemetry differs on the third, as two
  // brokers or uplinks can report the same reception slightly differently.
  const created = await createSession();
  const fields = { sender: 'Dup', message: created.code, messageHash: 'E2E2000000000001', timestamp: 1795409000, path: ['11', '22'], rssi: -90, snr: 3 };
  hearEnvelope(OBSERVERS[0], fields);
  hearEnvelope(OBSERVERS[0], fields);
  hearEnvelope(OBSERVERS[0], { ...fields, rssi: -40, snr: 9 });

  const session = await getSession(created.id);
  assert.equal(session.receipts.length, 1);
  assert.equal(session.receipts[0].count, 1);
  assert.equal(session.receipts[0].rssi, -90);
  assert.equal(session.receipts[0].snr, 3);
});

test('the same packet over another route adds to the count and keeps the first path and reading', async () => {
  const created = await createSession();
  const base = { sender: 'Route', message: created.code, messageHash: 'E3E3000000000001', timestamp: 1795410000 };
  hearEnvelope(OBSERVERS[0], { ...base, path: ['11', '22'], rssi: -90, snr: 3 });
  hearEnvelope(OBSERVERS[0], { ...base, path: ['33', '44', '55'], rssi: -40, snr: 9 });

  const session = await getSession(created.id);
  const receipt = session.receipts[0];
  assert.equal(receipt.count, 2);
  assert.deepEqual(receipt.path.slice(0, 2), ['11', '22']);
  assert.equal(receipt.rssi, -90);
  assert.equal(receipt.snr, 3);
});

test('an observer that hears both copies keeps the original reading, whichever came first', async () => {
  const created = await createSession();
  const message = created.code;
  const timestamp = 1795411000;
  // Bridged copy first, then the original.
  hearEnvelope(OBSERVERS[0], { sender: '↔ Both', message, messageHash: 'E4E4000000000002', timestamp, path: ['2F03', '6236', 'BD6E'], rssi: -110, snr: -8 });
  hearEnvelope(OBSERVERS[0], { sender: 'Both', message, messageHash: 'E4E4000000000001', timestamp, path: ['2F03'], rssi: -70, snr: 6 });
  // Original first, then the bridged copy.
  hearEnvelope(OBSERVERS[1], { sender: 'Both', message, messageHash: 'E4E4000000000001', timestamp, path: ['2F03'], rssi: -72, snr: 5 });
  hearEnvelope(OBSERVERS[1], { sender: '↔ Both', message, messageHash: 'E4E4000000000002', timestamp, path: ['2F03', '6236', 'BD6E'], rssi: -111, snr: -9 });

  const session = await getSession(created.id);
  assert.equal(session.useCount, 1);
  for (const [key, rssi] of [[OBSERVERS[0], -70], [OBSERVERS[1], -72]]) {
    const receipt = session.receipts.find((entry) => entry.observerKey === key);
    assert.equal(receipt.viaBridge, false);
    assert.equal(receipt.messageHash, 'E4E4000000000001');
    assert.equal(receipt.path[0], '2F03');
    assert.equal(receipt.path.length, 2);
    assert.equal(receipt.rssi, rssi);
    assert.equal(receipt.count, 2);
  }
});

test('bridge flags and deliveries are written to the results file', async () => {
  const created = await createSession();
  hearEnvelope(OBSERVERS[0], { sender: '↔ Saved', message: created.code, messageHash: 'E5E5000000000001', timestamp: 1795412000, path: ['11'] });
  flushScheduledWrites();
  const stored = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const receipt = stored.sessions.find((entry) => entry.id === created.id).receipts[0];
  assert.equal(receipt.viaBridge, true);
  assert.equal(receipt.bridgeHopIndex, null);
  assert.equal(receipt.deliveries.length, 1);
  assert.match(receipt.deliveries[0], /^E5E5000000000001\|[0-9a-f]{16}$/);
});
