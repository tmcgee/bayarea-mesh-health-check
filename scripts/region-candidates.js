#!/usr/bin/env node
// Prints the covered places as JSON for seed-observers.py (1.2.0), so the
// reseed decides "inside the boundary" with the server's own resolver instead
// of a second copy of its rules in Python. Reads the same environment the app
// does (MESHCORE_REGION_SCOPES_FILE, REGION_SHAPES_DIR, REGION_OVERRIDES_FILE),
// with paths relative to the app directory. Tree mode only: with a legacy
// REGIONS_FILE the Python script reads that file itself, as it always has.
//
// Output: { problems, candidates: [{ code, name, path, shapes: [ids] }], shapes: { id: polygons } }
// Candidates are in match order (deepest first, then smallest area): the first
// that contains a point is where the server places it. Read-only: writes nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMeshcoreScopes } from '../lib/meshcore-scopes.js';
import { loadOverrides, loadShapeLibrary, resolvePlaces } from '../lib/region-places.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = (name) => String(process.env[name] || '').trim();
const appPath = (value) => (path.isAbsolute(value) ? value : path.resolve(APP_DIR, value));

function main() {
  if (!env('REGION_SHAPES_DIR')) throw new Error('REGION_SHAPES_DIR is not set');
  if (!env('MESHCORE_REGION_SCOPES_FILE')) throw new Error('REGION_SHAPES_DIR needs MESHCORE_REGION_SCOPES_FILE');
  const scopes = loadMeshcoreScopes(appPath(env('MESHCORE_REGION_SCOPES_FILE')));
  const library = loadShapeLibrary(appPath(env('REGION_SHAPES_DIR')));
  const overridesFile = env('REGION_OVERRIDES_FILE');
  const { overrides } = loadOverrides(overridesFile ? appPath(overridesFile) : '');
  const resolved = resolvePlaces(scopes.tree, library, overrides);
  const shapes = {};
  const candidates = resolved.candidates.map((entry) => {
    for (const id of entry.shapeIds) shapes[id] = shapes[id] || library.shapes.get(id).polygons;
    return { code: entry.code, name: entry.name, path: entry.path, shapes: entry.shapeIds };
  });
  process.stdout.write(`${JSON.stringify({ problems: resolved.problems, candidates, shapes })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`region-candidates: ${error.message}\n`);
  process.exit(1);
}
