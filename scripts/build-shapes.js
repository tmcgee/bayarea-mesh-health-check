#!/usr/bin/env node
// Builds the shape library in regions/shapes/ (1.2.0, docs/design-scalable-regions.md
// §5.1): one GeoJSON file per state, keyed by stable IDs (`us-<state FIPS><county FIPS>`,
// Sonoma `us-06097`), plus manifest.json with the source URL, vintage and SHA-256s.
//
// Run on purpose only, by a person, when a state is added or the Census vintage moves:
//
//   node scripts/build-shapes.js            # the states already in the manifest
//   node scripts/build-shapes.js 06 32      # these state FIPS codes (CA, NV)
//   node scripts/build-shapes.js --zip /path/to/cb_2024_us_county_500k.zip 06
//
// The app never downloads anything; it reads the files this writes. Source: US Census
// cartographic boundary file, counties 1:500,000 (public domain). No dependencies: the
// zip, shapefile and dBase readers below cover exactly what that file uses.
//
// Geometry is not simplified further. The 1:500k file is already generalised, and
// simplifying each county on its own would move the vertices neighbours share, which the
// map's outline dissolve (server.js dissolveRings) needs to match exactly. Coordinates
// are rounded to 6 decimals (~0.1 m), as the previous boundary file was; identical input
// vertices round identically, so shared borders stay shared.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'regions', 'shapes');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const VINTAGE = '2024';
const SOURCE_URL = `https://www2.census.gov/geo/tiger/GENZ${VINTAGE}/shp/cb_${VINTAGE}_us_county_500k.zip`;
const DECIMALS = 6;

// ---------- zip (stored or deflated entries, no zip64) ----------
export function readZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    entries.set(name, () => {
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip method ${method} not supported (${name})`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------- dBase III attribute table ----------
export function readDbf(buffer) {
  const records = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const fields = [];
  for (let offset = 32; buffer[offset] !== 0x0d; offset += 32) {
    fields.push({
      name: buffer.toString('latin1', offset, offset + 11).replace(/\0.*$/, ''),
      length: buffer[offset + 16],
    });
  }
  const rows = [];
  for (let r = 0; r < records; r += 1) {
    let offset = headerLength + r * recordLength + 1; // skip the deletion flag
    const row = {};
    for (const field of fields) {
      row[field.name] = buffer.toString('utf8', offset, offset + field.length).trim();
      offset += field.length;
    }
    rows.push(row);
  }
  return rows;
}

// ---------- shapefile polygons (type 5) ----------
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function ringContainsPoint(ring, [px, py]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function readShpPolygons(buffer) {
  const shapes = [];
  let offset = 100;
  while (offset < buffer.length) {
    const contentLength = buffer.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const type = buffer.readInt32LE(start);
    if (type === 0) {
      shapes.push(null);
    } else {
      if (type !== 5) throw new Error(`shape type ${type} not supported`);
      const numParts = buffer.readInt32LE(start + 36);
      const numPoints = buffer.readInt32LE(start + 40);
      const parts = [];
      for (let p = 0; p < numParts; p += 1) parts.push(buffer.readInt32LE(start + 44 + p * 4));
      const pointsAt = start + 44 + numParts * 4;
      const rings = parts.map((first, p) => {
        const last = p + 1 < numParts ? parts[p + 1] : numPoints;
        const ring = [];
        for (let i = first; i < last; i += 1) {
          ring.push([buffer.readDoubleLE(pointsAt + i * 16), buffer.readDoubleLE(pointsAt + i * 16 + 8)]);
        }
        return ring;
      });
      shapes.push(rings);
    }
    offset = start + contentLength;
  }
  return shapes;
}

const round = (value) => Number(value.toFixed(DECIMALS));

function cleanRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const point = [round(x), round(y)];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) out.push(point);
  }
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push([...out[0]]);
  }
  return out.length >= 4 ? out : null;
}

// Shapefile outer rings are clockwise and holes counter-clockwise. GeoJSON (RFC 7946)
// wants the reverse, so every ring is reversed: neighbours still walk a shared border in
// opposite directions, which is all the dissolve needs.
export function ringsToGeometry(rings) {
  const cleaned = rings.map(cleanRing).filter(Boolean).map((ring) => ring.reverse());
  const outers = cleaned.filter((ring) => signedArea(ring) > 0).map((ring) => [ring]);
  const holes = cleaned.filter((ring) => signedArea(ring) < 0);
  for (const hole of holes) {
    const owner = outers.find((polygon) => ringContainsPoint(polygon[0], hole[0]));
    if (owner) owner.push(hole);
  }
  if (outers.length === 1) return { type: 'Polygon', coordinates: outers[0] };
  return { type: 'MultiPolygon', coordinates: outers };
}

const STATE_IDS = { '06': 'us-ca', '32': 'us-nv', '41': 'us-or', '04': 'us-az', '53': 'us-wa' };

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function main(argv) {
  const args = [...argv];
  let zipPath = '';
  const zipAt = args.indexOf('--zip');
  if (zipAt !== -1) {
    zipPath = args[zipAt + 1];
    args.splice(zipAt, 2);
  }
  const previous = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  const states = args.length
    ? args
    : Object.values(previous?.files || {}).map((file) => file.stateFips);
  if (!states.length || states.some((fips) => !/^\d{2}$/.test(fips))) {
    throw new Error('give two-digit state FIPS codes, for example: node scripts/build-shapes.js 06');
  }

  let zip;
  if (zipPath) {
    zip = fs.readFileSync(zipPath);
  } else {
    const response = await fetch(SOURCE_URL);
    if (!response.ok) throw new Error(`${SOURCE_URL}: HTTP ${response.status}`);
    zip = Buffer.from(await response.arrayBuffer());
  }
  const entries = readZipEntries(zip);
  const base = `cb_${VINTAGE}_us_county_500k`;
  const shapes = readShpPolygons(entries.get(`${base}.shp`)());
  const rows = readDbf(entries.get(`${base}.dbf`)());
  if (shapes.length !== rows.length) throw new Error('shp and dbf disagree on record count');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = {};
  for (const stateFips of [...new Set(states)].sort()) {
    const features = rows
      .map((row, index) => ({ row, rings: shapes[index] }))
      .filter(({ row, rings }) => row.STATEFP === stateFips && rings)
      .map(({ row, rings }) => ({
        type: 'Feature',
        id: `us-${row.GEOID}`,
        properties: {
          id: `us-${row.GEOID}`,
          name: row.NAME,
          kind: 'county',
          state: STATE_IDS[stateFips] || `us-${row.STUSPS.toLowerCase()}`,
        },
        geometry: ringsToGeometry(rings),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!features.length) throw new Error(`no counties for state ${stateFips}`);
    const stateId = features[0].properties.state;
    const stateName = rows.find((row) => row.STATEFP === stateFips).STATE_NAME;
    const fileName = `us-${stateFips}.geojson`;
    // One feature per line: a rebuild that changes one county changes one line.
    const text = `{"type":"FeatureCollection","features":[\n${features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), text);
    files[fileName] = {
      state: stateId,
      stateName,
      stateFips,
      features: features.length,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
    };
    console.log(`${fileName}: ${stateName}, ${features.length} counties, ${Buffer.byteLength(text)} bytes`);
  }

  const manifest = {
    format: 1,
    notice: 'Generated by scripts/build-shapes.js - do not edit by hand.',
    source: {
      name: `US Census Bureau cartographic boundary file, counties 1:500,000, ${VINTAGE}`,
      url: SOURCE_URL,
      vintage: VINTAGE,
      sha256: sha256(zip),
      license: 'Public domain (US Government work)',
    },
    decimals: DECIMALS,
    files,
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), MANIFEST)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`build-shapes: ${error.message}`);
    process.exit(1);
  });
}
