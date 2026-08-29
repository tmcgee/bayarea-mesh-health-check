// For every ADVERT seen on the live feed, record the originator's full public key
// and the path hash size the originator chose. An advert is the one packet a node
// definitely built itself, so its path_len selector is direct evidence of that
// node's `path.hash.mode`. Cross-reference against our own observer directory.
import mqtt from 'mqtt';
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('/home/user/workspace/mhc/.env', 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const directory = new Map();
try {
  const raw = JSON.parse(fs.readFileSync('/home/user/workspace/mhc/data/observer.json', 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.observers || Object.entries(raw).map(([k, v]) => ({ key: k, ...v })));
  for (const o of list) {
    const k = String(o.key || o.publicKey || '').toUpperCase().replace(/[^0-9A-F]/g, '');
    if (k) directory.set(k, o.name || o.label || '');
  }
} catch (e) { console.log('observer.json read note:', e.message); }
console.log(`directory keys loaded: ${directory.size}`);

const client = mqtt.connect(`wss://${env.MQTT_HOST}:${env.MQTT_PORT}${env.MQTT_WS_PATH}`, {
  username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD, protocolVersion: 4, reconnectPeriod: 0,
});

// key -> { sizes: Map(size -> count), name, uplinks:Set }
const nodes = new Map();

function decode(hex) {
  const b = Buffer.from(hex, 'hex');
  if (b.length < 2) return null;
  let o = 0;
  const header = b[o]; o += 1;
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  if (routeType === 0 || routeType === 3) { if (b.length < o + 4) return null; o += 4; }
  if (b.length < o + 1) return null;
  const pl = b[o]; o += 1;
  const hashSize = ((pl >> 6) & 0x03) + 1;
  if (hashSize === 4) return null;
  const hops = pl & 0x3f;
  const plen = hashSize * hops;
  if (b.length < o + plen) return null;
  o += plen;
  return { payloadType, hashSize, hops, payload: b.subarray(o) };
}

// ADVERT payload: pubkey[32] | timestamp[4] | signature[64] | flags[1] | (lat[4] lon[4])? | name
function advertName(payload) {
  if (payload.length < 101) return '';
  const flags = payload[100];
  let o = 101;
  if (flags & 0x10) o += 8;              // has location
  const hasName = Boolean(flags & 0x20);
  if (!hasName || o >= payload.length) return '';
  return payload.subarray(o).toString('utf8').replace(/\0+$/, '').trim();
}

client.on('connect', () => {
  console.log('connected; listening for adverts');
  client.subscribe(env.MQTT_TOPIC || 'meshcore/#');
});

client.on('message', (topic, buf) => {
  const t = buf.toString('utf8').trim();
  let hex = '';
  if (/^[0-9a-f]+$/i.test(t) && t.length % 2 === 0) hex = t;
  else if (t.startsWith('{')) { try { const o = JSON.parse(t); hex = o.raw || o.packet || o.hex || ''; } catch {} }
  if (!hex) return;
  const d = decode(hex);
  if (!d || d.payloadType !== 4 || d.payload.length < 32) return;
  const key = d.payload.subarray(0, 32).toString('hex').toUpperCase();
  if (!nodes.has(key)) nodes.set(key, { sizes: new Map(), name: '', uplinks: new Set() });
  const rec = nodes.get(key);
  rec.sizes.set(d.hashSize, (rec.sizes.get(d.hashSize) || 0) + 1);
  rec.uplinks.add(topic.split('/')[1] || '?');
  const nm = advertName(d.payload);
  if (nm && !rec.name) rec.name = nm;
});

client.on('error', (e) => console.error('mqtt error', e.message));

setTimeout(() => {
  const rows = [...nodes.entries()].map(([key, r]) => ({
    key,
    prefix1: key.slice(0, 2),
    prefix2: key.slice(0, 4),
    prefix3: key.slice(0, 6),
    mode: [...r.sizes.entries()].sort((a, b) => b[1] - a[1])[0][0],
    mixed: r.sizes.size > 1,
    counts: [...r.sizes.entries()].sort().map(([s, n]) => `${s}B:${n}`).join(' '),
    name: r.name,
    inDirectory: directory.has(key),
    dirName: directory.get(key) || '',
    uplinks: [...r.uplinks].join(','),
  })).sort((a, b) => b.mode - a.mode || a.name.localeCompare(b.name));

  console.log(`\nadvertising nodes seen: ${rows.length}`);
  const multi = rows.filter((r) => r.mode > 1 || r.mixed);
  console.log(`multi-byte advertisers: ${multi.length}\n`);
  console.log('mode  prefix   name                          inDir  uplinks     counts');
  for (const r of rows) {
    const pfx = r.mode === 3 ? r.prefix3 : r.mode === 2 ? r.prefix2 : r.prefix1;
    console.log(
      `${r.mode}B    ${pfx.padEnd(8)} ${(r.name || r.dirName || '(no name)').slice(0, 28).padEnd(29)} `
      + `${r.inDirectory ? 'yes' : 'no '}    ${r.uplinks.padEnd(11)} ${r.counts}${r.mixed ? '  <-- MIXED' : ''}`,
    );
  }
  client.end(true);
  process.exit(0);
}, 170000);
