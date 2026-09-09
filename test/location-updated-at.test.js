import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(TEST_DIR, '..');

// A legacy observer.json predates the locationUpdatedAt field entirely - it
// only ever had name/uplink/lat/lon/hashBytes. Loading one must not invent a
// timestamp (e.g. defaulting to Date.now()), because that would make every
// pre-existing observer look like its position was just learned.
test('a legacy observer.json with no locationUpdatedAt loads as null, not now()', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-health-legacy-location-test-'));
  const observerFile = path.join(tempDir, 'observer.json');
  const observerActivityFile = path.join(tempDir, 'observer-activity.json');
  const resultsFile = path.join(tempDir, 'session-results.json');
  const observerKey = 'AF07FC2005E04D08DDA921E64985E62201BF974AE0B0E35084B804229ED11A2B';

  fs.writeFileSync(observerFile, JSON.stringify({
    [observerKey]: { name: 'Legacy Observer', lat: 42.3601, lon: -71.0589 },
  }, null, 2), 'utf8');
  fs.writeFileSync(observerActivityFile, '{\n  "version": 1,\n  "observers": {}\n}\n', 'utf8');
  fs.writeFileSync(resultsFile, '{\n  "version": 1,\n  "sessions": []\n}\n', 'utf8');

  const previousEnv = {
    MESH_HEALTH_DISABLE_RUNTIME: process.env.MESH_HEALTH_DISABLE_RUNTIME,
    TURNSTILE_ENABLED: process.env.TURNSTILE_ENABLED,
    LOG_LEVEL: process.env.LOG_LEVEL,
    OBSERVERS_FILE: process.env.OBSERVERS_FILE,
    OBSERVER_ACTIVITY_FILE: process.env.OBSERVER_ACTIVITY_FILE,
    RESULTS_FILE: process.env.RESULTS_FILE,
    TEST_CHANNEL_NAME: process.env.TEST_CHANNEL_NAME,
    TEST_CHANNEL_SECRET: process.env.TEST_CHANNEL_SECRET,
    KNOWN_OBSERVERS: process.env.KNOWN_OBSERVERS,
    OBSERVER_RETENTION_SECONDS: process.env.OBSERVER_RETENTION_SECONDS,
  };

  process.env.MESH_HEALTH_DISABLE_RUNTIME = 'true';
  process.env.TURNSTILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'info';
  process.env.OBSERVERS_FILE = observerFile;
  process.env.OBSERVER_ACTIVITY_FILE = observerActivityFile;
  process.env.RESULTS_FILE = resultsFile;
  process.env.TEST_CHANNEL_NAME = 'health-check';
  process.env.TEST_CHANNEL_SECRET = 'E6D973AAC5101145AD3A3F3A0B3D52EB';
  process.env.KNOWN_OBSERVERS = observerKey;
  process.env.OBSERVER_RETENTION_SECONDS = '14400';

  const serverModule = await import(
    `${pathToFileURL(path.join(REPO_DIR, 'server.js')).href}?legacy-location-test=${Date.now()}`
  );
  const { flushScheduledWrites, resetTestState, server } = serverModule;

  let baseUrl = '';
  try {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    resetTestState();

    const response = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const observer = payload.defaultObservers.find((entry) => entry.key === observerKey);

    assert.equal(observer?.name, 'Legacy Observer');
    assert.equal(observer?.lat, 42.3601);
    assert.equal(observer?.lon, -71.0589);
    assert.equal(observer?.hasLocation, true);
    assert.equal(observer?.locationUpdatedAt, null);
  } finally {
    flushScheduledWrites();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    fs.rmSync(tempDir, { recursive: true, force: true });

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
