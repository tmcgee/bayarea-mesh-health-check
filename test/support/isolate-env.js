// Keep the developer's real .env out of the test run.
//
// server.js reads <APP_DIR>/.env and fills in every key that is not already
// present in process.env. Each test file sets the handful of variables it cares
// about, so any *other* key in a live .env silently leaks into the app under
// test — SITE_URL rewrites the social meta tags, REGIONS_FILE and
// UPLINK_CODES_FILE load real boundaries, MAP_OBSERVER_SCOPE changes which
// observers reach the map. On the Bay Area deployment that turned 56 passing
// tests into 9 failures with no code change at all.
//
// This module must be imported before the test dynamically imports server.js.
// It is a no-op on a clean checkout, which is why CI never saw the problem.
process.env.MESH_HEALTH_SKIP_ENV_FILE = 'true';

// Belt and braces: if something loads server.js without honouring the flag,
// these are the keys a real .env would otherwise inject. Deleting them leaves
// server.js on its own documented defaults. Test files assign the variables
// they need in their module body, which runs after this import, so nothing a
// test sets deliberately is affected.
for (const key of [
  'SITE_URL',
  'MQTT_HOST',
  'MQTT_PORT',
  'MQTT_TRANSPORT',
  'MQTT_WS_PATH',
  'MQTT_TLS',
  'MQTT_TOPIC',
  'MQTT_USERNAME',
  'MQTT_PASSWORD',
  'REGIONS_FILE',
  'REQUIRE_REGION_MATCH',
  'REGION_FALLBACK',
  'UPLINK_CODES_FILE',
  'MESHCORE_REGION_SCOPES_FILE',
  'MESHCORE_SCOPE_EVIDENCE_FILE',
  'REGIONAL_TEST_CHANNELS',
  'MAP_OBSERVER_SCOPE',
  'OBSERVER_TARGET_MODE',
  'OBSERVER_MIN_SCORING_SET',
  'OBSERVER_ACTIVE_WINDOW_SECONDS',
  'OBSERVER_TOP_WINDOW_DAYS',
  'OBSERVER_TOP_COUNT',
  'CARTO_BASEMAP_KEY',
  'CARTO_API_KEY',
  'MAP_TILE_DARK_URL',
  'MAP_TILE_LIGHT_URL',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
]) {
  delete process.env[key];
}
