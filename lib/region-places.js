// Places built from a MeshCore scope tree and a shape library (1.2.0,
// docs/design-scalable-regions.md §5). Three inputs replace the old hand-edited
// boundary file:
//
// 1. A scope tree (format-2 regions.json, pinned, shipped verbatim). Hierarchy and
//    names come from it; it is not ours.
// 2. The shape library in regions/shapes/ (ours, built by scripts/build-shapes.js),
//    keyed by stable IDs such as `us-06097`.
// 3. regions/region-overrides.json (ours, ships empty) for deliberate differences.
//
// A place's own code is its ID everywhere. Its path (`bayarea` > `northbay` >
// `sonoma`) is derived here at boot, so a change above a place never touches stored
// data. Pure functions apart from the two loaders; server.js and the tests share them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KNOWN_TREE_FORMAT = 2;
const KNOWN_LIBRARY_FORMAT = 1;
const KNOWN_OVERRIDES_FORMAT = 1;
const OVERRIDE_KEYS = new Set(['format', 'notice', 'coverage', 'shapes', 'exclude', 'renamed', 'names', 'order', 'expand', 'regroup']);

// ---------- geometry ----------

function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygons(lon, lat, polygons) {
  return polygons.some((rings) => pointInRing(lon, lat, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(lon, lat, hole)));
}

export function geometryPolygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function polygonsBounds(polygons) {
  let bounds = null;
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0] || []) {
      if (!bounds) bounds = [lon, lat, lon, lat];
      else {
        if (lon < bounds[0]) bounds[0] = lon;
        if (lat < bounds[1]) bounds[1] = lat;
        if (lon > bounds[2]) bounds[2] = lon;
        if (lat > bounds[3]) bounds[3] = lat;
      }
    }
  }
  return bounds;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(sum) / 2;
}

function polygonsArea(polygons) {
  return polygons.reduce((total, rings) => total + ringArea(rings[0])
    - rings.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0), 0);
}

const inBounds = (lon, lat, b) => b && lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3];

// ---------- loaders ----------

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Reads manifest.json and every file it lists, checking each SHA-256 so a hand edit or
// a partial copy fails startup instead of quietly moving a border.
export function loadShapeLibrary(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest?.format !== KNOWN_LIBRARY_FORMAT || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`${manifestPath}: expected a shape manifest, format ${KNOWN_LIBRARY_FORMAT}`);
  }
  const shapes = new Map();
  const states = new Map();
  for (const [fileName, entry] of Object.entries(manifest.files)) {
    const text = fs.readFileSync(path.join(dir, fileName), 'utf8');
    if (sha256(text) !== entry.sha256) {
      throw new Error(`${fileName}: SHA-256 does not match manifest.json; rebuild with scripts/build-shapes.js`);
    }
    states.set(entry.state, { id: entry.state, name: entry.stateName, fips: entry.stateFips, file: fileName });
    for (const feature of JSON.parse(text).features || []) {
      const id = feature?.properties?.id;
      if (!id || shapes.has(id)) throw new Error(`${fileName}: missing or duplicate shape id ${id || '(none)'}`);
      const polygons = geometryPolygons(feature.geometry);
      shapes.set(id, {
        id,
        name: String(feature.properties.name || ''),
        kind: String(feature.properties.kind || ''),
        state: String(feature.properties.state || entry.state),
        polygons,
      });
    }
  }
  return { manifest, manifestSha256: sha256(manifestText), shapes, states };
}

export function emptyOverrides() {
  return {
    format: KNOWN_OVERRIDES_FORMAT, coverage: [], shapes: {}, exclude: [], renamed: {}, names: {}, order: [], expand: [],
  };
}

export function parseOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== KNOWN_OVERRIDES_FORMAT) {
    throw new Error(`expected a region overrides file, format ${KNOWN_OVERRIDES_FORMAT}`);
  }
  const unknown = Object.keys(value).filter((key) => !OVERRIDE_KEYS.has(key));
  if (unknown.length) throw new Error(`unknown override keys: ${unknown.join(', ')}`);
  // Not built: the design allows it, but the file ships without one (Central Valley
  // follows the tree, 2026-10-30). Refused rather than ignored, so it cannot look applied.
  if (value.regroup && Object.keys(value.regroup).length) throw new Error('regroup overrides are not supported yet');
  const list = (key) => {
    const raw = value[key] ?? [];
    if (!Array.isArray(raw) || raw.some((code) => typeof code !== 'string' || !code)) throw new Error(`${key} must be a list of place codes`);
    return [...raw];
  };
  const map = (key) => {
    const raw = value[key] ?? {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${key} must be an object`);
    return { ...raw };
  };
  const shapes = map('shapes');
  for (const [code, ids] of Object.entries(shapes)) {
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) throw new Error(`shapes.${code} must list shape ids`);
  }
  const renamed = map('renamed');
  for (const [from, to] of Object.entries(renamed)) {
    if (typeof to !== 'string' || !to) throw new Error(`renamed.${from} must be a place code`);
  }
  // Display names only: a place's code, scope and shape matching never change.
  const names = map('names');
  for (const [code, name] of Object.entries(names)) {
    if (typeof name !== 'string' || !name.trim()) throw new Error(`names.${code} must be a display name`);
    names[code] = name.trim();
  }
  return {
    format: KNOWN_OVERRIDES_FORMAT,
    coverage: list('coverage'),
    shapes,
    exclude: list('exclude'),
    renamed,
    names,
    order: list('order'),
    expand: list('expand'),
  };
}

export function loadOverrides(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { overrides: emptyOverrides(), sha256: '' };
  const text = fs.readFileSync(filePath, 'utf8');
  return { overrides: parseOverrides(JSON.parse(text)), sha256: sha256(text) };
}

// ---------- resolution ----------

const normalizeName = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const COUNTY_SUFFIX = /\s+(county|parish|borough|census area|regional district)$/i;

// The state a tree entry stands for, if any: by the library's state name, its ID
// (`us-ca`), the postal code (`ca`), or the name run together (`california`, matkam's
// root code). `aliases` may also name the state ID.
function stateForEntry(entry, library) {
  for (const state of library.states.values()) {
    const postal = state.id.replace(/^us-/, '');
    const joined = normalizeName(state.name).replace(/\s+/g, '');
    const code = String(entry.code || '').toLowerCase();
    if (normalizeName(entry.name) === normalizeName(state.name) || code === state.id || code === postal || code === joined
      || (Array.isArray(entry.aliases) && entry.aliases.some((alias) => String(alias).toLowerCase() === state.id))) {
      return state.id;
    }
  }
  return '';
}

function shapesNamed(library, state, name) {
  const wanted = normalizeName(name);
  const ids = [];
  for (const shape of library.shapes.values()) {
    if (shape.state === state && normalizeName(shape.name) === wanted) ids.push(shape.id);
  }
  return ids;
}

// Resolves every non-placeholder place to geometry, in the order of §5.2:
//   1. `outline` names, within the place's state ancestor;
//   2. no outline and a county kind: the place's own name within that state;
//   3. an overrides `shapes` entry (wins over both);
//   4. otherwise the union of its children. None at any depth: point-only.
// Returns places in tree order with their paths, plus every problem found. Problems
// never throw here: server.js logs them and the check script fails on them.
export function resolvePlaces(tree, library, overrides = emptyOverrides()) {
  if (!tree || tree.format !== KNOWN_TREE_FORMAT || !Array.isArray(tree.places)) {
    throw new Error(`expected a meshcore-settings regions.json tree, format ${KNOWN_TREE_FORMAT}`);
  }
  const problems = [];
  const levels = Array.isArray(tree.levels) ? tree.levels : [];
  let rootState = '';
  for (const root of Array.isArray(tree.root) ? tree.root : []) {
    rootState = stateForEntry(root, library) || rootState;
  }
  const excluded = new Set(overrides.exclude || []);
  const places = [];
  const byCode = new Map();

  const visit = (place, parent, depth, state) => {
    if (!place || typeof place.code !== 'string' || !place.code) return null;
    if (place.placeholder === true) return null;
    if (byCode.has(place.code)) {
      problems.push(`duplicate place code ${place.code}; the second is dropped`);
      return null;
    }
    const placeState = stateForEntry(place, library) || state;
    const entry = {
      code: place.code,
      name: typeof place.name === 'string' && place.name ? place.name : place.code,
      kind: typeof place.kind === 'string' ? place.kind : '',
      level: levels[depth - 1]?.name || '',
      depth,
      parent: parent?.code || '',
      path: [...(parent?.path || []), place.code],
      state: placeState,
      children: [],
      shapeIds: [],
      source: 'none',
      polygons: [],
      bounds: null,
      area: 0,
      excluded: excluded.has(place.code) || Boolean(parent?.excluded),
    };
    byCode.set(entry.code, entry);
    places.push(entry);

    const override = overrides.shapes?.[place.code];
    const outline = Array.isArray(place.outline) ? place.outline.map(String) : [];
    if (override) {
      const missing = override.filter((id) => !library.shapes.has(id));
      if (missing.length) problems.push(`${place.code}: override shapes not in the library: ${missing.join(', ')}`);
      entry.shapeIds = override.filter((id) => library.shapes.has(id));
      entry.source = 'override';
    } else if (outline.length) {
      if (!placeState) {
        problems.push(`${place.code}: outline ${outline.join(', ')} has no state ancestor in the shape library`);
      } else {
        for (const name of outline) {
          const ids = shapesNamed(library, placeState, name);
          if (ids.length === 1) entry.shapeIds.push(ids[0]);
          else problems.push(`${place.code}: outline "${name}" matches ${ids.length} shapes in ${placeState}`);
        }
      }
      entry.source = 'outline';
    } else if (/^(county|regional district)$/i.test(entry.kind) && placeState) {
      const ids = shapesNamed(library, placeState, entry.name.replace(COUNTY_SUFFIX, ''));
      if (ids.length === 1) {
        entry.shapeIds = ids;
        entry.source = 'name';
      } else if (ids.length > 1) {
        problems.push(`${place.code}: name "${entry.name}" matches ${ids.length} shapes in ${placeState}`);
      }
    }
    entry.shapeIds = [...new Set(entry.shapeIds)];
    entry.polygons = entry.shapeIds.flatMap((id) => library.shapes.get(id).polygons);

    for (const child of Array.isArray(place.children) ? place.children : []) {
      const resolved = visit(child, entry, depth + 1, placeState);
      if (resolved) entry.children.push(resolved.code);
    }
    if (!entry.polygons.length) {
      const childShapes = [...new Set(entry.children.flatMap((code) => byCode.get(code).shapeIds))];
      if (childShapes.length) {
        entry.shapeIds = childShapes;
        entry.polygons = childShapes.flatMap((id) => library.shapes.get(id).polygons);
        entry.source = 'children';
      }
    }
    entry.bounds = polygonsBounds(entry.polygons);
    entry.area = polygonsArea(entry.polygons);
    // After shape matching, which uses the tree's own name (Sonoma County).
    if (overrides.names?.[place.code]) entry.name = overrides.names[place.code];
    return entry;
  };
  for (const place of tree.places) visit(place, null, 1, rootState);

  for (const code of [...(overrides.coverage || []), ...(overrides.exclude || [])]) {
    if (!byCode.has(code)) problems.push(`overrides name unknown place ${code}`);
  }
  for (const key of ['shapes', 'names']) {
    for (const code of Object.keys(overrides[key] || {})) {
      if (!byCode.has(code)) problems.push(`overrides.${key} names unknown place ${code}`);
    }
  }
  for (const key of ['order', 'expand']) {
    for (const code of overrides[key] || []) {
      if (!byCode.has(code)) problems.push(`overrides.${key} names unknown place ${code}`);
    }
  }

  // Coverage (§5.3): every place with geometry, narrowed to the `coverage` list's
  // subtrees when the overrides file has one, minus `exclude`.
  // An excluded place takes its ground with it: a covered ancestor whose outline
  // lists the same shapes loses them, so a point there is outside coverage rather
  // than placed one level up.
  const coverageRoots = new Set(overrides.coverage || []);
  const excludedShapes = new Set(places.filter((entry) => entry.excluded).flatMap((entry) => entry.shapeIds));
  for (const entry of places) {
    if (!entry.excluded && excludedShapes.size && entry.shapeIds.some((id) => excludedShapes.has(id))) {
      entry.shapeIds = entry.shapeIds.filter((id) => !excludedShapes.has(id));
      entry.polygons = entry.shapeIds.flatMap((id) => library.shapes.get(id).polygons);
      entry.bounds = polygonsBounds(entry.polygons);
      entry.area = polygonsArea(entry.polygons);
    }
    entry.covered = !entry.excluded && entry.polygons.length > 0
      && (coverageRoots.size === 0 || entry.path.some((code) => coverageRoots.has(code)));
  }
  // Deepest first, then smaller area: the first containing candidate wins.
  const candidates = places.filter((entry) => entry.covered)
    .sort((a, b) => b.depth - a.depth || a.area - b.area);
  const pointOnly = places.filter((entry) => !entry.polygons.length).map((entry) => entry.code);
  const summary = `${places.length} places, ${places.length - pointOnly.length} with shapes, ${pointOnly.length} point-only`
    + `${coverageRoots.size ? `; coverage ${[...coverageRoots].join(', ')}` : ''}`;
  return {
    places,
    byCode,
    candidates,
    pointOnly,
    problems,
    summary,
    renamed: { ...(overrides.renamed || {}) },
    order: new Map((overrides.order || []).map((code, index) => [code, index])),
    expand: new Set((overrides.expand || []).filter((code) => byCode.has(code))),
    shapes: library.shapes,
  };
}

// Sibling order everywhere places are listed (chips, Regions Reached): the
// overrides `order` list first, in its order, then everyone else by display name.
// One list serves every level, since it only ever compares siblings.
export function comparePlaces(resolved) {
  const rank = (entry) => resolved?.order?.get(entry.code) ?? Infinity;
  return (left, right) => {
    const a = rank(left);
    const b = rank(right);
    if (a !== b) return a < b ? -1 : 1;
    return left.name.localeCompare(right.name) || left.code.localeCompare(right.code);
  };
}

// The deepest covered place containing the point, or null when it is outside coverage.
export function assignPlace(resolved, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const entry of resolved.candidates) {
    if (inBounds(lon, lat, entry.bounds) && pointInPolygons(lon, lat, entry.polygons)) return entry;
  }
  return null;
}

// A stored code as it reads today: a `renamed` entry carries an old code to its new
// one for a minor version. Unknown codes return ''.
export function currentCode(resolved, code) {
  const value = String(code || '');
  const renamed = resolved.renamed?.[value];
  const target = renamed || value;
  return resolved.byCode.has(target) ? target : '';
}

export function placePath(resolved, code) {
  return resolved.byCode.get(currentCode(resolved, code))?.path || [];
}

// ---------- flat boundary files (REGIONS_FILE) ----------

const slug = (value) => String(value || '').trim().toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'place';

// A REGIONS_FILE GeoJSON (upstream's format: one feature per area, with optional
// `group` and `parentRegion` properties) as places, so one code path serves both
// inputs. Codes are slugs of the names, made unique with a suffix; they are stable
// for as long as the names are, which is all a flat file can offer. Every feature is
// covered: the file is the boundary.
export function resolveFlatBoundaries(boundaries) {
  const places = [];
  const byCode = new Map();
  const used = new Set();
  const codeFor = (name) => {
    const base = slug(name);
    let code = base;
    for (let n = 2; used.has(code); n += 1) code = `${base}-${n}`;
    used.add(code);
    return code;
  };
  const make = (name, parent, depth) => {
    const entry = {
      code: codeFor(name),
      name,
      kind: '',
      level: '',
      depth,
      parent: parent?.code || '',
      path: [...(parent?.path || []), ''],
      state: '',
      children: [],
      shapeIds: [],
      source: 'file',
      polygons: [],
      bounds: null,
      area: 0,
      excluded: false,
      covered: true,
    };
    entry.path[entry.path.length - 1] = entry.code;
    places.push(entry);
    byCode.set(entry.code, entry);
    if (parent) parent.children.push(entry.code);
    return entry;
  };
  const parents = new Map();
  const groups = new Map();
  for (const boundary of boundaries) {
    let parent = null;
    if (boundary.group && boundary.parentRegion) {
      if (!parents.has(boundary.parentRegion)) parents.set(boundary.parentRegion, make(boundary.parentRegion, null, 1));
      parent = parents.get(boundary.parentRegion);
    }
    let group = null;
    if (boundary.group) {
      const known = groups.get(boundary.group);
      if (known) group = known;
      else {
        group = make(boundary.group, parent, parent ? 2 : 1);
        groups.set(boundary.group, group);
      }
    }
    const leaf = make(boundary.name, group, group ? group.depth + 1 : 1);
    leaf.polygons = geometryPolygons(boundary.geometry);
    for (let at = group; at; at = byCode.get(at.parent)) at.polygons.push(...leaf.polygons);
  }
  for (const entry of places) {
    entry.bounds = polygonsBounds(entry.polygons);
    entry.area = polygonsArea(entry.polygons);
  }
  const candidates = places.filter((entry) => entry.polygons.length)
    .sort((a, b) => b.depth - a.depth || a.area - b.area);
  return {
    places,
    byCode,
    candidates,
    pointOnly: [],
    problems: [],
    summary: `${places.length} places from a flat boundary file`,
    renamed: {},
  };
}

// Places holding observers, with every ancestor, as the chip rows and the map need
// them: counts are over the whole subtree, `inferredCount` the uplink-code members.
// `placements` is an iterable of { place, inferred }.
export function placeTree(resolved, placements) {
  const counts = new Map();
  for (const { place, inferred } of placements) {
    const entry = resolved.byCode.get(place);
    if (!entry) continue;
    for (const code of entry.path) {
      const tally = counts.get(code) || { count: 0, inferredCount: 0 };
      if (inferred) tally.inferredCount += 1;
      else tally.count += 1;
      counts.set(code, tally);
    }
  }
  const byName = comparePlaces(resolved);
  return resolved.places
    .filter((entry) => counts.has(entry.code))
    .map((entry) => ({
      code: entry.code,
      name: entry.name,
      parent: entry.parent,
      depth: entry.depth,
      level: entry.level || entry.kind || '',
      count: counts.get(entry.code).count,
      inferredCount: counts.get(entry.code).inferredCount,
      ...(resolved.expand?.has(entry.code) ? { expand: true } : {}),
      children: entry.children.filter((code) => counts.has(code))
        .map((code) => resolved.byCode.get(code)).sort(byName).map((child) => child.code),
    }))
    .sort((left, right) => left.depth - right.depth || byName(left, right));
}

// Everything a place's outline covers: its own shapes and every descendant's, once
// each. A tree outline can be narrower than its children (centralcoast lists three
// counties; slo sits under it), and the map must still draw the whole place.
// Only covered places contribute, so a place the coverage list reaches only in
// part (norcal, when only butte is listed) is drawn as that part: the map never
// outlines ground where an observer would not be shown.
export function placeOutlinePolygons(resolved, code) {
  const root = resolved.byCode.get(code);
  if (!root) return [];
  if (!resolved.shapes) return root.polygons;
  const ids = new Set();
  const stack = [root];
  while (stack.length) {
    const entry = stack.pop();
    if (entry.covered !== false) entry.shapeIds.forEach((id) => ids.add(id));
    entry.children.forEach((child) => stack.push(resolved.byCode.get(child)));
  }
  return [...ids].sort().flatMap((id) => resolved.shapes.get(id)?.polygons || []);
}
