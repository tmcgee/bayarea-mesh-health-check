// MeshCore routing-scope recognition, ported from upstream yellowcooln/meshcore-health-check
// (7b0fb8b9, 61445069, 70350c0d, ca02b86d; v1.4.0). Bay Area changes: the operator file
// is JSON, like regions/us-ca-uplink-codes.json, so no YAML parser is added; validation,
// matching and the recorded states are upstream's.
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

// Blank path: disabled. A configured path that is missing, unreadable or invalid throws,
// so a bad edit fails startup loudly instead of silently turning recognition off.
// test/meshcore-scopes.test.js loads the shipped file, so CI catches a bad edit first.
export function loadMeshcoreScopes(filePath) {
  if (!filePath) return { enabled: false, regions: [] };
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
    // `_comment` is allowed so the shipped file can explain itself; nothing else is.
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
    if (!keys || !Array.isArray(value.regions) || value.regions.length > MAX_NAMES
      || keys.some((key) => key !== 'regions' && key !== '_comment')
      || ('_comment' in value && typeof value._comment !== 'string')) {
      throw new Error(`expected {"regions": [public name strings]}, at most ${MAX_NAMES} names`);
    }
    const regions = value.regions.map(validateName);
    if (new Set(regions).size !== regions.length) throw new Error('duplicate normalized public names');
    const config = { enabled: true, regions };
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
  const result = (state, names = []) => ({ state, names });
  if (!packet || packet.payloadType !== 5 || !packet.payloadBytes?.length) return result('unavailable');
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
