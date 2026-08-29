// Tally the path_len hash-size selector per originating node on the live GoMesh
// feed. In MeshCore the path_len byte carries the hop count in its low 6 bits and
// a hash-size selector (1..3 bytes per hop) in its top 2 bits, so the size is a
// property of the packet the originator built, not of any node's identity.
import mqtt from 'mqtt';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/home/user/workspace/mhc/.env', 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const url = `wss://${env.MQTT_HOST}:${env.MQTT_PORT}${env.MQTT_WS_PATH}`;
const client = mqtt.connect(url, {
  username: env.MQTT_USERNAME,
  password: env.MQTT_PASSWORD,
  protocolVersion: 4,
  reconnectPeriod: 0,
});

const PAYLOAD_NAMES = {
  0: 'REQ', 1: 'RESPONSE', 2: 'TXT_MSG', 3: 'ACK', 4: 'ADVERT',
  5: 'GRP_TXT', 6: 'GRP_DATA', 7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE', 10: 'MULTIPART',
};

const sizeTotals = new Map();          // hashSize -> packet count
const byPayload = new Map();           // `${payloadType}|${hashSize}` -> count
const advertBySize = new Map();        // hashSize -> Set(originator pubkey prefix)
const perTopic = new Map();            // topic uplink -> Map(hashSize -> count)
const oddities = [];
let total = 0;
let undecodable = 0;

function decode(hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 2) return null;
  let offset = 0;
  const header = bytes[offset];
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  offset += 1;
  // TRANSPORT_FLOOD (0) and TRANSPORT_DIRECT (3) carry a 4-byte transport code.
  if (routeType === 0 || routeType === 3) {
    if (bytes.length < offset + 4) return null;
    offset += 4;
  }
  if (bytes.length < offset + 1) return null;
  const pathLenByte = bytes[offset];
  offset += 1;
  const selector = (pathLenByte >> 6) & 0x03;
  const hashSize = selector + 1;
  const hopCount = pathLenByte & 0x3f;
  if (selector === 3) return null;               // reserved
  const byteLength = hashSize * hopCount;
  if (bytes.length < offset + byteLength) return null;
  const hops = [];
  for (let i = 0; i < hopCount; i += 1) {
    hops.push(bytes.subarray(offset + i * hashSize, offset + (i + 1) * hashSize).toString('hex').toUpperCase());
  }
  offset += byteLength;
  return { routeType, payloadType, hashSize, hopCount, hops, payload: bytes.subarray(offset) };
}

client.on('connect', () => {
  console.log('connected', url);
  client.subscribe(env.MQTT_TOPIC || 'meshcore/#', (err) => {
    if (err) console.error('subscribe failed', err.message);
  });
});

client.on('message', (topic, buf) => {
  const text = buf.toString('utf8').trim();
  let hex = '';
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    hex = text;
  } else if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      hex = o.raw || o.packet || o.hex || '';
    } catch { /* ignore */ }
  }
  if (!hex) return;
  total += 1;
  const d = decode(hex);
  if (!d) { undecodable += 1; return; }

  sizeTotals.set(d.hashSize, (sizeTotals.get(d.hashSize) || 0) + 1);
  const pk = `${d.payloadType}|${d.hashSize}`;
  byPayload.set(pk, (byPayload.get(pk) || 0) + 1);

  const uplink = topic.split('/')[1] || '?';
  if (!perTopic.has(uplink)) perTopic.set(uplink, new Map());
  const m = perTopic.get(uplink);
  m.set(d.hashSize, (m.get(d.hashSize) || 0) + 1);

  // ADVERT payload begins with the originator's 32-byte public key.
  if (d.payloadType === 4 && d.payload.length >= 32) {
    const key = d.payload.subarray(0, 32).toString('hex').toUpperCase();
    if (!advertBySize.has(d.hashSize)) advertBySize.set(d.hashSize, new Set());
    advertBySize.get(d.hashSize).add(key);
  }
  if (d.hashSize !== 1 && oddities.length < 12) {
    oddities.push({ topic, hashSize: d.hashSize, hopCount: d.hopCount, hops: d.hops, payloadType: d.payloadType, hex: hex.slice(0, 60) });
  }
});

client.on('error', (e) => console.error('mqtt error', e.message));

setTimeout(() => {
  console.log(`\npackets with raw hex: ${total}   undecodable: ${undecodable}`);
  console.log('\nhash size (bytes per path hop) across all packets:');
  for (const [size, n] of [...sizeTotals.entries()].sort()) {
    console.log(`  ${size}-byte  ${n}  (${((n / (total - undecodable)) * 100).toFixed(1)}%)`);
  }
  console.log('\nby payload type:');
  for (const [k, n] of [...byPayload.entries()].sort()) {
    const [pt, size] = k.split('|');
    console.log(`  ${(PAYLOAD_NAMES[pt] || pt).padEnd(10)} ${size}-byte  ${n}`);
  }
  console.log('\ndistinct advert originators per hash size:');
  for (const [size, set] of [...advertBySize.entries()].sort()) {
    console.log(`  ${size}-byte  ${set.size} nodes`);
  }
  console.log('\nper uplink code:');
  for (const [uplink, m] of [...perTopic.entries()].sort()) {
    console.log(`  ${uplink.padEnd(6)} ${[...m.entries()].sort().map(([s, n]) => `${s}B:${n}`).join('  ')}`);
  }
  if (oddities.length) {
    console.log('\nnon-1-byte samples:');
    for (const o of oddities) console.log(`  ${JSON.stringify(o)}`);
  }
  client.end(true);
  process.exit(0);
}, 55000);
