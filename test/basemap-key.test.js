// Basemap key handling and the fork's version scheme.
//
// Upstream v1.3.8 introduced CARTO_BASEMAP_KEY. This fork shipped the same
// feature earlier under CARTO_API_KEY, so the old name has to keep working for
// deployments whose .env predates the merge. Two server instances are booted
// here with different environments: one with only the legacy name set, one with
// no key at all.
import './support/isolate-env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dockerTag, isLegalDockerTag } from '../lib/version.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-check-basemap-test-'));

function storageEnv(prefix) {
  const observerFile = path.join(tempDir, `${prefix}-observer.json`);
  const observerActivityFile = path.join(tempDir, `${prefix}-observer-activity.json`);
  const resultsFile = path.join(tempDir, `${prefix}-session-results.json`);
  fs.writeFileSync(observerFile, '{}\n', 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');
  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'error';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;
}

// Instance A: only the legacy CARTO_API_KEY is set.
storageEnv('legacy');
delete process.env.CARTO_BASEMAP_KEY;
process.env.CARTO_API_KEY = 'legacy-carto-key';
const legacyModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?basemap-legacy=${Date.now()}`
);

// Instance B: no key of either name.
storageEnv('keyless');
delete process.env.CARTO_BASEMAP_KEY;
delete process.env.CARTO_API_KEY;
const keylessModule = await import(
  `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?basemap-keyless=${Date.now()}`
);

const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));

let legacyBaseUrl = '';
let keylessBaseUrl = '';

async function listen(module) {
  await new Promise((resolve) => {
    module.server.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${module.server.address().port}`;
}

async function close(module) {
  module.flushScheduledWrites();
  await new Promise((resolve, reject) => {
    module.server.close((error) => (error ? reject(error) : resolve()));
  });
}

before(async () => {
  legacyBaseUrl = await listen(legacyModule);
  keylessBaseUrl = await listen(keylessModule);
});

after(async () => {
  await close(legacyModule);
  await close(keylessModule);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('CARTO_API_KEY is still honoured as an alias for CARTO_BASEMAP_KEY', async () => {
  const response = await fetch(`${legacyBaseUrl}/api/bootstrap`);
  assert.equal(response.status, 200);
  const { map } = await response.json();

  assert.equal(map.cartoBasemapKey, 'legacy-carto-key');
  assert.equal(map.darkBasemapAvailable, true);
  assert.equal(map.cartoKeyConfigured, true);
  assert.match(map.darkTileUrl, /cartocdn\.com/);
  assert.match(map.darkTileUrl, /key=legacy-carto-key/);
  assert.match(map.lightTileUrl, /key=legacy-carto-key/);
});

test('without a key both basemaps fall back to OpenStreetMap', async () => {
  const response = await fetch(`${keylessBaseUrl}/api/bootstrap`);
  assert.equal(response.status, 200);
  const { map } = await response.json();

  assert.equal(map.cartoBasemapKey, '');
  assert.equal(map.darkBasemapAvailable, false);
  assert.equal(map.cartoKeyConfigured, false);
  assert.doesNotMatch(map.darkTileUrl, /cartocdn\.com/);
  assert.doesNotMatch(map.lightTileUrl, /cartocdn\.com/);
  assert.match(map.darkTileUrl, /tile\.openstreetmap\.org/);
  assert.equal(map.darkAttribution, '&copy; OpenStreetMap contributors');
});

test('the fork version records its upstream base and its own build', () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+\+bayarea\.\d+$/);
  const [upstreamBase] = packageJson.version.split('+');
  assert.equal(upstreamBase, '1.3.8');
});

test('the version maps to a legal Docker tag', () => {
  const tag = dockerTag(packageJson.version);
  assert.equal(tag, '1.3.8-bayarea.11');
  assert.ok(isLegalDockerTag(tag));
  assert.ok(!tag.includes('+'), 'Docker tags cannot contain +');
  assert.throws(() => dockerTag('1.3.8+bay area'), /legal Docker tag/);
});

test('docker-compose pins the Docker-safe form of the same version', () => {
  const compose = fs.readFileSync(path.join(REPO_DIR, 'docker-compose.yml'), 'utf8');
  const match = compose.match(/image:\s*bayarea-mesh-health-check:\$\{APP_IMAGE_TAG:-([^}]+)\}/);
  assert.ok(match, 'docker-compose.yml should pin a default image tag');
  assert.equal(match[1], dockerTag(packageJson.version));
});
