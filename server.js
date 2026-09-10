import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import express from 'express';
import qrcode from 'qrcode-generator';
import mqtt from 'mqtt';
import { WebSocketServer } from 'ws';
import {
  calculateChannelHash,
  decodePathLenByte,
  normalizeHex,
  normalizeKey,
  normalizeLogLevel,
  normalizePathHop,
  shortKey,
  shouldDecodeChannel,
} from './lib/mesh-health-core.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = path.join(APP_DIR, 'data');
const require = createRequire(import.meta.url);
const {
  MeshCorePacketDecoder,
  PayloadType: MeshCorePayloadType,
} = require('@michaelhart/meshcore-decoder');
const APP_VERSION = String(require('./package.json').version || '').trim() || '0.0.0';
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

function parseEnvFileLoose(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const out = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

const localEnvPath = path.join(APP_DIR, '.env');
// Tests set MESH_HEALTH_SKIP_ENV_FILE so a developer's real .env cannot leak
// into the app under test. Unset in normal operation.
const skipEnvFile = process.env.MESH_HEALTH_SKIP_ENV_FILE === 'true';
const localEnv = skipEnvFile ? {} : parseEnvFileLoose(localEnvPath);
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

function envValue(name, fallback = '') {
  const localValue = process.env[name];
  if (typeof localValue === 'string' && localValue.trim() !== '') {
    return localValue.trim();
  }
  return fallback;
}

function envNumber(name, fallback) {
  const raw = envValue(name, '');
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const raw = envValue(name, '').toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function normalizeTrustProxy(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase();
  if (['false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  if (['true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function envList(name) {
  const raw = envValue(name, '');
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeDistanceUnit(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['km', 'kilometer', 'kilometers'].includes(normalized) ? 'km' : 'mi';
}

function createLogger(levelName) {
  const LOG_LEVELS = {
    debug: 10,
    info: 20,
  };
  const threshold = LOG_LEVELS[levelName] || LOG_LEVELS.info;
  const write = (level, method, message) => {
    if ((LOG_LEVELS[level] || LOG_LEVELS.info) < threshold) {
      return;
    }
    method(message);
  };
  return {
    level: levelName,
    debug(message) {
      write('debug', console.log, message);
    },
    info(message) {
      write('info', console.log, message);
    },
    warn(message) {
      console.warn(message);
    },
  };
}

function ensureLeadingSlash(value) {
  if (!value) {
    return '/';
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function buildMqttUrl() {
  const directUrl = envValue('MQTT_URL', '');
  if (directUrl) {
    return directUrl;
  }

  const host = envValue('MQTT_HOST', 'localhost');
  const port = envValue('MQTT_PORT', '1883');
  const transport = envValue('MQTT_TRANSPORT', 'tcp').toLowerCase();
  const tls = envBool('MQTT_TLS', false);
  const protocol = transport === 'websockets'
    ? (tls ? 'wss' : 'ws')
    : (tls ? 'mqtts' : 'mqtt');
  const wsPath = transport === 'websockets'
    ? ensureLeadingSlash(envValue('MQTT_WS_PATH', '/'))
    : '';

  return `${protocol}://${host}:${port}${wsPath}`;
}

function brokerLabel(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.host;
  } catch {
    return urlString;
  }
}

function hashFromKeyPrefix(value, byteSize = OBSERVER_HASH_DISPLAY_BYTES) {
  const normalized = normalizeKey(value);
  const width = Number.isInteger(byteSize) && byteSize >= 1 && byteSize <= 3
    ? byteSize
    : OBSERVER_HASH_DISPLAY_BYTES;
  const displayLength = width * 2;
  if (normalized.length < displayLength) {
    return '';
  }
  return normalized.slice(0, displayLength);
}

// A node's path hash width is a per-node firmware setting (`set path.hash.mode`)
// that sizes only the packets that node originates. It is therefore only
// knowable from that node's own adverts - a prefix seen inside somebody else's
// forwarded path says nothing about the node's own config, because a 1.14+
// repeater relays every width regardless of its setting. We only persist a
// width when the profile source confirmed it from an advert; anything else
// falls back to the global display default.
function observerHashBytes(observerKey) {
  const profile = observerProfiles.get(normalizeKey(observerKey));
  const declared = Number(profile?.hashBytes);
  if (Number.isInteger(declared) && declared >= 1 && declared <= 3) {
    return declared;
  }
  return OBSERVER_HASH_DISPLAY_BYTES;
}

function observerHashBytesConfirmed(observerKey) {
  const profile = observerProfiles.get(normalizeKey(observerKey));
  const declared = Number(profile?.hashBytes);
  return Number.isInteger(declared) && declared >= 1 && declared <= 3;
}

function observerPathHop(observerKey, hashSize = 1) {
  const normalized = normalizeKey(observerKey);
  const byteSize = Number(hashSize);
  if (!normalized || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > 3) {
    return '';
  }
  const hopLength = byteSize * 2;
  if (normalized.length < hopLength) {
    return '';
  }
  return normalized.slice(0, hopLength);
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readStructuredFile(filePath) {
  if (!filePath) {
    return null;
  }
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(APP_DIR, filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return null;
  }
}

function resolveAppPath(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(APP_DIR, filePath);
}

function parseObserversJson(filePath) {
  const resolved = resolveAppPath(filePath);
  if (!fs.existsSync(resolved)) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const profiles = new Map();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return profiles;
    }
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      const key = normalizeKey(rawKey);
      if (!key) {
        continue;
      }
      if (typeof rawValue === 'string') {
        const name = String(rawValue || '').trim();
        if (name) {
          profiles.set(key, { name, uplink: '', lat: null, lon: null, hashBytes: null, locationUpdatedAt: null });
        }
        continue;
      }
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        continue;
      }
      const name = String(rawValue.name || rawValue.label || '').trim();
      const uplink = String(rawValue.uplink || rawValue.uplinkCode || '').trim().toUpperCase();
      const lat = normalizeCoordinate(rawValue.lat ?? rawValue.latitude ?? null, 'lat');
      const lon = normalizeCoordinate(
        rawValue.lon ?? rawValue.lng ?? rawValue.longitude ?? null,
        'lon',
      );
      const hasValidLocation = lat != null && lon != null && !(lat === 0 && lon === 0);
      const rawHashBytes = Number(rawValue.hashBytes ?? rawValue.hash_size ?? null);
      const hashBytes = Number.isInteger(rawHashBytes) && rawHashBytes >= 1 && rawHashBytes <= 3
        ? rawHashBytes
        : null;
      // Legacy files predate this field entirely, so a missing/invalid value
      // means "unknown", not "just updated" - never default it to now().
      const rawLocationUpdatedAt = Number(rawValue.locationUpdatedAt ?? null);
      const locationUpdatedAt = hasValidLocation && Number.isFinite(rawLocationUpdatedAt) && rawLocationUpdatedAt > 0
        ? rawLocationUpdatedAt
        : null;
      if (name || uplink || hasValidLocation || hashBytes != null) {
        profiles.set(key, {
          name: name || '',
          uplink: uplink || '',
          lat: hasValidLocation ? lat : null,
          lon: hasValidLocation ? lon : null,
          hashBytes,
          locationUpdatedAt,
        });
      }
    }
    return profiles;
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return new Map();
  }
}

const LOG_LEVEL = normalizeLogLevel(envValue('LOG_LEVEL', 'info'));
const logger = createLogger(LOG_LEVEL);
const DISABLE_RUNTIME = envBool('MESH_HEALTH_DISABLE_RUNTIME', false);
const DISABLE_OBSERVER_FILE_WRITES = DISABLE_RUNTIME || envBool('DISABLE_OBSERVER_FILE_WRITES', false);
const DISABLE_RESULTS_FILE_WRITES = envBool('DISABLE_RESULTS_FILE_WRITES', false);
const PORT = envNumber('PORT', 3090);
const MQTT_URL = buildMqttUrl();
const MQTT_TOPICS = dedupe(envList('MQTT_TOPIC').length > 0
  ? envList('MQTT_TOPIC')
  : ['meshcore/BOS/#']);
const OBSERVERS_FILE = envValue('OBSERVERS_FILE', path.join('data', 'observer.json'));
const OBSERVERS_FILE_PATH = resolveAppPath(OBSERVERS_FILE);
const OBSERVER_ACTIVITY_FILE = envValue('OBSERVER_ACTIVITY_FILE', path.join('data', 'observer-activity.json'));
const OBSERVER_ACTIVITY_FILE_PATH = resolveAppPath(OBSERVER_ACTIVITY_FILE);
const REGIONS_FILE = envValue('REGIONS_FILE', '');
// Self-refresh: the CoreScope seeding pass used to be driven from outside the
// process, which meant stopping the app so the external write was not clobbered
// by writeObserverNamesFile(). Running it here removes both the outage and the
// race - the script writes the file, then this process reloads it into the same
// Map it would otherwise have overwritten.
const OBSERVER_RESEED_ENABLED = envBool('OBSERVER_RESEED_ENABLED', false);
const OBSERVER_RESEED_HOUR = Math.min(23, Math.max(0, Math.round(envNumber('OBSERVER_RESEED_HOUR', 4))));
const OBSERVER_RESEED_SCRIPT = resolveAppPath(envValue('OBSERVER_RESEED_SCRIPT', 'seed-observers.py'));
const OBSERVER_RESEED_PYTHON = envValue('OBSERVER_RESEED_PYTHON', 'python3');
const OBSERVER_RESEED_LOG_PATH = resolveAppPath(envValue('OBSERVER_RESEED_LOG', path.join('data', 'reseed-log.jsonl')));
const OBSERVER_RESEED_TIMEOUT_MS = Math.max(30000, envNumber('OBSERVER_RESEED_TIMEOUT_MS', 240000));
// A boundary edit only reaches observer positions through a seeding pass, so a
// deploy that widens the map used to wait up to a day for the next scheduled
// run. The boot pass closes that gap: it fires once, when the region inputs no
// longer match the ones the last successful pass recorded. Delayed rather than
// immediate so the port bind, the MQTT connect and the first learned profiles
// are not competing with a subprocess that may run for minutes.
const OBSERVER_RESEED_BOOT_DELAY_MS = Math.max(0, envNumber('OBSERVER_RESEED_BOOT_DELAY_MS', 60000));
const ADMIN_TOKEN = envValue('ADMIN_TOKEN', '');
const UPLINK_CODES_FILE = envValue('UPLINK_CODES_FILE', '');
const REGION_FALLBACK = envValue('REGION_FALLBACK', '').trim().toLowerCase();
const REGION_NAME_PROPERTY = envValue('REGION_NAME_PROPERTY', 'name');
const REGION_GROUP_PROPERTY = envValue('REGION_GROUP_PROPERTY', 'group');
const RESULTS_FILE = envValue('RESULTS_FILE', path.join('data', 'session-results.json'));
const RESULTS_FILE_PATH = resolveAppPath(RESULTS_FILE);
const APP_TITLE = envValue('APP_TITLE', 'Mesh Health Check');
const APP_EYEBROW = envValue('APP_EYEBROW', 'MeshCore Observer Coverage');
const APP_HEADLINE = envValue('APP_HEADLINE', 'Check your mesh reach.');
const APP_DESCRIPTION = envValue(
  'APP_DESCRIPTION',
  'Generate a test code, send it to the configured channel, and watch observer coverage build in real time.',
);
const SITE_URL = normalizeSiteUrl(envValue('SITE_URL', ''));
const CORESCOPE_URL = normalizeSiteUrl(envValue('CORESCOPE_URL', ''));
const DISTANCE_UNIT = normalizeDistanceUnit(envValue('DISTANCE_UNIT', 'mi'));
const PWA_APP_NAME = 'Mesh Reach';
const REPO_URL = 'https://github.com/yellowcooln/meshcore-health-check';
// 'expected' plots only the scoring target set (upstream default); 'directory'
// plots every observer that has coordinates, which is what the coverage map is
// usually read as meaning.
const MAP_OBSERVER_SCOPE = envValue('MAP_OBSERVER_SCOPE', 'expected').trim().toLowerCase() === 'directory'
  ? 'directory'
  : 'expected';
// Upstream v1.3.8 named this CARTO_BASEMAP_KEY. CARTO_API_KEY was the name this
// fork shipped first and is still accepted so existing .env files keep working.
const CARTO_BASEMAP_KEY = envValue('CARTO_BASEMAP_KEY', '') || envValue('CARTO_API_KEY', '');
const MAP_TILE_DARK_URL = envValue('MAP_TILE_DARK_URL', '');
const MAP_TILE_LIGHT_URL = envValue('MAP_TILE_LIGHT_URL', '');
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

// CARTO raster basemaps require a free API key; keyless tiles are served but
// stamped with an "API KEY REQUIRED" watermark. https://carto.com/basemaps/apikey/
function cartoTileUrl(style) {
  const base = `https://{s}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png`;
  return CARTO_BASEMAP_KEY ? `${base}?key=${encodeURIComponent(CARTO_BASEMAP_KEY)}` : base;
}

const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors';
const CARTO_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';

function mapTileConfig() {
  // Without a key CARTO serves a watermarked tile, so fall back to OSM in both
  // themes rather than requesting one (upstream v1.3.8 behaviour).
  const darkTileUrl = MAP_TILE_DARK_URL
    || (CARTO_BASEMAP_KEY ? cartoTileUrl('dark_all') : OSM_TILE_URL);
  const lightTileUrl = MAP_TILE_LIGHT_URL
    || (CARTO_BASEMAP_KEY ? cartoTileUrl('light_all') : OSM_TILE_URL);
  const attributionFor = (url) => (url.includes('cartocdn.com') ? CARTO_ATTRIBUTION : OSM_ATTRIBUTION);
  return {
    darkTileUrl,
    lightTileUrl,
    darkAttribution: attributionFor(darkTileUrl),
    lightAttribution: attributionFor(lightTileUrl),
    cartoBasemapKey: CARTO_BASEMAP_KEY,
    darkBasemapAvailable: Boolean(CARTO_BASEMAP_KEY),
    cartoKeyConfigured: Boolean(CARTO_BASEMAP_KEY),
  };
}

const EXTERNAL_LINK_URL = normalizeSiteUrl(envValue('EXTERNAL_LINK_URL', ''));
const EXTERNAL_LINK_LABEL = envValue('EXTERNAL_LINK_LABEL', '');
const DASH_BROKER_HOST = envValue('DASH_BROKER_HOST', '');
const APP_TITLE_OVERRIDE = envValue('APP_TITLE', '');
const TRUST_PROXY = normalizeTrustProxy(envValue('TRUST_PROXY', '1'));
const TURNSTILE_SITE_KEY = envValue('TURNSTILE_SITE_KEY', '');
const TURNSTILE_SECRET_KEY = envValue('TURNSTILE_SECRET_KEY', '');
const TURNSTILE_ENABLED = envBool(
  'TURNSTILE_ENABLED',
  Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
);
const TURNSTILE_API_URL = envValue(
  'TURNSTILE_API_URL',
  'https://challenges.cloudflare.com/turnstile/v0/siteverify',
);
const TURNSTILE_COOKIE_NAME = envValue(
  'TURNSTILE_COOKIE_NAME',
  'mesh_health_turnstile',
);
const TURNSTILE_TOKEN_TTL_SECONDS = Math.max(
  300,
  envNumber('TURNSTILE_TOKEN_TTL_SECONDS', 86400),
);
const TURNSTILE_BOT_BYPASS = envBool('TURNSTILE_BOT_BYPASS', true);
const TURNSTILE_BOT_ALLOWLIST = dedupe(
  (
    envValue(
      'TURNSTILE_BOT_ALLOWLIST',
      'discordbot,twitterbot,slackbot,facebookexternalhit,linkedinbot,telegrambot,whatsapp',
    )
  )
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);
const TURNSTILE_VERIFY_RATE_WINDOW_MS = Math.max(
  60,
  envNumber('TURNSTILE_VERIFY_RATE_WINDOW_SECONDS', 600),
) * 1000;
const TURNSTILE_VERIFY_RATE_MAX = Math.max(
  1,
  envNumber('TURNSTILE_VERIFY_RATE_MAX', 10),
);
const SESSION_RATE_WINDOW_MS = Math.max(
  60,
  envNumber('SESSION_RATE_WINDOW_SECONDS', 600),
) * 1000;
const SESSION_RATE_MAX = Math.max(
  1,
  envNumber('SESSION_RATE_MAX', 30),
);
const OBSERVER_ACTIVE_WINDOW_MS = Math.max(
  60,
  envNumber('OBSERVER_ACTIVE_WINDOW_SECONDS', 900),
) * 1000;
const OBSERVER_TOP_WINDOW_DAYS = Math.max(
  1,
  Math.round(envNumber('OBSERVER_TOP_WINDOW_DAYS', 7)),
);
const OBSERVER_TOP_COUNT = Math.max(
  1,
  Math.round(envNumber('OBSERVER_TOP_COUNT', 10)),
);
// 'top-window' is the upstream behaviour: the default scoring target is the
// busiest OBSERVER_TOP_COUNT observers over OBSERVER_TOP_WINDOW_DAYS. 'active'
// makes it every scoring-eligible observer that reported inside the active
// window instead, which is the honest reachable audience once the eligible pool
// is comfortably larger than OBSERVER_TOP_COUNT.
const OBSERVER_TARGET_MODE = envValue('OBSERVER_TARGET_MODE', 'top-window')
  .trim()
  .toLowerCase() === 'active'
  ? 'active'
  : 'top-window';
// A percentage over a denominator of one or two is not a health score, it is a
// coin flip wearing a grade. Below this many observers in the scoring set the
// raw count is still reported but the percentage and the label are withheld.
const OBSERVER_MIN_SCORING_SET = Math.max(
  1,
  Math.round(envNumber('OBSERVER_MIN_SCORING_SET', 3)),
);
const OBSERVER_HASH_DISPLAY_BYTES = Math.max(
  1,
  Math.min(3, Math.round(envNumber('OBSERVER_HASH_DISPLAY_BYTES', 1))),
);
const OBSERVER_RETENTION_SECONDS = envNumber('OBSERVER_RETENTION_SECONDS', 14400);
const OBSERVER_RETENTION_MS = OBSERVER_RETENTION_SECONDS <= 0
  ? 0
  : Math.max(300, OBSERVER_RETENTION_SECONDS) * 1000;
const SESSION_TTL_MS = Math.max(60, envNumber('SESSION_TTL_SECONDS', 600)) * 1000;
const RESULT_RETENTION_MS = Math.max(
  SESSION_TTL_MS / 1000,
  envNumber('RESULT_RETENTION_SECONDS', 604800),
) * 1000;
const SESSION_HASH_ALIAS_WINDOW_MS = Math.max(
  5,
  envNumber('SESSION_HASH_ALIAS_WINDOW_SECONDS', 90),
) * 1000;
const MAX_USES_PER_CODE = Math.max(1, envNumber('MAX_USES_PER_CODE', 3));
const KNOWN_OBSERVERS = dedupe(envList('KNOWN_OBSERVERS').map(normalizeKey));

const channelsConfig = readStructuredFile(
  envValue('CHANNELS_FILE', ''),
);
const channelHashToInfo = new Map();

if (channelsConfig && Array.isArray(channelsConfig.channels)) {
  for (const entry of channelsConfig.channels) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const secret = normalizeHex(entry.secret);
    const hashOverride = normalizeHex(entry.hash);
    const name = String(entry.name || entry.label || '').trim();
    let channelHash = '';
    if (secret) {
      channelHash = calculateChannelHash(secret);
    } else if (hashOverride) {
      channelHash = hashOverride;
    }
    if (!channelHash) {
      continue;
    }
    channelHashToInfo.set(channelHash, {
      hash: channelHash,
      name,
      secret,
    });
  }
}

const envTestChannelSecret = normalizeHex(envValue('TEST_CHANNEL_SECRET', ''));
const testChannelName = envValue('TEST_CHANNEL_NAME', 'health-check').toLowerCase();

// The companion app imports a channel from meshcore://channel/add?name=&secret=
// (docs.meshcore.io/qr_codes). A hashtag channel's key is not random - it is
// sha256("#name") truncated to 16 bytes - so when TEST_CHANNEL_SECRET is left
// blank, as it should be for a hashtag channel, derive the same key the app
// would rather than shipping a QR that cannot be scanned.
const testChannelLabel = `#${testChannelName}`;
const testChannelInviteSecret = envTestChannelSecret
  || createHash('sha256').update(testChannelLabel).digest('hex').slice(0, 32);
const testChannelInviteUri =
  `meshcore://channel/add?name=${encodeURIComponent(testChannelLabel)}`
  + `&secret=${testChannelInviteSecret}`;
const testChannelQrSvg = (() => {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(testChannelInviteUri);
    qr.make();
    // The generated tag carries its own white background rect, so it stays
    // scannable on the dark theme without a wrapper.
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (error) {
    log('warn', `[qr] could not encode channel invite: ${error.message}`);
    return '';
  }
})();
let testChannelHash = envValue('TEST_CHANNEL_HASH', '').toLowerCase();
if (envTestChannelSecret) {
  const derivedHash = calculateChannelHash(envTestChannelSecret);
  if (derivedHash) {
    testChannelHash = testChannelHash || derivedHash;
    channelHashToInfo.set(derivedHash, {
      hash: derivedHash,
      name: testChannelName,
      secret: envTestChannelSecret,
    });
  }
}
if (!testChannelHash) {
  for (const info of channelHashToInfo.values()) {
    if (String(info.name || '').trim().toLowerCase() === testChannelName) {
      testChannelHash = info.hash;
      break;
    }
  }
}

function buildDecoderKeyCandidate(secretHex, channelHash = '') {
  const normalizedSecret = normalizeHex(secretHex);
  if (!normalizedSecret) {
    return null;
  }
  const secretBytes = Buffer.from(normalizedSecret, 'hex');
  if (secretBytes.length < 16) {
    return null;
  }
  const aesKey = secretBytes.subarray(0, 16);
  const hmacKey = Buffer.alloc(32);
  secretBytes.copy(hmacKey, 0, 0, Math.min(secretBytes.length, 32));
  return {
    secretHex: normalizedSecret,
    channelHash: String(channelHash || '').trim().toLowerCase(),
    aesKey,
    hmacKey,
  };
}

const decoderKeyCandidates = (() => {
  if (envTestChannelSecret) {
    const candidate = buildDecoderKeyCandidate(envTestChannelSecret, testChannelHash);
    if (candidate) {
      return [candidate];
    }
  }
  const fallback = testChannelHash ? channelHashToInfo.get(testChannelHash) : null;
  if (fallback?.secret) {
    const candidate = buildDecoderKeyCandidate(fallback.secret, testChannelHash);
    if (candidate) {
      return [candidate];
    }
  }
  return [];
})();

const meshPacketDecoderKeyStore = envTestChannelSecret
  ? MeshCorePacketDecoder.createKeyStore({
      channelSecrets: [envTestChannelSecret],
    })
  : null;

// ─── Region detection ─────────────────────────────────────────────────────────

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonCoords(lon, lat, rings) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false; // inside a hole
  }
  return true;
}

function pointInFeature(lon, lat, geometry) {
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(lon, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => pointInPolygonCoords(lon, lat, poly));
  }
  return false;
}

function expandBounds(bounds, coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return bounds;
  }
  const [lon, lat] = coordinate;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return bounds;
  }
  if (!bounds) {
    return [lon, lat, lon, lat];
  }
  bounds[0] = Math.min(bounds[0], lon);
  bounds[1] = Math.min(bounds[1], lat);
  bounds[2] = Math.max(bounds[2], lon);
  bounds[3] = Math.max(bounds[3], lat);
  return bounds;
}

function geometryBounds(geometry) {
  if (!geometry) {
    return null;
  }
  let bounds = null;
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates || []) {
      for (const coordinate of ring || []) {
        bounds = expandBounds(bounds, coordinate);
      }
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates || []) {
      for (const ring of polygon || []) {
        for (const coordinate of ring || []) {
          bounds = expandBounds(bounds, coordinate);
        }
      }
    }
  }
  return bounds;
}

function pointInBounds(lon, lat, bounds) {
  return Array.isArray(bounds)
    && lon >= bounds[0]
    && lat >= bounds[1]
    && lon <= bounds[2]
    && lat <= bounds[3];
}

function regionProperty(properties, names = []) {
  for (const name of names) {
    const value = properties?.[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function loadRegionBoundaries() {
  if (!REGIONS_FILE) return [];
  const filePath = resolveAppPath(REGIONS_FILE);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    logger.warn(`[regions] could not read ${filePath} — region detection disabled`);
    return [];
  }
  let geojson;
  try {
    geojson = JSON.parse(raw);
  } catch {
    logger.warn('[regions] regions file contains invalid JSON — region detection disabled');
    return [];
  }
  if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    logger.warn('[regions] regions file is not a GeoJSON FeatureCollection — region detection disabled');
    return [];
  }
  const boundaries = geojson.features.map((feature) => {
    const properties = feature?.properties || {};
    const type = feature?.geometry?.type;
    const name = regionProperty(properties, [
      REGION_NAME_PROPERTY,
      'name',
      'NAME',
      'name_en',
      'NAME_2',
      'NAME_1',
      'region',
      'subregion',
    ]);
    const group = regionProperty(properties, [
      REGION_GROUP_PROPERTY,
      'group',
      'parent',
      'regionGroup',
      'region_group',
    ]);
    return {
      name,
      group,
      geometry: feature?.geometry || null,
      type,
      bounds: geometryBounds(feature?.geometry || null),
    };
  }).filter((entry) => entry.name && (entry.type === 'Polygon' || entry.type === 'MultiPolygon'));
  logger.info(`[regions] loaded ${boundaries.length} region boundaries from ${REGIONS_FILE}`);
  return boundaries;
}

const regionBoundaries = loadRegionBoundaries();

// Boundary geometry served to the map layer. One outline per region group, not
// per subregion: the map is meant to show region shapes, and the subregion
// chips filter which observers are plotted inside them.
//
// REGIONS_FILE is configurable and some bundled files are enormous
// (regions/us-places.geojson carries 32,656 features, ~15 MB), so the client is
// never handed the whole file: only the groups that actually have observers.
// Coordinates are rounded to five decimals (~1 m) because this copy is for
// drawing, not for point-in-polygon tests - deriveRegionInfo() keeps using the
// unrounded geometry loaded above.
const REGION_GEOMETRY_DECIMALS = 5;

// A dissolved ring smaller than this fraction of its group's total ring area is
// discarded as an artifact. Adjacent subregions in a group share a border, but
// the shared vertices only cancel where both files agree exactly; along water
// boundaries they often disagree slightly and leave a tiny closed sliver. In
// the bundled Bay Area file the real rings are 235 km^2 and up while every
// sliver is under 0.12 km^2, so the gap this has to straddle is four orders of
// magnitude wide. The test is relative, not absolute, so it holds for a file
// whose groups are towns rather than counties.
const REGION_SLIVER_AREA_FRACTION = 1e-4;

function roundCoordinates(value) {
  if (Array.isArray(value)) {
    return value.map(roundCoordinates);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return value;
  }
  return Number(value.toFixed(REGION_GEOMETRY_DECIMALS));
}

function boundaryRings(geometry) {
  if (!geometry) {
    return [];
  }
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.filter(Array.isArray);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flat().filter(Array.isArray);
  }
  return [];
}

// Shoelace area in square degrees. Only ever compared against other rings from
// the same group, so leaving it unprojected is fine.
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += (ring[i][0] * ring[i + 1][1]) - (ring[i + 1][0] * ring[i][1]);
  }
  return Math.abs(sum) / 2;
}

// Merges several subregion polygons into the outline of the region they form, by
// dropping every border segment that two of them walk in opposite directions
// and stitching what is left back into closed rings. This is a topological
// dissolve: it only ever deletes and reconnects existing vertices, so it needs
// no geometry library and cannot invent coordinates. It relies on neighbours
// sharing exact vertices, which the bundled county file does (450 of its 2,080
// segments cancel this way).
function dissolveRings(rings) {
  const pointKey = (point) => `${point[0]},${point[1]}`;
  const counts = new Map();
  const points = new Map();
  rings.forEach((ring) => {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const from = pointKey(ring[i]);
      const to = pointKey(ring[i + 1]);
      if (from === to) {
        continue;
      }
      points.set(from, ring[i]);
      points.set(to, ring[i + 1]);
      const edge = `${from}>${to}`;
      counts.set(edge, (counts.get(edge) || 0) + 1);
    }
  });
  const outgoing = new Map();
  counts.forEach((count, edge) => {
    const [from, to] = edge.split('>');
    if (counts.has(`${to}>${from}`)) {
      return;
    }
    if (!outgoing.has(from)) {
      outgoing.set(from, []);
    }
    const targets = outgoing.get(from);
    for (let i = 0; i < count; i += 1) {
      targets.push(to);
    }
  });
  const stitched = [];
  outgoing.forEach((_targets, start) => {
    while (outgoing.get(start)?.length) {
      const ring = [points.get(start)];
      let cursor = start;
      for (;;) {
        const targets = outgoing.get(cursor);
        if (!targets?.length) {
          break;
        }
        cursor = targets.pop();
        ring.push(points.get(cursor));
        if (cursor === start) {
          break;
        }
      }
      // An unclosed chain means the inputs did not share vertices cleanly.
      // Dropping it would silently lose part of the outline, so the caller
      // falls back to the undissolved geometry instead.
      if (ring.length < 4 || pointKey(ring[0]) !== pointKey(ring[ring.length - 1])) {
        stitched.length = 0;
        return;
      }
      stitched.push(ring);
    }
  });
  if (!stitched.length) {
    return null;
  }
  const total = stitched.reduce((sum, ring) => sum + ringArea(ring), 0);
  const kept = stitched.filter((ring) => ringArea(ring) >= total * REGION_SLIVER_AREA_FRACTION);
  return kept.length ? kept : null;
}

// The map layer never fills these shapes, so a ring that was a hole in the
// input draws the same whether it is nested or promoted to its own polygon.
// That lets the dissolved output skip ring classification entirely.
function groupGeometry(boundaries) {
  if (boundaries.length === 1) {
    return boundaries[0].geometry;
  }
  const rings = boundaries.flatMap((boundary) => boundaryRings(boundary.geometry));
  const dissolved = dissolveRings(rings);
  if (!dissolved) {
    logger.warn(`[regions] could not dissolve ${boundaries.length} boundaries into one outline; drawing them separately`);
    return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
  }
  return { type: 'MultiPolygon', coordinates: dissolved.map((ring) => [ring]) };
}

let regionGeometryCache = { key: '', payload: null };

function regionBoundaryCollection(groups) {
  const wanted = new Set((Array.isArray(groups) ? groups : []).filter(Boolean));
  const key = [...wanted].sort().join('|');
  if (regionGeometryCache.key === key && regionGeometryCache.payload) {
    return regionGeometryCache.payload;
  }
  const byGroup = new Map();
  regionBoundaries.forEach((boundary) => {
    if (!boundary.group || !wanted.has(boundary.group)) {
      return;
    }
    if (!byGroup.has(boundary.group)) {
      byGroup.set(boundary.group, []);
    }
    byGroup.get(boundary.group).push(boundary);
  });
  const features = [...byGroup.entries()].map(([group, boundaries]) => {
    const geometry = groupGeometry(boundaries);
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return {
      type: 'Feature',
      properties: { group },
      geometry: { type: 'MultiPolygon', coordinates: roundCoordinates(polygons) },
    };
  });
  const payload = { type: 'FeatureCollection', features };
  regionGeometryCache = { key, payload };
  return payload;
}

// When true, a coordinate that falls outside every region boundary is ignored.
// mqtt.gomesh.dev carries observers well outside the Bay Area (an Orlando
// cluster, a Philadelphia repeater), and their adverts otherwise stretch the
// coverage map and its bounds across the continent.
const REQUIRE_REGION_MATCH = envBool('REQUIRE_REGION_MATCH', false);

function deriveRegionInfo(lat, lon) {
  if (lat == null || lon == null || regionBoundaries.length === 0) {
    return { region: null, regionGroup: null };
  }
  for (const boundary of regionBoundaries) {
    if (!pointInBounds(lon, lat, boundary.bounds)) {
      continue;
    }
    if (pointInFeature(lon, lat, boundary.geometry)) {
      return {
        region: boundary.name,
        regionGroup: boundary.group || null,
      };
    }
  }
  return { region: null, regionGroup: null };
}

// ---------- Uplink-code region classification ----------
// GoMesh publishes on meshcore/<CODE>/<pubkey>/<stream>, where <CODE> is the
// airport identifier of the uplink gateway's metro - not the node's own position.
// UPLINK_CODES_FILE classifies codes explicitly: "codes" are in-area, and the
// "outOfArea" block is the exclusion list. Observers on an out-of-area code are
// ALWAYS excluded - they never enter the directory, the region hierarchy, or any
// count - regardless of REGION_FALLBACK. A code in neither block stays
// unclassified: the observer is listed with no region, exactly as upstream, and
// the code is logged once so a new metro can be added deliberately. Setting
// REGION_FALLBACK=uplink-code additionally lets a listed code stand in for the
// region *group* of an observer that never publishes coordinates. Those
// observers are ordinary scoring targets; the inferred group is used for
// grouping and filtering only, never for the map or for Regions Reached.
// Without a mapping file nothing is classified and behaviour matches upstream.

function normalizeUplinkCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(code) ? code : '';
}

function loadUplinkCodes() {
  const codes = new Map();
  const excluded = new Set();
  if (!UPLINK_CODES_FILE) {
    return { codes, excluded };
  }
  const filePath = resolveAppPath(UPLINK_CODES_FILE);
  if (!fs.existsSync(filePath)) {
    logger.warn(`[regions] uplink code file not found: ${filePath}`);
    return { codes, excluded };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    logger.warn(`[regions] failed to parse ${filePath}: ${error.message}`);
    return { codes, excluded };
  }
  if (parsed?.outOfArea && typeof parsed.outOfArea === 'object' && !Array.isArray(parsed.outOfArea)) {
    for (const rawCode of Object.keys(parsed.outOfArea)) {
      const code = normalizeUplinkCode(rawCode);
      if (code) {
        excluded.add(code);
      }
    }
  }
  const table = parsed?.codes && typeof parsed.codes === 'object' ? parsed.codes : parsed;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    return { codes, excluded };
  }
  const knownGroups = new Set(regionBoundaries.map((boundary) => boundary.group).filter(Boolean));
  for (const [rawCode, rawValue] of Object.entries(table)) {
    const code = normalizeUplinkCode(rawCode);
    if (!code || excluded.has(code)) {
      continue;
    }
    const isObject = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue);
    const group = String((typeof rawValue === 'string' ? rawValue : isObject ? rawValue.group : '') || '').trim();
    if (!group) {
      continue;
    }
    // A code pointing at a group the boundary file does not define would create a
    // phantom chip that no located observer can ever join.
    if (knownGroups.size > 0 && !knownGroups.has(group)) {
      logger.warn(`[regions] uplink code ${code} maps to unknown group "${group}", ignored`);
      continue;
    }
    codes.set(code, {
      group,
      label: String((isObject && rawValue.label) || code).trim() || code,
      confidence: String((isObject && rawValue.confidence) || 'observed').trim().toLowerCase(),
    });
  }
  return { codes, excluded };
}

const { codes: uplinkCodes, excluded: uplinkCodesOutOfArea } = loadUplinkCodes();
const UPLINK_CODES_LOADED = uplinkCodes.size > 0 || uplinkCodesOutOfArea.size > 0;
const REGION_FALLBACK_UPLINK = REGION_FALLBACK === 'uplink-code' && uplinkCodes.size > 0;
if (UPLINK_CODES_LOADED) {
  logger.info(
    `[regions] loaded ${uplinkCodes.size} in-area and ${uplinkCodesOutOfArea.size} out-of-area`
    + ` uplink codes from ${UPLINK_CODES_FILE}; region fallback ${REGION_FALLBACK_UPLINK ? 'on' : 'off'}`,
  );
} else if (REGION_FALLBACK === 'uplink-code') {
  logger.warn('[regions] REGION_FALLBACK=uplink-code needs UPLINK_CODES_FILE; fallback disabled');
}

function uplinkCodeIsOutOfArea(value) {
  const code = normalizeUplinkCode(value);
  return Boolean(code && uplinkCodesOutOfArea.has(code));
}

// Codes in neither block are reported once each, so a new metro shows up in the
// log instead of silently sitting in the directory with no region.
const unclassifiedUplinkCodes = new Set();
function noteUplinkCode(value) {
  const code = normalizeUplinkCode(value);
  if (!UPLINK_CODES_LOADED || !code || unclassifiedUplinkCodes.has(code)) {
    return;
  }
  if (uplinkCodes.has(code) || uplinkCodesOutOfArea.has(code)) {
    return;
  }
  unclassifiedUplinkCodes.add(code);
  logger.warn(`[regions] uplink code ${code} is in neither codes nor outOfArea; region unresolved`);
}

function observerIsOutOfArea(observer) {
  return uplinkCodeIsOutOfArea(observer?.uplinkCode);
}

// Coordinates always win. The uplink code is a group-level hint only: it never
// sets observer.region, so an inferred observer contributes no county to the
// hierarchy and can never gain a map marker.
function resolveObserverRegion(observer) {
  const fromCoordinates = deriveRegionInfo(observer?.lat ?? null, observer?.lon ?? null);
  if (fromCoordinates.region) {
    return { ...fromCoordinates, regionSource: 'coordinates' };
  }
  if (REGION_FALLBACK_UPLINK) {
    const info = uplinkCodes.get(normalizeUplinkCode(observer?.uplinkCode));
    if (info) {
      return { region: null, regionGroup: info.group, regionSource: 'uplink-code' };
    }
  }
  return { region: null, regionGroup: null, regionSource: null };
}

function observerRegionIsInferred(observer) {
  return Boolean(REGION_FALLBACK_UPLINK && observer?.regionSource === 'uplink-code');
}

// Only an out-of-area uplink code disqualifies an observer from scoring. A
// missing position does NOT: an observer that publishes no coordinates still
// hears the channel and still publishes a receipt, and that receipt is the only
// thing scoring actually measures. Excluding those nodes threw away 13 of 35
// live Bay Area observers - several of them among the busiest on the network -
// and made the health score a report on who happens to broadcast GPS.
//
// The two properties that a missing position DOES govern are handled elsewhere
// and stay strict: the coverage map plots lat/lon so an unlocated observer never
// gets a marker, and regionCoverageFor() counts coordinate-derived groups only,
// so an uplink-inferred group cannot inflate Regions Reached.
function observerIsScoringEligible(observerKey) {
  const observer = observerState.get(normalizeKey(observerKey));
  if (!observer) {
    return true;
  }
  return !observerIsOutOfArea(observer);
}

function utcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function recentUtcDayKeys(days, now = Date.now()) {
  const safeDays = Math.max(1, Math.round(Number(days) || 1));
  const keys = [];
  for (let index = 0; index < safeDays; index += 1) {
    keys.push(utcDayKey(now - (index * 86400000)));
  }
  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────

const observerProfiles = parseObserversJson(OBSERVERS_FILE_PATH);
const pinnedObserverNameKeys = new Set(
  [...observerProfiles.entries()]
    .filter(([, profile]) => String(profile?.name || '').trim())
    .map(([key]) => key),
);
const appHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/index.html'), 'utf8');
const landingHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/landing.html'), 'utf8');
const shareHtmlTemplate = fs.readFileSync(path.join(APP_DIR, 'public/share.html'), 'utf8');
const observerState = new Map();
const observerActivityHistory = parseObserverActivityJson(OBSERVER_ACTIVITY_FILE_PATH);
const sessions = new Map();
const messageToSession = new Map();
const rateLimitBuckets = new Map();
const turnstileAuthTokens = new Map();
let observerNamesWriteTimer = null;
let reseedInFlight = false;
let reseedLastDayKey = null;
let reseedLastResult = null;
let reseedInterval = null;
let reseedBootTimer = null;
let observerActivityWriteTimer = null;
let resultsWriteTimer = null;

function writeJsonFileAtomic(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EXDEV') {
      fs.writeFileSync(filePath, body, 'utf8');
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore cleanup failure
      }
      return;
    }
    throw error;
  }
}

function parseObserverActivityJson(filePath) {
  const resolved = resolveAppPath(filePath);
  if (!fs.existsSync(resolved)) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const rawObservers = parsed?.observers && typeof parsed.observers === 'object'
      ? parsed.observers
      : parsed;
    const history = new Map();
    if (!rawObservers || typeof rawObservers !== 'object' || Array.isArray(rawObservers)) {
      return history;
    }

    for (const [rawKey, rawEntry] of Object.entries(rawObservers)) {
      const key = normalizeKey(rawKey);
      if (!key || !rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        continue;
      }
      const days = {};
      const rawDays = rawEntry.days && typeof rawEntry.days === 'object' ? rawEntry.days : {};
      for (const [dayKey, rawCount] of Object.entries(rawDays)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
          continue;
        }
        const count = Math.max(0, Math.floor(Number(rawCount) || 0));
        if (count > 0) {
          days[dayKey] = count;
        }
      }
      const lastPacketAt = Number(rawEntry.lastPacketAt || 0);
      if (Object.keys(days).length > 0 || (Number.isFinite(lastPacketAt) && lastPacketAt > 0)) {
        history.set(key, {
          days,
          lastPacketAt: Number.isFinite(lastPacketAt) && lastPacketAt > 0 ? lastPacketAt : 0,
        });
      }
    }
    return history;
  } catch (error) {
    logger.warn(`[config] failed to parse ${resolved}: ${error.message}`);
    return new Map();
  }
}

function cloneObserverActivityHistory(source) {
  const out = new Map();
  for (const [key, entry] of source.entries()) {
    out.set(key, {
      days: { ...(entry?.days || {}) },
      lastPacketAt: Number(entry?.lastPacketAt || 0),
    });
  }
  return out;
}

const baselineObserverActivityHistory = cloneObserverActivityHistory(observerActivityHistory);

function sessionRetentionDeadline(session) {
  const createdAt = Number(session?.createdAt || 0);
  return createdAt + RESULT_RETENTION_MS;
}

function isRetainedSession(session, now = Date.now()) {
  if (!session?.id || !Number.isFinite(Number(session.createdAt))) {
    return false;
  }
  return now < sessionRetentionDeadline(session);
}

function serializeSessionRecord(session) {
  return {
    id: session.id,
    code: session.code,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    status: session.status,
    useCount: session.useCount,
    maxUses: session.maxUses,
    messageHash: session.messageHash,
    messageHashes: Array.isArray(session.messageHashes)
      ? session.messageHashes.map(normalizeMessageHash).filter(Boolean)
      : [],
    matchedAt: session.matchedAt,
    messageBody: session.messageBody,
    sender: session.sender,
    channelHash: session.channelHash,
    channelName: session.channelName,
    allowlistEnabled: Boolean(session.allowlistEnabled),
    activeObserverKeys: Array.isArray(session.activeObserverKeys)
      ? session.activeObserverKeys.map(normalizeKey).filter(Boolean)
      : [],
    expectedObserverKeys: Array.isArray(session.expectedObserverKeys)
      ? session.expectedObserverKeys.map(normalizeKey).filter(Boolean)
      : [],
    expectedObserverSource: String(session.expectedObserverSource || ''),
    receipts: [...(session.receipts?.values() || [])].map((receipt) => ({
      observerKey: normalizeKey(receipt.observerKey),
      observerHash: String(receipt.observerHash || '').trim().toUpperCase(),
      observerLabel: String(receipt.observerLabel || '').trim(),
      observerName: String(receipt.observerName || '').trim(),
      firstSeenAt: Number(receipt.firstSeenAt || 0),
      lastSeenAt: Number(receipt.lastSeenAt || 0),
      count: Math.max(1, Number(receipt.count || 1)),
      topic: String(receipt.topic || ''),
      messageHash: normalizeMessageHash(receipt.messageHash),
      packetType: receipt.packetType,
      channelName: String(receipt.channelName || ''),
      rssi: Number.isFinite(Number(receipt.rssi)) ? Number(receipt.rssi) : null,
      snr: Number.isFinite(Number(receipt.snr)) ? Number(receipt.snr) : null,
      duration: Number.isFinite(Number(receipt.duration)) ? Number(receipt.duration) : null,
      path: Array.isArray(receipt.path)
        ? receipt.path.map(normalizePathHop).filter(Boolean)
        : [],
    })).filter((receipt) => receipt.observerKey),
  };
}

function restoreSessionRecord(rawSession) {
  if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
    return null;
  }
  const id = String(rawSession.id || '').trim();
  const code = String(rawSession.code || '').trim().toUpperCase();
  const createdAt = Number(rawSession.createdAt || 0);
  if (!id || !code || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  const expectedObserverKeys = Array.isArray(rawSession.expectedObserverKeys)
    ? rawSession.expectedObserverKeys.map(normalizeKey).filter(Boolean)
    : [];
  const receipts = new Map();
  for (const rawReceipt of Array.isArray(rawSession.receipts) ? rawSession.receipts : []) {
    const observerKey = normalizeKey(rawReceipt?.observerKey);
    if (!observerKey) {
      continue;
    }
    ensureObserverRecord(observerKey);
    receipts.set(observerKey, {
      observerKey,
      observerHash: String(rawReceipt?.observerHash || '').trim().toUpperCase(),
      observerLabel: String(rawReceipt?.observerLabel || '').trim(),
      observerName: String(rawReceipt?.observerName || '').trim() || null,
      firstSeenAt: Number(rawReceipt?.firstSeenAt || createdAt),
      lastSeenAt: Number(rawReceipt?.lastSeenAt || rawReceipt?.firstSeenAt || createdAt),
      count: Math.max(1, Number(rawReceipt?.count || 1)),
      topic: String(rawReceipt?.topic || ''),
      messageHash: normalizeMessageHash(rawReceipt?.messageHash || rawSession.messageHash || ''),
      packetType: rawReceipt?.packetType ?? null,
      channelName: String(rawReceipt?.channelName || rawSession.channelName || ''),
      rssi: Number.isFinite(Number(rawReceipt?.rssi)) ? Number(rawReceipt.rssi) : null,
      snr: Number.isFinite(Number(rawReceipt?.snr)) ? Number(rawReceipt.snr) : null,
      duration: Number.isFinite(Number(rawReceipt?.duration)) ? Number(rawReceipt.duration) : null,
      path: Array.isArray(rawReceipt?.path)
        ? rawReceipt.path.map(normalizePathHop).filter(Boolean)
        : [],
    });
  }
  for (const observerKey of expectedObserverKeys) {
    ensureObserverRecord(observerKey);
  }
  return {
    id,
    code,
    createdAt,
    expiresAt: Number(rawSession.expiresAt || (createdAt + SESSION_TTL_MS)),
    status: String(rawSession.status || 'waiting'),
    useCount: Math.max(0, Number(rawSession.useCount || 0)),
    maxUses: Math.max(1, Number(rawSession.maxUses || MAX_USES_PER_CODE)),
    messageHash: normalizeMessageHash(rawSession.messageHash || ''),
    messageHashes: dedupe(
      (Array.isArray(rawSession.messageHashes) ? rawSession.messageHashes : [])
        .map(normalizeMessageHash)
        .filter(Boolean),
    ),
    matchedAt: Number(rawSession.matchedAt || 0),
    messageBody: String(rawSession.messageBody || ''),
    sender: String(rawSession.sender || ''),
    channelHash: String(rawSession.channelHash || '').trim().toLowerCase(),
    channelName: String(rawSession.channelName || ''),
    allowlistEnabled: Boolean(rawSession.allowlistEnabled),
    activeObserverKeys: Array.isArray(rawSession.activeObserverKeys)
      ? rawSession.activeObserverKeys.map(normalizeKey).filter(Boolean)
      : [],
    expectedObserverKeys,
    expectedObserverSource: String(rawSession.expectedObserverSource || ''),
    receipts,
  };
}

function writeResultsFile() {
  const payload = {
    version: 1,
    sessions: [...sessions.values()]
      .filter((session) => isRetainedSession(session))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(serializeSessionRecord),
  };
  writeJsonFileAtomic(RESULTS_FILE_PATH, payload);
}

function scheduleResultsWrite() {
  if (DISABLE_RESULTS_FILE_WRITES) {
    return;
  }
  if (resultsWriteTimer) {
    return;
  }
  resultsWriteTimer = setTimeout(() => {
    resultsWriteTimer = null;
    writeResultsFile();
  }, 250);
}

function flushScheduledWrites() {
  if (observerNamesWriteTimer) {
    clearTimeout(observerNamesWriteTimer);
    observerNamesWriteTimer = null;
    writeObserverNamesFile();
  }
  if (observerActivityWriteTimer) {
    clearTimeout(observerActivityWriteTimer);
    observerActivityWriteTimer = null;
    writeObserverActivityFile();
  }
  if (resultsWriteTimer) {
    clearTimeout(resultsWriteTimer);
    resultsWriteTimer = null;
    writeResultsFile();
  }
}

function writeObserverNamesFile() {
  const payload = {};
  for (const [key, profile] of [...observerProfiles.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!profile) {
      continue;
    }
    const name = String(profile.name || '').trim();
    const uplink = normalizeUplinkCode(profile.uplink);
    const lat = normalizeCoordinate(profile.lat, 'lat');
    const lon = normalizeCoordinate(profile.lon, 'lon');
    const rawHashBytes = Number(profile.hashBytes);
    const hashBytes = Number.isInteger(rawHashBytes) && rawHashBytes >= 1 && rawHashBytes <= 3
      ? rawHashBytes
      : null;
    const rawLocationUpdatedAt = Number(profile.locationUpdatedAt);
    const hasLocation = lat != null && lon != null;
    const locationUpdatedAt = hasLocation && Number.isFinite(rawLocationUpdatedAt) && rawLocationUpdatedAt > 0
      ? rawLocationUpdatedAt
      : null;
    payload[key] = {
      ...(name ? { name } : {}),
      ...(uplink ? { uplink } : {}),
      ...(lat != null ? { lat } : {}),
      ...(lon != null ? { lon } : {}),
      ...(hashBytes != null ? { hashBytes } : {}),
      ...(locationUpdatedAt != null ? { locationUpdatedAt } : {}),
    };
  }
  writeJsonFileAtomic(OBSERVERS_FILE_PATH, payload);
}

function scheduleObserverNamesWrite() {
  if (DISABLE_OBSERVER_FILE_WRITES) {
    return;
  }
  if (observerNamesWriteTimer) {
    return;
  }
  observerNamesWriteTimer = setTimeout(() => {
    observerNamesWriteTimer = null;
    writeObserverNamesFile();
  }, 250);
}

function localDayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The script owns coordinates and confirmed hash widths: it merges without
// overwriting an app-learned fix and deliberately drops a position outside the
// region boundary or a width CoreScope no longer confirms, so the file wins for
// those three fields. Names and uplink codes are learned here from adverts and
// MQTT topics, so a value already in memory wins over the file's.
function applyReseededProfiles(fresh) {
  let changed = 0;
  for (const [key, incoming] of fresh.entries()) {
    if (!incoming) {
      continue;
    }
    const live = observerProfiles.get(key) || {};
    const nextLat = normalizeCoordinate(incoming.lat, 'lat');
    const nextLon = normalizeCoordinate(incoming.lon, 'lon');
    const locationChanged = (live.lat ?? null) !== (nextLat ?? null) || (live.lon ?? null) !== (nextLon ?? null);
    const merged = {
      ...live,
      name: String(live.name || '').trim() || String(incoming.name || '').trim() || '',
      uplink: normalizeUplinkCode(live.uplink) || normalizeUplinkCode(incoming.uplink) || '',
      lat: nextLat,
      lon: nextLon,
      // The script can also clear a position it no longer confirms, so only
      // stamp when the coordinates actually differ, and only keep a stamp at
      // all when the merged result still has a location.
      locationUpdatedAt: locationChanged
        ? (nextLat != null && nextLon != null ? Date.now() : null)
        : (live.locationUpdatedAt ?? null),
    };
    const width = Number(incoming.hashBytes);
    if (Number.isInteger(width) && width >= 1 && width <= 3) {
      merged.hashBytes = width;
    } else {
      delete merged.hashBytes;
    }
    // Compare the five fields the store actually persists. Comparing whole
    // objects counted every profile as changed, because the merge normalises
    // absent values to '' / null where the file simply omits them.
    const fields = ['name', 'uplink', 'lat', 'lon', 'hashBytes'];
    const differs = fields.some((field) => (live[field] ?? null) !== (merged[field] ?? null));
    observerProfiles.set(key, merged);
    if (differs) {
      changed += 1;
    }
  }
  return changed;
}

function appendReseedLog(entry) {
  try {
    fs.mkdirSync(path.dirname(OBSERVER_RESEED_LOG_PATH), { recursive: true });
    fs.appendFileSync(OBSERVER_RESEED_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    logger.warn(`[reseed] could not append to ${OBSERVER_RESEED_LOG_PATH}: ${error.message}`);
  }
}

// Both region inputs are hashed, not only the boundary file: moving a code
// between the "codes" and "outOfArea" blocks changes which observers are in
// area, and re-running a pass that turns out to change nothing is far cheaper
// than reasoning about which edits can affect positions.
function computeRegionFingerprint() {
  const inputs = [['regions', REGIONS_FILE], ['uplinkCodes', UPLINK_CODES_FILE]];
  const parts = [];
  for (const [label, configured] of inputs) {
    if (!configured) {
      continue;
    }
    try {
      const digest = createHash('sha256')
        .update(fs.readFileSync(resolveAppPath(configured)))
        .digest('hex');
      parts.push(`${label}:${digest}`);
    } catch (error) {
      // An unreadable input is not a changed input. Folding the error into the
      // hash would make every boot look different and fire a pass each time.
      logger.warn(`[reseed] could not fingerprint ${configured}: ${error.message}`);
      return null;
    }
  }
  if (!parts.length) {
    return null;
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Only successful passes count: a failed run leaves positions untouched, so its
// fingerprint must not satisfy the next boot's check.
function loadLastReseedFingerprint() {
  try {
    const lines = fs.readFileSync(OBSERVER_RESEED_LOG_PATH, 'utf8').trim().split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = JSON.parse(lines[index]);
      if (entry && entry.ok && entry.regionFingerprint) {
        return String(entry.regionFingerprint);
      }
    }
  } catch {
    // no log yet
  }
  return null;
}

// Restarts must not re-run a pass that already ran today, so the last day key
// comes off the log rather than resetting to null on every boot.
function loadLastReseedDayKey() {
  try {
    const lines = fs.readFileSync(OBSERVER_RESEED_LOG_PATH, 'utf8').trim().split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = JSON.parse(lines[index]);
      if (entry && entry.dayKey && entry.trigger === 'schedule') {
        return String(entry.dayKey);
      }
    }
  } catch {
    // no log yet
  }
  return null;
}

function runSeedScript() {
  return new Promise((resolve) => {
    execFile(
      OBSERVER_RESEED_PYTHON,
      [OBSERVER_RESEED_SCRIPT, '--write', '--json'],
      { cwd: APP_DIR, timeout: OBSERVER_RESEED_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    );
  });
}

async function runObserverReseed(trigger = 'manual') {
  if (reseedInFlight) {
    return { ok: false, skipped: 'a reseed is already running' };
  }
  reseedInFlight = true;
  const startedAt = Date.now();
  const dayKey = localDayKey();
  const regionFingerprint = computeRegionFingerprint();
  try {
    // Land anything learned since the last debounce so the script reads a file
    // that matches memory, and clear the pending timer that would otherwise
    // fire mid-run and overwrite the script's output.
    flushScheduledWrites();

    const { error, stdout, stderr } = await runSeedScript();
    const line = stdout.split('\n').reverse().find((row) => row.startsWith('SEED_JSON '));
    const summary = line ? JSON.parse(line.slice('SEED_JSON '.length)) : null;

    if (error || !summary || !summary.wrote) {
      const detail = error ? error.message : (summary ? 'script reported no write' : 'no summary line');
      const failure = {
        ok: false, trigger, dayKey, regionFingerprint, at: new Date().toISOString(),
        ms: Date.now() - startedAt, error: detail,
        stderr: stderr.trim().split('\n').slice(-3).join(' | '),
      };
      logger.warn(`[reseed] ${trigger} failed: ${detail}`);
      appendReseedLog(failure);
      reseedLastResult = failure;
      return failure;
    }

    const applied = applyReseededProfiles(parseObserversJson(OBSERVERS_FILE_PATH));
    // Reconcile the file with the merge above (app-learned names and uplinks).
    scheduleObserverNamesWrite();

    const result = {
      ok: true, trigger, dayKey, regionFingerprint, at: new Date().toISOString(),
      ms: Date.now() - startedAt,
      profilesChangedInMemory: applied,
      profiles: summary.profiles || null,
      uplinks: summary.uplinks || null,
      hashWidth: summary.hashWidth || null,
      backup: summary.backup || null,
    };
    const uplinks = summary.uplinks || {};
    const widths = summary.hashWidth || {};
    logger.info(
      `[reseed] ${trigger} ok in ${result.ms}ms: located ${uplinks.locatedBefore ?? '?'}`
      + ` -> ${uplinks.locatedAfter ?? '?'} of ${uplinks.total ?? '?'} uplinks,`
      + ` hash width +${widths.newlyRecorded ?? 0}/~${(widths.changed || []).length}/-${widths.cleared ?? 0},`
      + ` ${applied} profiles updated in memory`,
    );
    appendReseedLog(result);
    reseedLastResult = result;
    // A boot pass is extra work, not the day's pass: claiming the day key here
    // would let a deploy suppress the scheduled run.
    if (trigger !== 'boot') {
      reseedLastDayKey = dayKey;
    }
    broadcastSnapshot(true);
    return result;
  } catch (error) {
    const failure = {
      ok: false, trigger, dayKey, regionFingerprint, at: new Date().toISOString(),
      ms: Date.now() - startedAt, error: error.message,
    };
    logger.warn(`[reseed] ${trigger} threw: ${error.message}`);
    appendReseedLog(failure);
    reseedLastResult = failure;
    return failure;
  } finally {
    reseedInFlight = false;
  }
}

// Checked every ten minutes rather than fired on the minute, so a restart or a
// slow host cannot make the day's pass silently skip.
function maybeRunScheduledReseed() {
  if (!OBSERVER_RESEED_ENABLED || reseedInFlight) {
    return;
  }
  const now = new Date();
  const dayKey = localDayKey(now);
  if (reseedLastDayKey === dayKey || now.getHours() < OBSERVER_RESEED_HOUR) {
    return;
  }
  reseedLastDayKey = dayKey;
  runObserverReseed('schedule').catch((error) => {
    logger.warn(`[reseed] scheduled run rejected: ${error.message}`);
  });
}

function writeObserverActivityFile() {
  const observers = {};
  for (const [key, entry] of [...observerActivityHistory.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const days = Object.fromEntries(
      Object.entries(entry?.days || {})
        .filter(([, count]) => Math.max(0, Math.floor(Number(count) || 0)) > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dayKey, count]) => [dayKey, Math.max(0, Math.floor(Number(count) || 0))]),
    );
    const lastPacketAt = Number(entry?.lastPacketAt || 0);
    if (Object.keys(days).length === 0 && !(Number.isFinite(lastPacketAt) && lastPacketAt > 0)) {
      continue;
    }
    observers[key] = {
      ...(Object.keys(days).length > 0 ? { days } : {}),
      ...(Number.isFinite(lastPacketAt) && lastPacketAt > 0 ? { lastPacketAt } : {}),
    };
  }
  writeJsonFileAtomic(OBSERVER_ACTIVITY_FILE_PATH, {
    version: 1,
    observers,
  });
}

function scheduleObserverActivityWrite() {
  if (observerActivityWriteTimer) {
    return;
  }
  observerActivityWriteTimer = setTimeout(() => {
    observerActivityWriteTimer = null;
    writeObserverActivityFile();
  }, 250);
}

if (!fs.existsSync(OBSERVERS_FILE_PATH)) {
  writeObserverNamesFile();
}

if (!fs.existsSync(RESULTS_FILE_PATH) && !DISABLE_RESULTS_FILE_WRITES) {
  writeResultsFile();
}

function createObserverRecord(observerKey) {
  const profile = observerProfiles.get(observerKey) || null;
  const activity = observerActivityHistory.get(observerKey) || null;
  const lat = normalizeCoordinate(profile?.lat ?? null, 'lat');
  const lon = normalizeCoordinate(profile?.lon ?? null, 'lon');
  const rawLocationUpdatedAt = profile?.locationUpdatedAt;
  const locationUpdatedAt = lat != null && lon != null && rawLocationUpdatedAt != null && Number.isFinite(Number(rawLocationUpdatedAt))
    ? Number(rawLocationUpdatedAt)
    : null;
  const uplinkCode = normalizeUplinkCode(profile?.uplink ?? null);
  const regionInfo = resolveObserverRegion({ lat, lon, uplinkCode });
  const lastPacketAt = Math.max(0, Number(activity?.lastPacketAt || 0));
  return {
    key: observerKey,
    hash: hashFromKeyPrefix(observerKey, observerHashBytes(observerKey)),
    name: profile?.name || null,
    lat,
    lon,
    locationUpdatedAt,
    uplinkCode: uplinkCode || null,
    region: regionInfo.region,
    regionGroup: regionInfo.regionGroup,
    regionSource: regionInfo.regionSource,
    firstSeenAt: lastPacketAt,
    lastPacketAt,
    packetCount: 0,
  };
}

function normalizeMessageHash(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) {
    return '';
  }
  const compact = raw.replace(/[^0-9A-F]/g, '');
  return compact || raw;
}

function normalizeCoordinate(value, axis) {
  if (value == null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const limit = axis === 'lat' ? 90 : 180;
  if (Math.abs(numeric) <= limit) {
    return Number(numeric.toFixed(6));
  }
  for (const scale of [1e7, 1e6, 1e5, 1e4]) {
    const scaled = numeric / scale;
    if (Math.abs(scaled) <= limit) {
      return Number(scaled.toFixed(6));
    }
  }
  return null;
}

function extractLocationCandidate(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const lat = normalizeCoordinate(value.lat ?? value.latitude ?? null, 'lat');
  const lon = normalizeCoordinate(value.lon ?? value.lng ?? value.longitude ?? null, 'lon');
  if (lat === 0 && lon === 0) {
    return null;
  }
  if (lat != null && lon != null) {
    return { lat, lon };
  }
  return null;
}

function extractObserverLocation(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const direct = extractLocationCandidate(value);
  if (direct) {
    return direct;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') {
      continue;
    }
    const found = extractObserverLocation(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function normalizedSender(value) {
  return String(value || '').trim().toLowerCase();
}

function unlinkSessionHashes(session, clearHashes = true) {
  if (!session) {
    return;
  }
  const knownHashes = Array.isArray(session.messageHashes)
    ? session.messageHashes
    : [session.messageHash].filter(Boolean);
  for (const hash of knownHashes) {
    messageToSession.delete(hash);
  }
  if (clearHashes) {
    session.messageHashes = [];
  }
}

function linkSessionHash(session, hash) {
  const normalizedHash = normalizeMessageHash(hash);
  if (!session || !normalizedHash) {
    return;
  }
  const knownHashes = Array.isArray(session.messageHashes) ? session.messageHashes : [];
  if (!knownHashes.includes(normalizedHash)) {
    knownHashes.push(normalizedHash);
  }
  session.messageHashes = knownHashes;
  if (!session.messageHash) {
    session.messageHash = normalizedHash;
  }
  messageToSession.set(normalizedHash, session.id);
}

function isSameActiveMessageAlias(session, packetInfo) {
  if (!session?.messageHash || !session?.matchedAt) {
    return false;
  }
  if (!packetInfo?.messageHash || !packetInfo?.messageBody) {
    return false;
  }
  if (packetInfo.messageHash === session.messageHash) {
    return true;
  }
  if (packetInfo.seenAt - session.matchedAt > SESSION_HASH_ALIAS_WINDOW_MS) {
    return false;
  }
  if (session.receipts?.size <= 0) {
    return false;
  }
  if (String(session.messageBody || '').trim() !== String(packetInfo.messageBody || '').trim()) {
    return false;
  }
  const currentSender = normalizedSender(session.sender);
  const nextSender = normalizedSender(packetInfo.sender);
  if (currentSender && nextSender && currentSender !== nextSender) {
    return false;
  }
  if (session.channelHash && packetInfo.channelHash && session.channelHash !== packetInfo.channelHash) {
    return false;
  }
  return true;
}

function ensureObserverRecord(observerKey) {
  const normalizedKey = normalizeKey(observerKey);
  if (!normalizedKey) {
    return null;
  }
  let observer = observerState.get(normalizedKey);
  if (!observer) {
    observer = createObserverRecord(normalizedKey);
    observerState.set(normalizedKey, observer);
  }
  const profile = observerProfiles.get(normalizedKey) || null;
  if (!observer.name && profile?.name) {
    observer.name = profile.name;
  }
  if (observer.lat == null && profile?.lat != null) {
    observer.lat = normalizeCoordinate(profile.lat, 'lat');
  }
  if (observer.lon == null && profile?.lon != null) {
    observer.lon = normalizeCoordinate(profile.lon, 'lon');
  }
  if (observer.locationUpdatedAt == null && profile?.locationUpdatedAt != null) {
    observer.locationUpdatedAt = profile.locationUpdatedAt;
  }
  if (!observer.uplinkCode && profile?.uplink) {
    observer.uplinkCode = normalizeUplinkCode(profile.uplink) || null;
  }
  return observer;
}

function primeObserverDirectory() {
  for (const key of observerProfiles.keys()) {
    ensureObserverRecord(key);
  }
  for (const key of observerActivityHistory.keys()) {
    ensureObserverRecord(key);
  }
  for (const key of KNOWN_OBSERVERS) {
    ensureObserverRecord(key);
  }
}

primeObserverDirectory();

function loadRetainedSessions() {
  const parsed = readStructuredFile(RESULTS_FILE_PATH);
  const rawSessions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.sessions)
      ? parsed.sessions
      : [];
  const now = Date.now();
  let dropped = false;
  for (const rawSession of rawSessions) {
    const session = restoreSessionRecord(rawSession);
    if (!session) {
      dropped = true;
      continue;
    }
    if (!isRetainedSession(session, now)) {
      dropped = true;
      continue;
    }
    if (session.status !== 'expired' && now >= session.expiresAt) {
      session.status = 'expired';
    }
    sessions.set(session.id, session);
    for (const hash of session.messageHashes) {
      if (session.status !== 'expired') {
        messageToSession.set(hash, session.id);
      }
    }
  }
  if (dropped) {
    scheduleResultsWrite();
  }
}

loadRetainedSessions();

function parseCookies(cookieHeader) {
  const out = {};
  const source = String(cookieHeader || '');
  if (!source) {
    return out;
  }
  for (const part of source.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!key) {
      continue;
    }
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function requestOrigin(request) {
  if (SITE_URL) {
    return SITE_URL;
  }
  const protocol = request.protocol || (request.secure ? 'https' : 'http');
  const host = request.get('host') || 'localhost';
  return `${protocol}://${host}`;
}

function embedTitle() {
  return APP_TITLE_OVERRIDE || APP_TITLE || APP_EYEBROW || `#${testChannelName}`;
}

function embedDescription() {
  const configured = String(APP_DESCRIPTION || '').trim();
  if (configured) {
    return configured;
  }
  return `MeshCore observer coverage for #${testChannelName}.`;
}

function renderHtmlTemplate(template, request, pageTitleSuffix = '') {
  const title = embedTitle();
  const description = embedDescription();
  const origin = requestOrigin(request);
  const url = `${origin}${request.originalUrl || request.url || '/'}`;
  const imageUrl = `${origin}/logo.png`;
  const htmlTitle = pageTitleSuffix ? `${title} ${pageTitleSuffix}` : title;

  return template
    .replaceAll('__APP_HTML_TITLE__', escapeHtml(htmlTitle))
    .replaceAll('__APP_META_TITLE__', escapeHtml(title))
    .replaceAll('__APP_META_DESCRIPTION__', escapeHtml(description))
    .replaceAll('__APP_META_URL__', escapeHtml(url))
    .replaceAll('__APP_META_IMAGE__', escapeHtml(imageUrl))
    .replaceAll('__MAP_OBSERVER_SCOPE__', escapeHtml(MAP_OBSERVER_SCOPE));
}

function clientAddress(requestLike) {
  return (
    requestLike.ip ||
    requestLike.socket?.remoteAddress ||
    requestLike.connection?.remoteAddress ||
    'unknown'
  );
}

function isAllowlistedTurnstileBot(requestLike) {
  if (!TURNSTILE_ENABLED || !TURNSTILE_BOT_BYPASS) {
    return false;
  }
  const userAgent = String(requestLike.headers?.['user-agent'] || '').toLowerCase();
  if (!userAgent) {
    return false;
  }
  return TURNSTILE_BOT_ALLOWLIST.some((token) => token && userAgent.includes(token));
}

function rateLimit(namespace, maxRequests, windowMs) {
  return (request, response, next) => {
    const key = `${namespace}:${clientAddress(request)}`;
    const now = Date.now();
    const existing = rateLimitBuckets.get(key);
    if (!existing || existing.resetAt <= now) {
      rateLimitBuckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count <= maxRequests) {
      next();
      return;
    }

    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    response.setHeader('Retry-After', String(retryAfter));
    response.status(429).json({ error: 'rate_limited', retryAfter });
  };
}

function turnstileCookieIsSecure(request) {
  if (request.secure) {
    return true;
  }
  return String(request.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function buildTurnstileCookieHeader(request, value, maxAgeSeconds) {
  const attributes = [
    `${TURNSTILE_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (turnstileCookieIsSecure(request)) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function setTurnstileCookie(request, response, authToken) {
  response.setHeader(
    'Set-Cookie',
    buildTurnstileCookieHeader(
      request,
      authToken,
      TURNSTILE_TOKEN_TTL_SECONDS,
    ),
  );
}

function clearTurnstileCookie(request, response) {
  response.setHeader(
    'Set-Cookie',
    buildTurnstileCookieHeader(request, '', 0),
  );
}

function cleanupExpiredTurnstileTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of [...turnstileAuthTokens.entries()]) {
    if (expiresAt <= now) {
      turnstileAuthTokens.delete(token);
    }
  }
}

function issueTurnstileAuthToken() {
  cleanupExpiredTurnstileTokens();
  const authToken = randomBytes(24).toString('base64url');
  turnstileAuthTokens.set(
    authToken,
    Date.now() + (TURNSTILE_TOKEN_TTL_SECONDS * 1000),
  );
  return authToken;
}

function extractTurnstileAuthToken(requestLike) {
  const cookies = parseCookies(requestLike.headers?.cookie || '');
  return String(cookies[TURNSTILE_COOKIE_NAME] || '').trim();
}

function hasTurnstileAccess(requestLike) {
  if (!TURNSTILE_ENABLED) {
    return true;
  }
  if (isAllowlistedTurnstileBot(requestLike)) {
    return true;
  }
  cleanupExpiredTurnstileTokens();
  const authToken = extractTurnstileAuthToken(requestLike);
  if (!authToken) {
    return false;
  }
  const expiresAt = turnstileAuthTokens.get(authToken);
  if (!expiresAt || expiresAt <= Date.now()) {
    turnstileAuthTokens.delete(authToken);
    return false;
  }
  return true;
}

async function verifyTurnstileToken(token, remoteIp = '') {
  if (!TURNSTILE_ENABLED || !TURNSTILE_SECRET_KEY) {
    return { success: false, error: 'turnstile_not_enabled' };
  }

  const body = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }

  try {
    const response = await fetch(TURNSTILE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const payload = await response.json();
    if (payload?.success) {
      return { success: true, error: '' };
    }
    return {
      success: false,
      error: Array.isArray(payload?.['error-codes'])
        ? payload['error-codes'].join(', ')
        : 'verification_failed',
    };
  } catch (error) {
    return { success: false, error: error.message || 'verification_error' };
  }
}

// Brokers disagree on telemetry field casing: LetsMesh publishes lowercase
// `rssi`/`snr`, GoMesh publishes uppercase `RSSI`/`SNR` as strings. Match on a
// case-insensitive key so both work, and reject blank strings (Number('') is 0,
// which would otherwise be recorded as a real 0 dBm reading).
function envelopeNumber(envelope, ...names) {
  if (!envelope || typeof envelope !== 'object') {
    return null;
  }
  const lookup = new Map(
    Object.keys(envelope).map((key) => [key.toLowerCase(), envelope[key]]),
  );
  for (const name of names) {
    const value = lookup.get(String(name).toLowerCase());
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function parseEnvelope(payloadBuffer) {
  const text = payloadBuffer.toString('utf8').trim();
  if (!text) {
    return { raw: '', envelope: null };
  }
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    return { raw: text, envelope: null };
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const envelope = JSON.parse(text);
      const raw = typeof envelope.raw === 'string'
        ? envelope.raw
        : typeof envelope.packet === 'string'
          ? envelope.packet
          : typeof envelope.hex === 'string'
            ? envelope.hex
            : '';
      return { raw, envelope };
    } catch {
      return { raw: '', envelope: null };
    }
  }
  return { raw: '', envelope: null };
}

function parseJsonObject(payloadBuffer) {
  const text = payloadBuffer.toString('utf8').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractDeviceName(obj, topic = '') {
  if (!obj || typeof obj !== 'object') {
    return '';
  }

  for (const key of [
    'display_name',
    'displayName',
    'node_name',
    'nodeName',
    'device_name',
    'deviceName',
    'callsign',
    'label',
    'name',
  ]) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (String(topic || '').endsWith('/status')) {
    const origin = obj.origin;
    if (typeof origin === 'string' && origin.trim()) {
      return origin.trim();
    }
  }

  return '';
}

function parsePacketHex(rawHex) {
  const normalized = normalizeHex(rawHex);
  if (!normalized || normalized.length < 4) {
    return null;
  }
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes.length < 2) {
    return null;
  }

  let offset = 0;
  const header = bytes[offset];
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0F;
  offset += 1;

  if (routeType === 0 || routeType === 3) {
    if (bytes.length < offset + 4) {
      return null;
    }
    offset += 4;
  }

  if (bytes.length < offset + 1) {
    return null;
  }
  const pathInfo = decodePathLenByte(bytes[offset]);
  offset += 1;
  if (!pathInfo) {
    return null;
  }

  if (bytes.length < offset + pathInfo.byteLength) {
    return null;
  }
  const pathBytes = bytes.subarray(offset, offset + pathInfo.byteLength);
  const path = [];
  for (let index = 0; index < pathInfo.hopCount; index += 1) {
    const start = index * pathInfo.hashSize;
    const hop = normalizePathHop(
      pathBytes.subarray(start, start + pathInfo.hashSize).toString('hex'),
    );
    if (hop) {
      path.push(hop);
    }
  }
  offset += pathInfo.byteLength;

  if (bytes.length < offset) {
    return null;
  }
  return {
    routeType,
    payloadType,
    pathHashSize: pathInfo.hashSize,
    path,
    payloadBytes: bytes.subarray(offset),
  };
}

function parseGroupTextPayload(packet) {
  if (!packet || packet.payloadType !== 5) {
    return null;
  }
  const payloadBytes = packet.payloadBytes;
  if (!payloadBytes || payloadBytes.length < 4) {
    return null;
  }
  return {
    channelHash: payloadBytes.subarray(0, 1).toString('hex').toLowerCase(),
    macBytes: payloadBytes.subarray(1, 3),
    encryptedBytes: payloadBytes.subarray(3),
  };
}

function decryptAesEcbTruncated(aesKey, encryptedBytes) {
  if (!aesKey || aesKey.length !== 16 || !encryptedBytes || encryptedBytes.length === 0) {
    return null;
  }
  const paddedLength = Math.ceil(encryptedBytes.length / 16) * 16;
  const padded = Buffer.alloc(paddedLength);
  encryptedBytes.copy(padded);
  try {
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(padded), decipher.final()]);
    return decrypted.subarray(0, encryptedBytes.length);
  } catch {
    return null;
  }
}

function hasValidGroupTextMac(hmacKey, macBytes, encryptedBytes) {
  if (!hmacKey || hmacKey.length === 0 || !macBytes || macBytes.length < 2) {
    return false;
  }
  const digest = createHmac('sha256', hmacKey).update(encryptedBytes).digest();
  return macBytes[0] === digest[0] && macBytes[1] === digest[1];
}

function sanitizeDecodedText(value) {
  return String(value || '')
    .replace(/\uFFFD/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/\x00+$/g, '')
    .trim();
}

function evaluateDecodedGroupText(plaintextBytes) {
  if (!plaintextBytes || plaintextBytes.length < 6) {
    return null;
  }
  const timestamp = plaintextBytes.readUInt32LE(0);
  const year = new Date(timestamp * 1000).getUTCFullYear();
  if (year < 2023 || year > 2035) {
    return null;
  }
  const messageBytes = plaintextBytes.subarray(5);
  if (messageBytes.length === 0) {
    return null;
  }
  let printableCount = 0;
  for (const value of messageBytes.values()) {
    if ((value >= 32 && value <= 126) || value === 9 || value === 10 || value === 13) {
      printableCount += 1;
    }
  }
  const printableRatio = printableCount / messageBytes.length;
  if (printableRatio < 0.7) {
    return null;
  }

  const decoded = sanitizeDecodedText(messageBytes.toString('utf8'));
  if (!decoded) {
    return null;
  }

  const splitIndex = decoded.indexOf(': ');
  let sender = '';
  let message = decoded;
  if (splitIndex > 0 && splitIndex < 50) {
    const maybeSender = decoded.slice(0, splitIndex).trim();
    if (maybeSender && !/[:\[\]]/.test(maybeSender)) {
      sender = maybeSender;
      message = decoded.slice(splitIndex + 2).trim();
    }
  }

  if (!message) {
    return null;
  }

  return {
    timestamp,
    sender,
    message,
    score: printableRatio + (decoded.includes(': ') ? 0.35 : 0),
  };
}

function tryDecodeGroupText(groupPayload) {
  if (!groupPayload || decoderKeyCandidates.length === 0) {
    return null;
  }
  if (!shouldDecodeChannel(testChannelHash, groupPayload.channelHash)) {
    return null;
  }
  let bestWeakMatch = null;

  for (const candidate of decoderKeyCandidates) {
    const plaintext = decryptAesEcbTruncated(candidate.aesKey, groupPayload.encryptedBytes);
    if (!plaintext) {
      continue;
    }
    const decoded = evaluateDecodedGroupText(plaintext);
    if (!decoded) {
      continue;
    }
    const macValid = hasValidGroupTextMac(
      candidate.hmacKey,
      groupPayload.macBytes,
      groupPayload.encryptedBytes,
    );
    const result = {
      channelHash: groupPayload.channelHash,
      sender: decoded.sender,
      message: decoded.message,
      timestamp: decoded.timestamp,
      macValid,
      score: decoded.score,
    };
    if (macValid) {
      return result;
    }
    if (!bestWeakMatch || result.score > bestWeakMatch.score) {
      bestWeakMatch = result;
    }
  }
  return bestWeakMatch;
}

function decodeMeshPacket(rawHex) {
  const normalized = normalizeHex(rawHex);
  if (!normalized) {
    return null;
  }
  try {
    return MeshCorePacketDecoder.decode(
      normalized,
      meshPacketDecoderKeyStore ? { keyStore: meshPacketDecoderKeyStore } : undefined,
    );
  } catch (error) {
    logger.debug(`[mqtt] packet decoder exception: ${error.message || error}`);
    return null;
  }
}

function createCode() {
  const existingCodes = new Set(
    [...sessions.values()]
      .filter((session) => isRetainedSession(session))
      .map((session) => session.code),
  );
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `MHC-${randomBytes(3).toString('hex').toUpperCase()}`;
    if (!existingCodes.has(candidate)) {
      return candidate;
    }
  }
  return `MHC-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

function activeObserverKeys(now = Date.now()) {
  const keys = [];
  for (const observer of observerState.values()) {
    if (now - observer.lastPacketAt > OBSERVER_ACTIVE_WINDOW_MS) {
      continue;
    }
    if (!observerIsScoringEligible(observer.key)) {
      continue;
    }
    keys.push(observer.key);
  }
  return dedupe(keys.sort());
}

// Region coverage is deliberately stricter than scoring eligibility: only a
// coordinate-derived group counts. A group inferred from an uplink code is a
// plausible guess, not a position, and letting it tally would inflate reach
// with data the map itself refuses to plot.
function coordinateRegionGroupForKey(observerKey) {
  const observer = observerState.get(normalizeKey(observerKey));
  if (!observer || observer.regionSource !== 'coordinates') {
    return null;
  }
  return observer.regionGroup || null;
}

// Denominator = groups that had at least one located observer in the scoring
// set. Numerator = groups where at least one of them actually reported. A group
// with no located observer is invisible to the metric rather than counted as a
// miss: we have no way to hear from it.
function regionCoverageFor(scoringKeys, seenKeys) {
  const seenSet = new Set(seenKeys.map(normalizeKey));
  const groups = new Map();
  for (const key of scoringKeys) {
    const group = coordinateRegionGroupForKey(key);
    if (!group) {
      continue;
    }
    if (!groups.has(group)) {
      groups.set(group, { group, observerCount: 0, seenCount: 0 });
    }
    const entry = groups.get(group);
    entry.observerCount += 1;
    if (seenSet.has(normalizeKey(key))) {
      entry.seenCount += 1;
    }
  }
  const list = [...groups.values()].sort((left, right) => left.group.localeCompare(right.group));
  return {
    reached: list.filter((entry) => entry.seenCount > 0).length,
    total: list.length,
    groups: list,
  };
}

function observerDisplayLabelForKey(observerKey) {
  const observer = observerState.get(observerKey);
  const profile = observerProfiles.get(observerKey);
  return String(observer?.name || profile?.name || shortKey(observerKey));
}

function topObserverKeys(now = Date.now()) {
  const dayKeys = new Set(recentUtcDayKeys(OBSERVER_TOP_WINDOW_DAYS, now));
  const ranked = [];

  for (const [key, entry] of observerActivityHistory.entries()) {
    const lastPacketAt = Math.max(0, Number(entry?.lastPacketAt || 0));
    if (OBSERVER_RETENTION_MS > 0 && (!lastPacketAt || now - lastPacketAt > OBSERVER_RETENTION_MS)) {
      continue;
    }
    let total = 0;
    for (const dayKey of dayKeys) {
      total += Math.max(0, Math.floor(Number(entry?.days?.[dayKey] || 0)));
    }
    if (total <= 0) {
      continue;
    }
    // Out-of-area observers are excluded outright. An unlocated observer is
    // not: it can still report, so it can still be scored.
    if (!observerIsScoringEligible(key)) {
      continue;
    }
    ranked.push({
      key,
      total,
      lastPacketAt,
      label: observerDisplayLabelForKey(key),
    });
  }

  ranked.sort((left, right) => {
    if (left.total !== right.total) {
      return right.total - left.total;
    }
    if (left.lastPacketAt !== right.lastPacketAt) {
      return right.lastPacketAt - left.lastPacketAt;
    }
    const byLabel = left.label.localeCompare(right.label);
    if (byLabel !== 0) {
      return byLabel;
    }
    return left.key.localeCompare(right.key);
  });

  return ranked.slice(0, OBSERVER_TOP_COUNT).map((entry) => entry.key);
}

function defaultObserverTarget(now = Date.now()) {
  if (KNOWN_OBSERVERS.length > 0) {
    return {
      keys: [...KNOWN_OBSERVERS],
      source: 'configured',
    };
  }
  if (OBSERVER_TARGET_MODE === 'active') {
    const activeKeys = activeObserverKeys(now);
    if (activeKeys.length > 0) {
      return {
        keys: activeKeys,
        source: 'active-window',
      };
    }
  }
  const topKeys = topObserverKeys(now);
  if (topKeys.length > 0) {
    return {
      keys: topKeys,
      source: 'top-window',
    };
  }
  return {
    keys: activeObserverKeys(now),
    source: 'active-window',
  };
}

// A session that has not yet matched a message has nothing to score, so 0% is
// not a result - it is the absence of one. Callers pass measured=false for that
// state and render a placeholder instead of a failing grade.
function healthLabel(percent, measured = true, rated = true) {
  if (!measured) {
    return 'WAITING';
  }
  // Heard, but the target set is too small for the percentage to mean anything.
  if (!rated) {
    return 'NOT RATED';
  }
  if (percent >= 85) {
    return 'VERY HEALTHY';
  }
  if (percent >= 60) {
    return 'GOOD';
  }
  if (percent >= 35) {
    return 'FAIR';
  }
  return 'POOR';
}

function serializeObserver(observer) {
  return {
    key: observer.key,
    // Recomputed rather than read from observer.hash so a width learned after
    // the record was created takes effect without a restart.
    hash: hashFromKeyPrefix(observer.key, observerHashBytes(observer.key)),
    hashBytes: observerHashBytes(observer.key),
    hashBytesConfirmed: observerHashBytesConfirmed(observer.key),
    label: observer.name || shortKey(observer.key),
    name: observer.name || null,
    lat: observer.lat ?? null,
    lon: observer.lon ?? null,
    hasLocation: observer.lat != null && observer.lon != null,
    // null when never learned; also null on legacy profiles persisted before
    // this field existed, even though those do have a location.
    locationUpdatedAt: observer.lat != null && observer.lon != null ? (observer.locationUpdatedAt ?? null) : null,
    region: observer.region ?? null,
    regionGroup: observer.regionGroup ?? null,
    regionSource: observer.regionSource ?? null,
    regionInferred: observerRegionIsInferred(observer),
    uplinkCode: observer.uplinkCode ?? null,
    uplinkLabel: uplinkCodes.get(normalizeUplinkCode(observer.uplinkCode))?.label ?? null,
    shortKey: shortKey(observer.key),
    packetCount: observer.packetCount,
    firstSeenAt: observer.firstSeenAt,
    lastPacketAt: observer.lastPacketAt,
    isRetained: observerIsRetained(observer),
    isActive: Date.now() - observer.lastPacketAt <= OBSERVER_ACTIVE_WINDOW_MS,
  };
}

function observerIsRetained(observer, now = Date.now()) {
  if (!observer?.lastPacketAt) {
    return false;
  }
  if (OBSERVER_RETENTION_MS <= 0) {
    return true;
  }
  return now - observer.lastPacketAt <= OBSERVER_RETENTION_MS;
}

function serializeObserverForKey(observerKey) {
  const observer = ensureObserverRecord(observerKey);
  if (!observer) {
    return {
      key: observerKey,
      hash: hashFromKeyPrefix(observerKey, observerHashBytes(observerKey)),
      hashBytes: observerHashBytes(observerKey),
      hashBytesConfirmed: observerHashBytesConfirmed(observerKey),
      label: shortKey(observerKey),
      name: null,
      lat: null,
      lon: null,
      hasLocation: false,
      locationUpdatedAt: null,
      region: null,
      regionGroup: null,
      regionSource: null,
      regionInferred: false,
      uplinkCode: null,
      uplinkLabel: null,
      shortKey: shortKey(observerKey),
      packetCount: 0,
      firstSeenAt: 0,
      lastPacketAt: 0,
      isRetained: false,
      isActive: false,
    };
  }
  return serializeObserver(observer);
}

function observerDirectory() {
  const now = Date.now();
  const defaultKeys = new Set(defaultObserverTarget().keys);
  return [...observerState.values()]
    .filter((observer) => observerIsRetained(observer, now))
    // An out-of-area uplink code excludes the observer outright - no directory
    // entry, no counts, no selection, no map. This is unconditional whenever a
    // code table is loaded.
    .filter((observer) => !observerIsOutOfArea(observer))
    .sort((left, right) => {
      const leftDefault = defaultKeys.has(left.key) ? 1 : 0;
      const rightDefault = defaultKeys.has(right.key) ? 1 : 0;
      if (leftDefault !== rightDefault) {
        return rightDefault - leftDefault;
      }
      const leftLabel = String(left.name || shortKey(left.key));
      const rightLabel = String(right.name || shortKey(right.key));
      const byLabel = leftLabel.localeCompare(rightLabel);
      if (byLabel !== 0) {
        return byLabel;
      }
      return left.key.localeCompare(right.key);
    })
    .map(serializeObserver);
}

function buildRegionHierarchy(directory) {
  const groups = new Map();
  const ungrouped = new Map();
  // Observers whose group came from the uplink code carry no county, so they can
  // only be counted at group level. They are tallied separately and reported as
  // inferredCount so the UI can show them without implying a polygon match.
  const inferred = new Map();

  for (const observer of directory) {
    if (!observer.region) {
      if (observer.regionInferred && observer.regionGroup) {
        inferred.set(observer.regionGroup, (inferred.get(observer.regionGroup) || 0) + 1);
      }
      continue;
    }
    const count = Number.isInteger(observer.packetCount) ? observer.packetCount : 0;
    if (observer.regionGroup) {
      if (!groups.has(observer.regionGroup)) {
        groups.set(observer.regionGroup, {
          group: observer.regionGroup,
          count: 0,
          regions: new Map(),
        });
      }
      const group = groups.get(observer.regionGroup);
      group.count += 1;
      const region = group.regions.get(observer.region) || {
        name: observer.region,
        count: 0,
        packetCount: 0,
      };
      region.count += 1;
      region.packetCount += count;
      group.regions.set(observer.region, region);
    } else {
      const region = ungrouped.get(observer.region) || {
        name: observer.region,
        count: 0,
        packetCount: 0,
      };
      region.count += 1;
      region.packetCount += count;
      ungrouped.set(observer.region, region);
    }
  }

  const byName = (left, right) => String(left.name || left.group).localeCompare(String(right.name || right.group));
  const out = [...groups.values()]
    .map((group) => ({
      group: group.group,
      count: group.count,
      inferredCount: inferred.get(group.group) || 0,
      regions: [...group.regions.values()].sort(byName),
    }))
    .sort(byName);

  // A group can exist purely from inferred members - e.g. every observer that
  // uplinks through SQL is coordinate-less. Emit it so the chip still appears.
  for (const [groupName, count] of inferred.entries()) {
    if (!groups.has(groupName)) {
      out.push({
        group: groupName,
        count: 0,
        inferredCount: count,
        regions: [],
      });
    }
  }
  out.sort(byName);

  if (ungrouped.size > 0) {
    out.push({
      group: '',
      count: [...ungrouped.values()].reduce((sum, region) => sum + region.count, 0),
      inferredCount: 0,
      regions: [...ungrouped.values()].sort(byName),
    });
  }

  return out;
}

function sharePathForSession(session) {
  return `/share/${encodeURIComponent(session.id)}`;
}

function shareUrlForSession(session, request = null) {
  const sharePath = sharePathForSession(session);
  if (!request) {
    return sharePath;
  }
  return `${requestOrigin(request)}${sharePath}`;
}

function observerDisplayLabel(observer, fallbackKey = '') {
  return observer?.name || (fallbackKey ? shortKey(fallbackKey) : '');
}

function observerForPathHop(hop, terminalObserverKey = '') {
  const normalizedHop = normalizePathHop(hop);
  if (!normalizedHop) {
    return null;
  }
  const terminalKey = normalizeKey(terminalObserverKey);
  if (terminalKey && terminalKey.startsWith(normalizedHop)) {
    return observerState.get(terminalKey) || null;
  }
  const matches = [...observerState.values()]
    .filter((observer) => observer?.key?.startsWith(normalizedHop));
  return matches.length === 1 ? matches[0] : null;
}

function distanceKmBetween(left, right) {
  if (
    left?.lat == null || left?.lon == null ||
    right?.lat == null || right?.lon == null
  ) {
    return null;
  }
  const earthRadiusKm = 6371.0088;
  const toRadians = (value) => (Number(value) * Math.PI) / 180;
  const leftLat = toRadians(left.lat);
  const rightLat = toRadians(right.lat);
  const latDelta = toRadians(Number(right.lat) - Number(left.lat));
  const lonDelta = toRadians(Number(right.lon) - Number(left.lon));
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(lonDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function convertDistance(km) {
  if (!Number.isFinite(km)) {
    return null;
  }
  return DISTANCE_UNIT === 'km' ? km : km * 0.621371;
}

function formatDistance(value) {
  if (!Number.isFinite(value)) {
    return '';
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded.toLocaleString('en-US')} ${DISTANCE_UNIT}`;
}

// One entry per hop in the packet's recorded path, resolved to a name where the
// hash unambiguously identifies a known node. Serialized so every view - card,
// drawer, share page - names the same repeaters instead of each one re-deriving
// them from bare hashes, or showing the hash alone.
function receiptPathHops(report) {
  const path = Array.isArray(report?.path)
    ? report.path.map(normalizePathHop).filter(Boolean)
    : [];
  const terminalKey = normalizeKey(report?.observerKey);
  return path.map((hop, index) => {
    const observer = observerForPathHop(hop, report?.observerKey);
    const isTerminal = index === path.length - 1 && Boolean(terminalKey) && terminalKey.startsWith(hop);
    return {
      hash: hop,
      // Falls back to the hash itself, so an unresolved hop still reads as the
      // only thing actually known about it rather than as a blank chip.
      label: observerDisplayLabel(observer, observer?.key || '') || hop,
      // Full public key of the node this prefix resolved to, so the client can
      // link the hop out to CoreScope. Empty when the prefix matched nothing or
      // matched several nodes -- observerForPathHop refuses to guess, and a
      // guessed key would link to the wrong node's page.
      key: observer?.key || '',
      resolved: Boolean(observer),
      hasLocation: observer?.lat != null && observer?.lon != null,
      isTerminal,
    };
  });
}

function receiptDistanceEstimate(report) {
  const path = Array.isArray(report?.path)
    ? report.path.map(normalizePathHop).filter(Boolean)
    : [];
  const resolved = path
    .map((hop, index) => ({
      hop,
      index,
      observer: observerForPathHop(hop, report.observerKey),
      hasLocation: false,
    }))
    .map((entry) => ({
      ...entry,
      hasLocation: entry.observer?.lat != null && entry.observer?.lon != null,
    }));
  const located = resolved.filter((entry) => entry.hasLocation);
  const segments = [];
  for (let index = 1; index < located.length; index += 1) {
    const from = located[index - 1];
    const to = located[index];
    if (from.observer.key === to.observer.key) {
      continue;
    }
    const km = distanceKmBetween(from.observer, to.observer);
    const distance = convertDistance(km);
    if (!Number.isFinite(distance)) {
      continue;
    }
    // The hops this leg jumps over, carried as identities rather than only a
    // count. Three different situations land here and only the first has a
    // name: the prefix matched exactly one observer that has no coordinates;
    // the prefix matched nothing; or the prefix matched several observers, in
    // which case observerForPathHop refuses to guess. The hash is the one fact
    // known in all three, so it is always carried and the label may be empty.
    const skippedHops = resolved
      .slice(from.index + 1, to.index)
      .map((entry) => ({
        hash: entry.hop,
        label: entry.observer ? observerDisplayLabel(entry.observer, entry.observer.key) : '',
        key: entry.observer?.key || '',
      }));
    segments.push({
      fromHash: from.hop,
      toHash: to.hop,
      fromLabel: observerDisplayLabel(from.observer, from.observer.key),
      toLabel: observerDisplayLabel(to.observer, to.observer.key),
      // Both endpoints are located, so both are resolved by definition and
      // always carry a key. Carried so each leg endpoint can link to its node.
      fromKey: from.observer.key,
      toKey: to.observer.key,
      skippedHops,
      skippedHopCount: Math.max(0, to.index - from.index - 1),
      estimated: to.index - from.index > 1,
      distance,
      distanceText: formatDistance(distance),
    });
  }
  const distance = segments.reduce((sum, segment) => sum + segment.distance, 0);
  // Straight-line span between the two ends of the measured chain. Deliberately
  // NOT derived from the legs: a path that doubles back sums to far more than it
  // spans, and that difference is the interesting part.
  const first = located[0];
  const last = located[located.length - 1];
  // How many hops the mileage actually spans, which is not the leg count when
  // hops in between have no position. Measured first-located to last-located on
  // purpose: unresolved hops trailing past the last located one are covered by
  // no leg and contribute no distance, so counting them would overstate it.
  const spannedHopCount = segments.length > 0 && first && last
    ? last.index - first.index
    : 0;
  let crowFlies = null;
  if (segments.length > 0 && first && last && first.observer.key !== last.observer.key) {
    const crowValue = convertDistance(distanceKmBetween(first.observer, last.observer));
    if (Number.isFinite(crowValue)) {
      crowFlies = {
        distance: crowValue,
        distanceText: formatDistance(crowValue),
        fromHash: first.hop,
        toHash: last.hop,
        fromLabel: observerDisplayLabel(first.observer, first.observer.key),
        toLabel: observerDisplayLabel(last.observer, last.observer.key),
      };
    }
  }
  return {
    distance: segments.length > 0 ? distance : null,
    distanceText: segments.length > 0 ? formatDistance(distance) : '',
    segments,
    crowFlies,
    spannedHopCount,
    locatedHopCount: located.length,
    estimatedSegmentCount: segments.filter((segment) => segment.estimated).length,
  };
}

function observerSpanDistanceEstimate(reports) {
  const locatedReceipts = reports
    .map((report) => {
      const observer = observerState.get(report.observerKey);
      return observer?.lat != null && observer?.lon != null
        ? { report, observer }
        : null;
    })
    .filter(Boolean);
  let best = null;
  for (let leftIndex = 0; leftIndex < locatedReceipts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < locatedReceipts.length; rightIndex += 1) {
      const left = locatedReceipts[leftIndex];
      const right = locatedReceipts[rightIndex];
      const distance = convertDistance(distanceKmBetween(left.observer, right.observer));
      if (!Number.isFinite(distance) || distance <= 0) {
        continue;
      }
      if (!best || distance > best.distance) {
        best = {
          distance,
          distanceText: formatDistance(distance),
          fromLabel: observerDisplayLabel(left.observer, left.report.observerKey),
          toLabel: observerDisplayLabel(right.observer, right.report.observerKey),
        };
      }
    }
  }
  return best;
}

function serializeSession(session, request = null) {
  const allReports = [...session.receipts.values()]
    .sort((left, right) => left.firstSeenAt - right.firstSeenAt)
    .map((report) => {
      const observer = observerState.get(report.observerKey);
      const distanceEstimate = receiptDistanceEstimate(report);
      return {
        observerKey: report.observerKey,
        // Recomputed at serialize time, like serializeObserver, so a receipt
        // shows the observer's own confirmed path hash width. report.observerHash
        // is whatever width was current when the packet arrived, and persisted
        // sessions can carry a narrower value from before the width was learned.
        observerHash:
          hashFromKeyPrefix(report.observerKey, observerHashBytes(report.observerKey))
          || report.observerHash,
        observerHashBytes: observerHashBytes(report.observerKey),
        observerHashBytesConfirmed: observerHashBytesConfirmed(report.observerKey),
        observerLabel: observer?.name || report.observerLabel,
        observerName: observer?.name || report.observerName,
        observerShortKey: shortKey(report.observerKey),
        firstSeenAt: report.firstSeenAt,
        lastSeenAt: report.lastSeenAt,
        count: report.count,
        topic: report.topic,
        messageHash: report.messageHash,
        packetType: report.packetType,
        channelName: report.channelName,
        rssi: report.rssi,
        snr: report.snr,
        duration: report.duration,
        path: report.path,
        pathHops: receiptPathHops(report),
        pathDistance: distanceEstimate.distance,
        pathDistanceText: distanceEstimate.distanceText,
        pathDistanceSegments: distanceEstimate.segments,
        pathCrowFlies: distanceEstimate.crowFlies,
        pathSpannedHopCount: distanceEstimate.spannedHopCount,
        pathLocatedHopCount: distanceEstimate.locatedHopCount,
      };
    });

  const expected = dedupe((session.expectedObserverKeys || []).map(normalizeKey));
  const reports = session.allowlistEnabled && expected.length > 0
    ? allReports.filter((report) => expected.includes(normalizeKey(report.observerKey)))
    : allReports;
  for (const report of reports) {
    if (report.pathDistance != null && Number.isFinite(Number(report.pathDistance))) {
      report.displayDistance = report.pathDistance;
      report.displayDistanceText = report.pathDistanceText;
      report.displayDistanceSource = 'path';
      continue;
    }
    // No observer-span fallback. It reported the distance to the farthest OTHER
    // observer that also heard the packet, which is a property of the observer
    // set, not of this receipt's path - so it read as this packet's travel
    // distance while naming the same outlier node on nearly every card. When the
    // path cannot be measured, say which hops are missing position instead of
    // substituting an unrelated number.
    report.displayDistance = null;
    report.displayDistanceText = '';
    report.displayDistanceSource = '';
    report.displayDistanceLabel = '';
    const hops = receiptPathHops(report);
    const unlocated = hops.filter((hop) => !hop.hasLocation).length;
    if (hops.length === 0) {
      report.pathDistanceNote = 'No path recorded, so distance cannot be estimated.';
    } else if (hops.length === 1) {
      // A one-element path is the receiving observer itself: the packet arrived
      // with no repeater hop, and the sender's position is not carried in the
      // path, so there is no leg to measure even though the hop is located.
      report.pathDistanceNote = 'Heard with no repeater hop, so there is no leg to measure.';
    } else {
      report.pathDistanceNote = `Distance not estimated: ${unlocated} of ${hops.length} hops `
        + `${unlocated === 1 ? 'has' : 'have'} no known position.`;
    }
  }
  const seen = dedupe(reports.map((report) => normalizeKey(report.observerKey)));
  const repeaters = dedupe(
    reports.flatMap((report) =>
      Array.isArray(report.path)
        ? report.path
          .slice(0, Math.max(0, report.path.length - 1))
          .map(normalizePathHop)
          .filter(Boolean)
        : []
    ),
  );
  // Scoring set. An explicit allowlist is the user's own choice of denominator
  // and is used verbatim. Otherwise the denominator is the set of scoring-
  // eligible observers that were active when the session was created, unioned
  // with anyone who actually reported. The union matters twice over: an observer
  // that woke up mid-session can never push the score above 100%, and dropping
  // the old Math.max(..., seen.length) removes the bug where any well-heard
  // message landed on exactly 100% because seen became its own denominator.
  // activeObserverKeys is absent on sessions retained from an older build, so
  // those fall back to the former top-N roster.
  const activeAtStart = dedupe((session.activeObserverKeys || []).map(normalizeKey));
  const scoringBaseline = OBSERVER_TARGET_MODE === 'active' && activeAtStart.length > 0
    ? activeAtStart
    : expected;
  const scoringKeys = session.allowlistEnabled && expected.length > 0
    ? expected
    : dedupe([...scoringBaseline, ...seen]);
  const denominator = Math.max(1, scoringKeys.length);
  const percent = Math.round((seen.length / denominator) * 100);
  const regionCoverage = regionCoverageFor(scoringKeys, seen);
  // Nothing has been heard and no message has matched yet: the score is not zero,
  // it is undefined. matchedAt means the test message did land, so a genuine 0%
  // after that is a real (bad) result and stays scored.
  const healthMeasured = seen.length > 0 || Boolean(session.matchedAt);
  // A hand-picked or single-observer target is a reachability check, not a health
  // measurement. Report what was heard, withhold the grade, and say why.
  const scoringSetTooSmall = scoringKeys.length < OBSERVER_MIN_SCORING_SET;
  const healthRated = healthMeasured && !scoringSetTooSmall;
  const healthUnratedReason = healthMeasured && scoringSetTooSmall
    ? 'target-too-small'
    : null;
  const longestPacketDistance = reports
    .map((report) => Number(report.pathDistance))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  const observerSpanDistance = longestPacketDistance > 0
    ? null
    : observerSpanDistanceEstimate(reports);
  const bestDistance = longestPacketDistance > 0
    ? longestPacketDistance
    : Number(observerSpanDistance?.distance || 0);

  return {
    id: session.id,
    code: session.code,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    resultExpiresAt: sessionRetentionDeadline(session),
    status: session.status,
    instructions: `Send the code ${session.code} to the ${testChannelLabel} channel.`,
    useCount: session.useCount,
    maxUses: session.maxUses,
    usesRemaining: Math.max(0, session.maxUses - session.useCount),
    allowlistEnabled: Boolean(session.allowlistEnabled),
    messageHash: session.messageHash,
    matchedAt: session.matchedAt,
    sender: session.sender,
    messageBody: session.messageBody,
    channelHash: session.channelHash,
    channelName: session.channelName,
    observedCount: seen.length,
    repeaterCount: repeaters.length,
    distanceUnit: DISTANCE_UNIT,
    longestPacketDistance: bestDistance > 0 ? bestDistance : null,
    longestPacketDistanceText: bestDistance > 0 ? formatDistance(bestDistance) : '',
    longestPacketDistanceSource: longestPacketDistance > 0
      ? 'path'
      : (observerSpanDistance ? 'observer-span' : ''),
    longestPacketDistancePair: observerSpanDistance
      ? {
          fromLabel: observerSpanDistance.fromLabel,
          toLabel: observerSpanDistance.toLabel,
        }
      : null,
    expectedCount: denominator,
    regionCoverage,
    healthPercent: percent,
    healthMeasured: healthMeasured,
    healthRated,
    healthUnratedReason,
    minScoringSet: OBSERVER_MIN_SCORING_SET,
    healthLabel: healthLabel(percent, healthMeasured, healthRated),
    expectedObserverSource: session.expectedObserverSource,
    sharePath: sharePathForSession(session),
    shareUrl: shareUrlForSession(session, request),
    expectedObservers: scoringKeys.map((key) => {
      const observer = observerState.get(key);
      return {
        key,
        hash: hashFromKeyPrefix(key, observerHashBytes(key)),
        hashBytes: observerHashBytes(key),
        hashBytesConfirmed: observerHashBytesConfirmed(key),
        label: observer?.name || shortKey(key),
        seen: seen.includes(key),
      };
    }),
    receipts: reports,
  };
}

function snapshotPayload() {
  const directory = observerDirectory();
  const activeObservers = directory.filter((observer) => observer.isActive);
  const defaultTarget = defaultObserverTarget();
  const defaultObservers = defaultTarget.keys.map((key) => serializeObserverForKey(key));
  const dashboardBrokerHost = DASH_BROKER_HOST || brokerLabel(MQTT_URL);
  const regionHierarchy = buildRegionHierarchy(directory);

  const mapTiles = mapTileConfig();

  return {
    serverTime: Date.now(),
    // Upstream v1.3.8 publishes basemap configuration at the top level; this
    // fork had already put the same object under site.map, which the client
    // reads. Both are published so upstream's shape stays available and future
    // merges do not have to move the field.
    map: mapTiles,
    site: {
      title: APP_TITLE,
      version: APP_VERSION,
      eyebrow: APP_EYEBROW,
      headline: APP_HEADLINE,
      description: APP_DESCRIPTION,
      repoUrl: REPO_URL,
      changesUrl: `${REPO_URL}/blob/main/CHANGES.md`,
      coreScopeUrl: CORESCOPE_URL,
      externalLinkUrl: EXTERNAL_LINK_URL,
      externalLinkLabel: EXTERNAL_LINK_LABEL,
      map: mapTiles,
    },
    mqtt: {
      connected: mqttConnected,
      broker: dashboardBrokerHost,
      topics: MQTT_TOPICS,
    },
    turnstile: {
      enabled: TURNSTILE_ENABLED,
      siteKey: TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : '',
    },
    observerStats: {
      configuredCount: KNOWN_OBSERVERS.length,
      retentionSeconds: Math.round(OBSERVER_RETENTION_MS / 1000),
      activeCount: activeObservers.length,
      windowSeconds: Math.round(OBSERVER_ACTIVE_WINDOW_MS / 1000),
      topWindowDays: OBSERVER_TOP_WINDOW_DAYS,
      topCount: OBSERVER_TOP_COUNT,
      targetMode: OBSERVER_TARGET_MODE,
      hashDisplayBytes: OBSERVER_HASH_DISPLAY_BYTES,
      distanceUnit: DISTANCE_UNIT,
      regionFallback: REGION_FALLBACK_UPLINK ? 'uplink-code' : null,
      uplinkCodesLoaded: UPLINK_CODES_LOADED,
      inferredRegionCount: directory.filter((observer) => observer.regionInferred).length,
      outOfAreaCount: [...observerState.values()]
        .filter((observer) => observerIsRetained(observer) && observerIsOutOfArea(observer)).length,
    },
    results: {
      retentionSeconds: Math.round(RESULT_RETENTION_MS / 1000),
    },
    defaultObserverKeys: defaultTarget.keys,
    defaultObservers,
    defaultObserverSource: defaultTarget.source,
    observerDirectory: directory,
    activeObservers,
    regionHierarchy,
    availableRegions: [...new Set(directory.map((o) => o.region).filter(Boolean))].sort(),
    availableRegionGroups: regionHierarchy.map((entry) => entry.group).filter(Boolean),
    testChannel: {
      name: testChannelName,
      hash: testChannelHash || null,
      configured: Boolean(testChannelHash),
      inviteUri: testChannelInviteUri,
      qrAvailable: Boolean(testChannelQrSvg),
    },
  };
}

function serializeBootstrap(request) {
  return {
    ...snapshotPayload(),
    turnstile: {
      enabled: TURNSTILE_ENABLED,
      siteKey: TURNSTILE_ENABLED ? TURNSTILE_SITE_KEY : '',
      verified: hasTurnstileAccess(request),
    },
  };
}

function touchObserver(observerKey) {
  const observer = ensureObserverRecord(observerKey);
  if (!observer) {
    return null;
  }
  const now = Date.now();
  if (!observer.firstSeenAt) {
    observer.firstSeenAt = now;
  }
  observer.lastPacketAt = now;
  observer.packetCount += 1;
  return observer;
}

function noteObserverPacketActivity(observerKey, timestamp = Date.now()) {
  const normalizedKey = normalizeKey(observerKey);
  const normalizedTimestamp = Number(timestamp);
  if (!normalizedKey || !Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) {
    return false;
  }
  const dayKey = utcDayKey(normalizedTimestamp);
  const entry = observerActivityHistory.get(normalizedKey) || {
    days: {},
    lastPacketAt: 0,
  };
  const nextCount = Math.max(0, Math.floor(Number(entry.days?.[dayKey] || 0))) + 1;
  const nextLastPacketAt = Math.max(Number(entry.lastPacketAt || 0), normalizedTimestamp);
  const changed = Number(entry.days?.[dayKey] || 0) !== nextCount
    || Number(entry.lastPacketAt || 0) !== nextLastPacketAt;
  entry.days = {
    ...(entry.days || {}),
    [dayKey]: nextCount,
  };
  entry.lastPacketAt = nextLastPacketAt;
  observerActivityHistory.set(normalizedKey, entry);
  if (changed) {
    scheduleObserverActivityWrite();
  }
  return changed;
}

function updateObserverName(observerKey, name, options = {}) {
  const normalizedKey = normalizeKey(observerKey);
  const cleanName = String(name || '').trim();
  if (!normalizedKey || !cleanName) {
    return false;
  }
  const profile = observerProfiles.get(normalizedKey) || { name: '', lat: null, lon: null };
  const previous = String(profile.name || '').trim();
  const observer = ensureObserverRecord(normalizedKey);
  if (!observer) {
    return false;
  }
  if (
    pinnedObserverNameKeys.has(normalizedKey) &&
    previous &&
    previous !== cleanName &&
    !options.allowPinnedOverride
  ) {
    observer.name = previous;
    return false;
  }
  const changed = previous !== cleanName || observer.name !== cleanName;
  observerProfiles.set(normalizedKey, { ...profile, name: cleanName });
  observer.name = cleanName;
  if (changed) {
    logger.debug(`[observer] name ${normalizedKey} -> ${cleanName}`);
    scheduleObserverNamesWrite();
  }
  return changed;
}

function updateObserverLocation(observerKey, location) {
  const normalizedKey = normalizeKey(observerKey);
  const lat = normalizeCoordinate(location?.lat ?? null, 'lat');
  const lon = normalizeCoordinate(location?.lon ?? null, 'lon');
  if (!normalizedKey || lat == null || lon == null || (lat === 0 && lon === 0)) {
    return false;
  }
  if (REQUIRE_REGION_MATCH && regionBoundaries.length > 0 && !deriveRegionInfo(lat, lon).region) {
    logger.debug(`[observer] location ${normalizedKey} -> ${lat}, ${lon} outside configured regions, ignored`);
    return false;
  }
  const observer = ensureObserverRecord(normalizedKey);
  if (!observer) {
    return false;
  }
  const profile = observerProfiles.get(normalizedKey) || { name: '', lat: null, lon: null };
  const changed = profile.lat !== lat || profile.lon !== lon || observer.lat !== lat || observer.lon !== lon;
  const locationUpdatedAt = changed ? Date.now() : (profile.locationUpdatedAt ?? null);
  observerProfiles.set(normalizedKey, { ...profile, lat, lon, locationUpdatedAt });
  observer.lat = lat;
  observer.lon = lon;
  observer.locationUpdatedAt = locationUpdatedAt;
  const regionInfo = resolveObserverRegion(observer);
  observer.region = regionInfo.region;
  observer.regionGroup = regionInfo.regionGroup;
  observer.regionSource = regionInfo.regionSource;
  if (changed) {
    logger.debug(`[observer] location ${normalizedKey} -> ${lat}, ${lon}`);
    scheduleObserverNamesWrite();
  }
  return changed;
}

// The uplink code arrives on every topic, so this runs on a hot path: bail out
// unless the value actually changed.
function updateObserverUplinkCode(observerKey, rawCode) {
  const normalizedKey = normalizeKey(observerKey);
  const code = normalizeUplinkCode(rawCode);
  if (!normalizedKey || !code) {
    return false;
  }
  const observer = observerState.get(normalizedKey);
  if (observer && observer.uplinkCode === code) {
    return false;
  }
  const record = observer || ensureObserverRecord(normalizedKey);
  if (!record) {
    return false;
  }
  record.uplinkCode = code;
  noteUplinkCode(code);
  const regionInfo = resolveObserverRegion(record);
  record.region = regionInfo.region;
  record.regionGroup = regionInfo.regionGroup;
  record.regionSource = regionInfo.regionSource;
  const profile = observerProfiles.get(normalizedKey) || { name: '', uplink: '', lat: null, lon: null };
  if (profile.uplink !== code) {
    observerProfiles.set(normalizedKey, { ...profile, uplink: code });
    scheduleObserverNamesWrite();
  }
  logger.debug(`[observer] uplink ${normalizedKey} -> ${code}${uplinkCodeIsOutOfArea(code) ? ' (out of area)' : ''}`);
  return true;
}

function handleObserverMetadata(topic, observerKey, payloadBuffer) {
  const observer = touchObserver(observerKey);
  if (!observer) {
    return false;
  }

  const parsed = parseJsonObject(payloadBuffer);
  if (!parsed) {
    return false;
  }

  const metadataObserverKey = normalizeKey(
    parsed.origin_id || parsed.originId || parsed.publicKey || parsed.public_key || '',
  );
  if (metadataObserverKey && metadataObserverKey !== observer.key) {
    return false;
  }

  let changed = false;
  const extractedName = extractDeviceName(parsed, topic);
  if (extractedName) {
    changed = updateObserverName(observer.key, extractedName) || changed;
  }
  changed = updateObserverLocation(observer.key, extractObserverLocation(parsed)) || changed;

  return changed;
}

function matchSessionByCode(messageText) {
  const body = String(messageText || '').trim();
  if (!body) {
    return null;
  }
  const now = Date.now();
  const availableSessions = [...sessions.values()]
    .filter((session) =>
      session.status !== 'expired' &&
      now < session.expiresAt &&
      session.useCount < session.maxUses
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  for (const session of availableSessions) {
    const regex = new RegExp(`\\b${escapeRegExp(session.code)}\\b`, 'i');
    if (regex.test(body)) {
      return session;
    }
  }
  return null;
}

function expectedObserversForSession() {
  return defaultObserverTarget();
}

function explicitObserverAllowlist(requestedKeys = []) {
  const normalized = dedupe(
    (Array.isArray(requestedKeys) ? requestedKeys : [])
      .map(normalizeKey)
      .filter(Boolean),
  );
  if (normalized.length === 0) {
    return {
      keys: [],
      source: '',
      enabled: false,
    };
  }
  const validKeys = normalized.filter((key) => observerState.has(key));
  return {
    keys: validKeys,
    source: validKeys.length === 1 ? 'selected observer' : 'selected observers',
    enabled: validKeys.length > 0,
  };
}

function maybeMatchSession(packetInfo) {
  if (!packetInfo.messageHash || !packetInfo.messageBody) {
    return null;
  }
  const mappedSessionId = messageToSession.get(packetInfo.messageHash);
  if (mappedSessionId) {
    return sessions.get(mappedSessionId) || null;
  }
  const session = matchSessionByCode(packetInfo.messageBody);
  if (!session) {
    return null;
  }
  if (isSameActiveMessageAlias(session, packetInfo)) {
    linkSessionHash(session, packetInfo.messageHash);
    return session;
  }
  const isNewUse = session.messageHash !== packetInfo.messageHash;
  if (isNewUse) {
    unlinkSessionHashes(session);
    session.receipts = new Map();
    session.useCount += 1;
  }
  session.status = session.useCount >= session.maxUses ? 'exhausted' : 'active';
  session.messageHash = packetInfo.messageHash;
  session.matchedAt = packetInfo.seenAt;
  session.messageBody = packetInfo.messageBody;
  session.sender = packetInfo.sender;
  session.channelHash = packetInfo.channelHash;
  session.channelName = packetInfo.channelName;
  if (!Array.isArray(session.expectedObserverKeys) || session.expectedObserverKeys.length === 0) {
    session.expectedObserverKeys = [packetInfo.observerKey];
    session.expectedObserverSource = 'first-observer';
  }
  linkSessionHash(session, packetInfo.messageHash);
  return session;
}

function recordReceipt(session, packetInfo) {
  const existing = session.receipts.get(packetInfo.observerKey);
  const observer = observerState.get(packetInfo.observerKey);
  const label = observer?.name || shortKey(packetInfo.observerKey);
  if (existing) {
    existing.lastSeenAt = packetInfo.seenAt;
    existing.count += 1;
    existing.path = [...packetInfo.path];
    existing.topic = packetInfo.topic;
    // Keep the first real reading: an observer's own tx rebroadcast of the same
    // packet carries no SNR/RSSI and would otherwise blank out good telemetry.
    if (Number.isFinite(packetInfo.rssi)) {
      existing.rssi = packetInfo.rssi;
    }
    if (Number.isFinite(packetInfo.snr)) {
      existing.snr = packetInfo.snr;
    }
    if (Number.isFinite(packetInfo.duration)) {
      existing.duration = packetInfo.duration;
    }
    existing.channelName = packetInfo.channelName;
    return true;
  }

  session.receipts.set(packetInfo.observerKey, {
    observerKey: packetInfo.observerKey,
    observerHash: packetInfo.observerHash,
    observerLabel: label,
    observerName: observer?.name || null,
    firstSeenAt: packetInfo.seenAt,
    lastSeenAt: packetInfo.seenAt,
    count: 1,
    topic: packetInfo.topic,
    messageHash: packetInfo.messageHash,
    packetType: packetInfo.packetType,
    channelName: packetInfo.channelName,
    rssi: packetInfo.rssi,
    snr: packetInfo.snr,
    duration: packetInfo.duration,
    path: [...packetInfo.path],
  });
  return true;
}

function pruneState() {
  const now = Date.now();
  let changed = false;

  cleanupExpiredTurnstileTokens();

  for (const session of sessions.values()) {
    if (session.status !== 'expired' && now >= session.expiresAt) {
      session.status = 'expired';
      unlinkSessionHashes(session, false);
      changed = true;
    }
  }

  for (const [sessionId, session] of [...sessions.entries()]) {
    if (!isRetainedSession(session, now)) {
      sessions.delete(sessionId);
      unlinkSessionHashes(session);
      changed = true;
    }
  }

  if (changed) {
    scheduleResultsWrite();
  }

  return changed;
}

function channelDisplay(channelHash) {
  const normalized = String(channelHash || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return channelHashToInfo.get(normalized)?.name || normalized;
}

function handlePacketMessage(topic, observerKey, payloadBuffer) {
  const observer = touchObserver(observerKey);
  if (!observer) {
    return;
  }
  noteObserverPacketActivity(observer.key);

  const { raw, envelope } = parseEnvelope(payloadBuffer);
  if (!raw) {
    return;
  }

  const packet = decodeMeshPacket(raw);
  if (!packet?.isValid) {
    if (packet?.errors?.length) {
      logger.debug(
        `[mqtt] packet parse failed on ${shortKey(observer.key)}: ${packet.errors.join('; ')}`,
      );
    }
    return;
  }

  const decodedPayload = packet.payload?.decoded && typeof packet.payload.decoded === 'object'
    ? packet.payload.decoded
    : null;
  const decodedPayloadObserverKey = normalizeKey(decodedPayload?.publicKey || '');
  const shouldLearnPacketMetadata = Boolean(decodedPayloadObserverKey);
  let metadataChanged = false;
  const decodedAppData = shouldLearnPacketMetadata
    && decodedPayload?.appData
    && typeof decodedPayload.appData === 'object'
    ? decodedPayload.appData
    : null;
  for (const metadataSource of shouldLearnPacketMetadata ? [decodedAppData, decodedPayload] : []) {
    if (!metadataSource) {
      continue;
    }
    const extractedName = extractDeviceName(metadataSource, topic);
    if (extractedName) {
      metadataChanged = updateObserverName(
        decodedPayloadObserverKey,
        extractedName,
        { allowPinnedOverride: true },
      ) || metadataChanged;
    }
    metadataChanged = updateObserverLocation(
      decodedPayloadObserverKey,
      extractObserverLocation(metadataSource),
    ) || metadataChanged;
  }
  if (metadataChanged) {
    broadcastSnapshot(true);
  }

  const path = Array.isArray(packet.path)
    ? packet.path.map((value) => normalizePathHop(value)).filter(Boolean)
    : [];
  const terminalObserverHop = observerPathHop(observer.key, packet.pathHashSize || 1);
  if (terminalObserverHop && path[path.length - 1] !== terminalObserverHop) {
    path.push(terminalObserverHop);
  }

  if (packet.payloadType !== MeshCorePayloadType.GroupText || !packet.payload?.decoded) {
    return;
  }
  const groupPayload = packet.payload.decoded;
  if (!shouldDecodeChannel(testChannelHash, groupPayload.channelHash)) {
    logger.debug(
      `[mqtt] ignore channel ${groupPayload.channelHash || 'unknown'} on ${shortKey(observer.key)}`,
    );
    return;
  }
  const decodedGroup = groupPayload?.decrypted
    ? {
        channelHash: groupPayload.channelHash,
        sender: String(groupPayload.decrypted.sender || '').trim(),
        message: String(groupPayload.decrypted.message || '').trim(),
        timestamp: Number(groupPayload.decrypted.timestamp || 0),
        macValid: true,
      }
    : null;
  const channelHash = decodedGroup?.channelHash || groupPayload?.channelHash || '';
  const channelName = channelDisplay(channelHash);
  const messageBody = String(decodedGroup?.message || '').trim();
  const sender = String(decodedGroup?.sender || '').trim();
  const messageHash = normalizeMessageHash(
    envelope?.hash || envelope?.message_hash || envelope?.messageHash || packet.messageHash || '',
  );

  if (!decodedGroup) {
    logger.debug(
      `[mqtt] target channel decode failed on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
    );
  }
  if (!messageHash) {
    logger.debug(
      `[mqtt] target channel packet missing message hash on ${shortKey(observer.key)}`,
    );
  }
  if (decodedGroup && !messageBody) {
    logger.debug(
      `[mqtt] target channel packet has empty message body on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
    );
  }

  const packetInfo = {
    observerKey: observer.key,
    observerHash: observer.hash,
    topic,
    seenAt: Date.now(),
    messageHash,
    messageBody,
    sender,
    channelHash,
    channelName,
    path,
    packetType: packet.payloadType,
    rssi: envelopeNumber(envelope, 'rssi', 'rx_rssi', 'rxRssi'),
    snr: envelopeNumber(envelope, 'snr', 'rx_snr', 'rxSnr'),
    duration: envelopeNumber(envelope, 'duration', 'airtime'),
  };

  let session = null;
  const isTestChannel = testChannelHash
    ? shouldDecodeChannel(testChannelHash, channelHash)
    : channelName.toLowerCase() === testChannelName;
  const hadExistingMapping = messageHash ? messageToSession.has(messageHash) : false;

  if (isTestChannel && messageBody) {
    session = maybeMatchSession(packetInfo);
    if (session && !hadExistingMapping) {
      logger.info(
        `[session] matched ${session.code} on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
      );
    } else if (!session) {
      logger.debug(
        `[mqtt] target channel packet did not match any active code on ${shortKey(observer.key)} (${messageHash || 'no-hash'})`,
      );
    }
  }
  if (!session && messageHash && messageToSession.has(messageHash)) {
    session = sessions.get(messageToSession.get(messageHash)) || null;
  }
  if (!session || session.status === 'expired') {
    return;
  }

  if (!session.channelName && channelName) {
    session.channelName = channelName;
  }
  if (!session.messageBody && messageBody) {
    session.messageBody = messageBody;
  }
  if (!session.sender && sender) {
    session.sender = sender;
  }

  if (recordReceipt(session, packetInfo)) {
    logger.debug(
      `[session] receipt ${session.code} from ${shortKey(packetInfo.observerKey)} (${messageHash || 'no-hash'})`,
    );
    scheduleResultsWrite();
    broadcastSnapshot(true);
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use(express.json());
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  if (request.path.startsWith('/api/') || request.path.startsWith('/share/')) {
    response.setHeader('Cache-Control', 'no-store');
  }
  response.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' ws: wss:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src https://challenges.cloudflare.com",
      "img-src 'self' data: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com",
      "object-src 'none'",
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
  );
  if (request.secure) {
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains',
    );
  }
  next();
});
app.get('/manifest.webmanifest', (request, response) => {
  response.type('application/manifest+json').send(JSON.stringify({
    name: PWA_APP_NAME,
    short_name: PWA_APP_NAME,
    description: APP_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#07111d',
    theme_color: '#07111d',
    icons: [
      {
        src: '/logo.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/logo.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }));
});
app.use('/vendor/leaflet', express.static(path.join(APP_DIR, 'node_modules/leaflet/dist'), { index: false }));
app.use(express.static(path.join(APP_DIR, 'public'), { index: false }));

app.get('/channel-qr.svg', (request, response) => {
  if (!testChannelQrSvg) {
    response.status(404).type('text/plain').send('channel QR unavailable');
    return;
  }
  response.type('image/svg+xml');
  response.set('Cache-Control', 'public, max-age=3600');
  response.send(testChannelQrSvg);
});

function adminTokenOk(request) {
  const supplied = String(request.get('x-admin-token') || '');
  if (!ADMIN_TOKEN || supplied.length !== ADMIN_TOKEN.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(ADMIN_TOKEN));
}

// Optional: lets an outside scheduler (host cron, a Workers cron trigger, CI)
// drive the same refresh the internal timer runs. Disabled unless ADMIN_TOKEN
// is set, so the route does not exist on a default deployment.
app.post('/api/admin/reseed', async (request, response) => {
  if (!ADMIN_TOKEN) {
    response.status(404).json({ error: 'not enabled' });
    return;
  }
  if (!adminTokenOk(request)) {
    response.status(403).json({ error: 'forbidden' });
    return;
  }
  const result = await runObserverReseed('api');
  response.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/admin/reseed', (request, response) => {
  if (!ADMIN_TOKEN) {
    response.status(404).json({ error: 'not enabled' });
    return;
  }
  if (!adminTokenOk(request)) {
    response.status(403).json({ error: 'forbidden' });
    return;
  }
  response.json({
    enabled: OBSERVER_RESEED_ENABLED,
    hour: OBSERVER_RESEED_HOUR,
    running: reseedInFlight,
    lastDayKey: reseedLastDayKey,
    last: reseedLastResult,
    logPath: OBSERVER_RESEED_LOG_PATH,
    regionFingerprint: computeRegionFingerprint(),
    lastSeededFingerprint: loadLastReseedFingerprint(),
    bootPassPending: reseedBootTimer !== null,
  });
});

app.get('/api/bootstrap', (request, response) => {
  response.json(serializeBootstrap(request));
});

// Boundary outlines for the coverage map, one per region group. Deliberately
// separate from the snapshot poll: the geometry only changes when the set of
// groups holding observers changes, so repeating tens of KB of coordinates
// every few seconds inside /api/bootstrap would be pure waste.
//
// A group qualifies as soon as any one of its subregions has an observer, and
// then the whole region is outlined - including subregions with no observers -
// because the outline describes the region, not the coverage inside it.
app.get('/api/region-boundaries', (request, response) => {
  const groups = [...new Set(observerDirectory().map((observer) => observer.regionGroup).filter(Boolean))];
  response.json(regionBoundaryCollection(groups));
});

app.post(
  '/api/verify-turnstile',
  rateLimit('turnstile-verify', TURNSTILE_VERIFY_RATE_MAX, TURNSTILE_VERIFY_RATE_WINDOW_MS),
  async (request, response) => {
    if (!TURNSTILE_ENABLED) {
      response.status(400).json({ success: false, error: 'turnstile_not_enabled' });
      return;
    }

    const token = String(request.body?.token || '').trim();
    if (!token) {
      response.status(400).json({ success: false, error: 'token_required' });
      return;
    }

    const result = await verifyTurnstileToken(token, clientAddress(request));
    if (!result.success) {
      clearTurnstileCookie(request, response);
      response.status(400).json({
        success: false,
        error: result.error || 'verification_failed',
      });
      return;
    }

    const authToken = issueTurnstileAuthToken();
    setTurnstileCookie(request, response, authToken);
    response.json({ success: true });
  },
);

app.post(
  '/api/sessions',
  rateLimit('session-create', SESSION_RATE_MAX, SESSION_RATE_WINDOW_MS),
  (request, response) => {
    if (!hasTurnstileAccess(request)) {
      response.status(403).json({ error: 'turnstile_required' });
      return;
    }
    const now = Date.now();
    const requestedAllowlist = explicitObserverAllowlist(request.body?.expectedObserverKeys);
    const defaultExpected = expectedObserversForSession();
    const expected = requestedAllowlist.enabled ? requestedAllowlist : defaultExpected;
    const session = {
      id: randomUUID(),
      code: createCode(),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      status: 'waiting',
      useCount: 0,
      maxUses: MAX_USES_PER_CODE,
      messageHash: '',
      messageHashes: [],
      matchedAt: 0,
      messageBody: '',
      sender: '',
      channelHash: '',
      channelName: '',
      allowlistEnabled: requestedAllowlist.enabled,
      // Snapshotted so the denominator cannot drift while the session is open.
      activeObserverKeys: activeObserverKeys(now),
      expectedObserverKeys: expected.keys.length > 0 ? expected.keys : [],
      expectedObserverSource: expected.source || '',
      receipts: new Map(),
    };
    sessions.set(session.id, session);
    logger.info(`[session] created ${session.code}`);
    scheduleResultsWrite();
    broadcastSnapshot(true);
    response.status(201).json(serializeSession(session, request));
  },
);

app.get('/api/sessions/:sessionId', (request, response) => {
  const session = sessions.get(request.params.sessionId);
  if (!session) {
    response.status(404).json({ error: 'session_not_found' });
    return;
  }
  response.json(serializeSession(session, request));
});

function sendApp(request, response) {
  response.type('html').send(renderHtmlTemplate(appHtmlTemplate, request));
}

function sendLanding(request, response) {
  response.type('html').send(renderHtmlTemplate(landingHtmlTemplate, request, 'Verification'));
}

function sendShare(request, response) {
  response.type('html').send(renderHtmlTemplate(shareHtmlTemplate, request, 'Shared Result'));
}

app.get('/', (request, response) => {
  if (TURNSTILE_ENABLED && !hasTurnstileAccess(request)) {
    sendLanding(request, response);
    return;
  }
  response.redirect('/app');
});

app.get('/app', (request, response) => {
  if (TURNSTILE_ENABLED && !hasTurnstileAccess(request)) {
    response.redirect('/');
    return;
  }
  sendApp(request, response);
});

app.get('/share/:sessionId', (request, response) => {
  sendShare(request, response);
});

app.get(/.*/, (request, response) => {
  if (TURNSTILE_ENABLED && !hasTurnstileAccess(request)) {
    response.redirect('/');
    return;
  }
  sendApp(request, response);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

let mqttClient = null;
let mqttConnected = false;
let lastSnapshotSentAt = 0;
let pruneInterval = null;

function broadcastSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastSnapshotSentAt < 1000) {
    return;
  }
  lastSnapshotSentAt = now;
  const payload = JSON.stringify({
    type: 'snapshot',
    data: snapshotPayload(),
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'snapshot',
    data: snapshotPayload(),
  }));
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

function startMqtt() {
  const options = {
    clientId: envValue(
      'MQTT_CLIENT_ID',
      `mesh-health-${randomBytes(3).toString('hex')}`,
    ),
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  };

  const username = envValue('MQTT_USERNAME', '');
  const password = envValue('MQTT_PASSWORD', '');
  if (username) {
    options.username = username;
    options.password = password;
  }

  mqttClient = mqtt.connect(MQTT_URL, options);

  mqttClient.on('connect', () => {
    mqttConnected = true;
    logger.info(`[mqtt] connected ${brokerLabel(MQTT_URL)}`);
    for (const topic of MQTT_TOPICS) {
      mqttClient.subscribe(topic, (error) => {
        if (error) {
          logger.warn(`[mqtt] subscribe failed ${topic}: ${error.message}`);
          return;
        }
        logger.info(`[mqtt] subscribed ${topic}`);
      });
    }
    broadcastSnapshot(true);
  });

  mqttClient.on('reconnect', () => {
    mqttConnected = false;
    broadcastSnapshot(true);
  });

  mqttClient.on('close', () => {
    mqttConnected = false;
    broadcastSnapshot(true);
  });

  mqttClient.on('error', (error) => {
    mqttConnected = false;
    logger.warn(`[mqtt] ${error.message}`);
    broadcastSnapshot(true);
  });

  mqttClient.on('message', ingestMqttMessage);
}

function startRuntime() {
  if (pruneInterval) {
    return;
  }
  pruneInterval = setInterval(() => {
    const changed = pruneState();
    if (changed) {
      broadcastSnapshot(true);
    } else {
      broadcastSnapshot(false);
    }
  }, 10000);
  if (OBSERVER_RESEED_ENABLED) {
    reseedLastDayKey = loadLastReseedDayKey();
    reseedInterval = setInterval(maybeRunScheduledReseed, 600000);
    logger.info(
      `[reseed] self-refresh on, daily after ${String(OBSERVER_RESEED_HOUR).padStart(2, '0')}:00 local`
      + `${reseedLastDayKey ? `, last scheduled pass ${reseedLastDayKey}` : ''}`,
    );
    // A widened boundary only reaches observer positions through a pass, so a
    // deploy that changes the region inputs runs one now rather than waiting
    // for OBSERVER_RESEED_HOUR. The hour is deliberately not consulted: the
    // trigger is the edit, not the clock. Fires once per changed fingerprint,
    // because the pass itself records the new one.
    const fingerprint = computeRegionFingerprint();
    const seeded = loadLastReseedFingerprint();
    if (fingerprint && fingerprint !== seeded) {
      reseedBootTimer = setTimeout(() => {
        reseedBootTimer = null;
        runObserverReseed('boot').catch((error) => {
          logger.warn(`[reseed] boot pass rejected: ${error.message}`);
        });
      }, OBSERVER_RESEED_BOOT_DELAY_MS);
      reseedBootTimer.unref?.();
      logger.info(
        `[reseed] region inputs changed (${seeded || 'none recorded'} -> ${fingerprint});`
        + ` boot pass in ${Math.round(OBSERVER_RESEED_BOOT_DELAY_MS / 1000)}s`,
      );
    }
  }
  startMqtt();

  server.listen(PORT, () => {
    logger.info(`[web] listening on http://localhost:${PORT}`);
    logger.info(
      `[web] using broker ${brokerLabel(MQTT_URL)} and ${
        testChannelHash ? `#${testChannelName} (${testChannelHash})` : `#${testChannelName}`
      }`,
    );
    if (!decoderKeyCandidates.length) {
      logger.warn('[web] no decoder key configured for the test channel');
    }
    if (!CARTO_BASEMAP_KEY) {
      logger.warn(
        '[web] no CARTO_BASEMAP_KEY set - the coverage map falls back to OpenStreetMap tiles (free key: https://carto.com/basemaps/apikey/)',
      );
    } else if (mapTileConfig().darkTileUrl.includes('cartocdn.com') === false) {
      logger.info('[web] CARTO key set but MAP_TILE_DARK_URL overrides the dark basemap');
    }
    logger.info(`[web] log level ${logger.level}`);
  });
}

export function resetTestState() {
  flushScheduledWrites();
  sessions.clear();
  messageToSession.clear();
  rateLimitBuckets.clear();
  turnstileAuthTokens.clear();
  observerState.clear();
  observerActivityHistory.clear();
  for (const [key, entry] of baselineObserverActivityHistory.entries()) {
    observerActivityHistory.set(key, {
      days: { ...(entry?.days || {}) },
      lastPacketAt: Number(entry?.lastPacketAt || 0),
    });
  }
  primeObserverDirectory();
  if (!DISABLE_RESULTS_FILE_WRITES) {
    writeResultsFile();
  }
  lastSnapshotSentAt = 0;
}

export { flushScheduledWrites };

export function ingestMqttMessage(topic, payload) {
  const parts = String(topic || '').split('/');
  const streamType = parts[parts.length - 1] || '';
  const observerKey = parts[parts.length - 2] || '';
  if (!observerKey) {
    return;
  }
  // meshcore/<CODE>/<pubkey>/<stream> - the segment before the key is the uplink
  // gateway's airport identifier. Upstream discards it; it is the only region
  // signal available for an observer that never publishes a position.
  if (parts.length >= 3) {
    updateObserverUplinkCode(observerKey, parts[parts.length - 3]);
  }
  if (streamType === 'packets') {
    handlePacketMessage(topic, observerKey, payload);
    return;
  }
  if (streamType === 'status' || streamType === 'internal') {
    if (handleObserverMetadata(topic, observerKey, payload)) {
      broadcastSnapshot(true);
    }
  }
}

export {
  computeRegionFingerprint,
  loadLastReseedFingerprint,
  runObserverReseed,
  app,
  server,
  APP_DATA_DIR,
  OBSERVERS_FILE_PATH,
  OBSERVER_ACTIVITY_FILE_PATH,
  RESULTS_FILE_PATH,
};

if (IS_MAIN_MODULE && !DISABLE_RUNTIME) {
  startRuntime();
}
