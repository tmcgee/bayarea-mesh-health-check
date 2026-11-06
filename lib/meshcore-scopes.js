// MeshCore routing-scope recognition, ported from upstream yellowcooln/meshcore-health-check
// (7b0fb8b9, 61445069, 70350c0d, ca02b86d; v1.4.0). Bay Area changes: the operator file
// is a matkam/meshcore-settings `data/regions.json` tree (format 2), shipped byte for byte
// as regions/us-ca-meshcore-scopes.json, not upstream's YAML list (1.1.0; it was a
// flattened copy of the codes before, which lost each place's name and county outline).
// JSON, not YAML, on purpose: matkam generates regions.json from its hand-edited
// regions.yaml as the file outside consumers should read, and upstream's YAML is a
// flat name list with no outlines. See docs/bay-area-adaptation.md section 6aj.
// Validation, matching and the recorded states are upstream's.
//
// A scoped ("transport") packet carries a 16-bit code in its header: the first two bytes of
// HMAC-SHA256(key, payloadType || payload), read little-endian, where the key is derived
// from the SHA-256 of "#name" (decoder.calcRegionKey). The code depends on the payload, so it is not a stable ID and a name
// can only be recognised by trying each configured public name against each packet.
// Private ($) scopes have secret keys and can never be recognised here.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const decoder = require('@michaelhart/meshcore-decoder');

const MAX_FILE_BYTES = 65536;
const KNOWN_FORMAT = 2;
const MAX_NAMES = 1024;
const STATES = ['known', 'ambiguous', 'unknown', 'unscoped', 'disabled', 'unavailable', 'not-present'];

// Config-owned cache of region keys: computed once per loaded list, never per packet.
const preparedRegions = new WeakMap();
function regionKeys(config) {
  let entries = preparedRegions.get(config);
  // The loader's list is stable; direct helper callers may replace or mutate theirs.
  if (!entries || entries.length !== config.regions.length
    || entries.some((entry, index) => entry.name !== config.regions[index])) {
    entries = config.regions.map((name) => ({ name, key: decoder.calcRegionKey(name) }));
    preparedRegions.set(config, entries);
  }
  return entries;
}

function validateName(name) {
  // MeshCore RegionMap::is_name_char(uint8_t): '-', '$', '#', digits, or >= 'A'.
  // Public-only subset: one optional leading '#', no '$', '*', whitespace or controls.
  if (typeof name !== 'string' || !/^#?[^#$*\s\p{C}]+$/u.test(name)
    || !Buffer.from(name, 'utf8').every((byte) => byte === 45 || byte === 35
      || (byte >= 48 && byte <= 57) || byte >= 65)) {
    throw new Error('names must be public firmware-compatible strings (optional leading #); no whitespace, $, wildcard, controls or firmware-invalid punctuation');
  }
  // RegionEntry::name stores 30 bytes INCLUDING an explicit '#'; a bare name gains its
  // implicit '#' only when the key is derived, after storage. Never truncated.
  if (Buffer.byteLength(name, 'utf8') > 30) {
    throw new Error('names must fit firmware storage: at most 30 UTF-8 bytes as written (including an explicit #); names are never truncated');
  }
  return decoder.normalizeRegionName(name);
}

// The scope names a regions.json tree defines, in tree order: root chain, places
// depth-first, then tags. Shared with scripts/check-scopes.js, so the drift check and
// the server read the file the same way. `depth` counts from the first place level (1);
// the root chain and tags are 0.
export function flattenTree(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.root) || !Array.isArray(doc.places)) {
    throw new Error('not a regions tree: expected `root` and `places` arrays');
  }
  const entries = [];
  const add = (place, parent, type, depth) => {
    if (!place || typeof place.code !== 'string' || !place.code) {
      throw new Error(`${type} without a code under ${parent || 'the root'}`);
    }
    entries.push({
      code: place.code,
      name: typeof place.name === 'string' ? place.name : '',
      parent,
      type,
      depth,
      kind: typeof place.kind === 'string' ? place.kind : '',
      outline: Array.isArray(place.outline) ? [...place.outline].map(String).sort() : [],
    });
  };
  let parent = '';
  for (const root of doc.root) {
    add(root, parent, 'root', 0);
    parent = root.code;
  }
  const walk = (places, under, depth) => {
    for (const place of places) {
      add(place, under, 'place', depth);
      if (Array.isArray(place.children)) walk(place.children, place.code, depth + 1);
    }
  };
  walk(doc.places, '', 1);
  for (const tag of Array.isArray(doc.tags) ? doc.tags : []) add(tag, '', 'tag', 0);
  return entries;
}

// The scope for one of the app's subregions, from the tree's own county outlines:
// the deepest place whose `outline` lists the subregion, else a place whose display
// name is the subregion (Yuba-Sutter is one upstream place with that name). The
// outline is tried first because a name can belong to a smaller place: the place
// named "San Luis Obispo" is the city, `slocity`; the county is `slo`. Returns the
// stored name (with '#') or null. No table is kept: re-copying the tree updates it.
export function scopeForSubregion(config, subregion) {
  const places = Array.isArray(config?.places) ? config.places : [];
  if (!subregion || !places.length) return null;
  const deepest = (matches) => matches.reduce((best, entry) => (!best || entry.depth > best.depth ? entry : best), null);
  const hit = deepest(places.filter((entry) => entry.outline.includes(subregion)))
    || deepest(places.filter((entry) => entry.name === subregion));
  return hit ? hit.scope : null;
}

// Blank path: disabled. A configured path that is missing, unreadable or invalid throws,
// so a bad edit fails startup loudly instead of silently turning recognition off.
// test/meshcore-scopes.test.js loads the shipped file, so CI catches a bad edit first.
export function loadMeshcoreScopes(filePath) {
  if (!filePath) return { enabled: false, regions: [], places: [] };
  try {
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let text;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new Error(`must be a regular file of at most ${MAX_FILE_BYTES} bytes`);
      }
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally {
      fs.closeSync(fd);
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('invalid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== KNOWN_FORMAT) {
      throw new Error(`expected a meshcore-settings regions.json tree, format ${KNOWN_FORMAT}`);
    }
    const entries = flattenTree(value);
    if (entries.length > MAX_NAMES) throw new Error(`at most ${MAX_NAMES} names`);
    const regions = entries.map((entry) => validateName(entry.code));
    if (new Set(regions).size !== regions.length) throw new Error('duplicate normalized public names');
    // Places keep what scopeForSubregion needs; `places` sits beside `regions` so the
    // matcher, which reads only `regions`, is untouched.
    const places = entries
      .map((entry, index) => ({ scope: regions[index], name: entry.name, depth: entry.depth, outline: entry.outline, type: entry.type }))
      .filter((entry) => entry.type === 'place')
      .map(({ type, ...entry }) => entry);
    const config = { enabled: true, regions, places };
    // The parsed tree itself, for lib/region-places.js (1.2.0). Not enumerable, so
    // anything that serialises or compares the config sees what it always did.
    Object.defineProperty(config, 'tree', { value, enumerable: false });
    regionKeys(config);
    return config;
  } catch (error) {
    throw new Error(`MESHCORE_REGION_SCOPES_FILE: ${error.message}`);
  }
}

// Call only for a matched GroupText receipt, with the original wire payload from
// parsePacketHex. Firmware RegionMap::findMatch tests code[0]; code[1] is the sender's
// return region, not a second scope.
export function recognizeMeshcoreScope(config, packet) {
  if (!packet || packet.payloadType !== 5) return { state: 'unavailable', names: [] };
  return recognizeMeshcoreScopeAnyType(config, packet);
}

// bayarea.18: the same match for any payload type (adverts and forwarded traffic, see
// lib/scope-evidence.js). The code covers payloadType || payload whatever the type.
export function recognizeMeshcoreScopeAnyType(config, packet) {
  const result = (state, names = []) => ({ state, names });
  if (!packet || !Number.isInteger(packet.payloadType) || !packet.payloadBytes?.length) return result('unavailable');
  if (packet.routeType === 1 || packet.routeType === 2) return result('unscoped');
  if (!Array.isArray(packet.transportCodes) || packet.transportCodes.length !== 2) return result('unavailable');
  if (packet.transportCodes[0] === 0) return result('unscoped');
  if (!config.enabled) return result('disabled');
  // The decoder handles the HMAC, little-endian truncation and the reserved 0/0xffff shift.
  const names = regionKeys(config).filter(({ key }) => decoder.calcTransportCode(
    key, packet.payloadType, packet.payloadBytes,
  ) === (packet.transportCodes[0] & 0xffff)).map(({ name }) => name);
  if (names.length > 1) return result('ambiguous', names);
  return names.length === 1 ? result('known', names) : result('unknown');
}

// Stored observations are never recalculated against today's file. A receipt saved
// before this feature existed reads as not-present, never as unscoped.
export function recordedMeshcoreScopes(value) {
  if (!Array.isArray(value) || !value.length) return [{ state: 'not-present', names: [] }];
  return value.filter((scope) => scope && STATES.includes(scope.state)
    && Array.isArray(scope.names) && scope.names.every((name) => typeof name === 'string'))
    .map((scope) => ({ state: scope.state, names: [...scope.names] }));
}
