// Shared-border simplification for the map's place outlines (1.2.0).
//
// Each place is dissolved into one outline first (server.js dissolveRings), and
// the outlines then have to be thinned for the wire. Thinning each outline on its
// own (Douglas-Peucker per ring) lets two neighbours keep different vertices
// along the border they share, so at a coarse tolerance their strokes would part
// or cross by up to the tolerance. Here every ring of every outline is thinned
// together, TopoJSON-style:
//
//   1. A vertex is a junction where the rings through it disagree about its
//      neighbours: where a border stops being shared, or three places meet.
//   2. Each ring is cut at its junctions into runs. A run two outlines share is
//      the same vertex sequence in both (dissolving only deletes vertices), walked
//      forwards in one and backwards in the other.
//   3. Each run is put in a canonical direction, thinned, and turned back, so
//      both owners get the identical thinned run and the border stays one line.
//
// A ring with no junction (an island, or an outline identical to another) is
// anchored at its smallest vertex, which every copy of it agrees on. A ring that
// would thin to fewer than three distinct points is kept as it was: it is smaller
// than the tolerance, so it costs almost nothing.

const pointKey = (point) => `${point[0]},${point[1]}`;

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Douglas-Peucker over an open run, iterative so a long coastline cannot
// overflow the stack. Both ends are kept.
function simplifyRun(run, tolerance) {
  if (run.length <= 2) return run;
  const keep = new Uint8Array(run.length);
  keep[0] = 1;
  keep[run.length - 1] = 1;
  const stack = [[0, run.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = run[first];
    const [bx, by] = run[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    let farthest = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = run[i];
      const distance = length === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (distance > farthest) {
        farthest = distance;
        index = i;
      }
    }
    if (index !== -1 && farthest > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return run.filter((_, i) => keep[i]);
}

// A closed ring as its distinct vertices in order: no closing repeat and no
// consecutive duplicates.
function openRing(ring) {
  const points = [];
  for (const point of ring) {
    if (!points.length || pointKey(points[points.length - 1]) !== pointKey(point)) points.push(point);
  }
  if (points.length > 1 && pointKey(points[0]) === pointKey(points[points.length - 1])) points.pop();
  return points;
}

// The junctions across every ring: vertices whose neighbour pair differs
// between the rings (or the visits) that pass through them.
function findJunctions(rings) {
  const neighbours = new Map();
  const junctions = new Set();
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i += 1) {
      const key = pointKey(ring[i]);
      const prev = pointKey(ring[(i - 1 + n) % n]);
      const next = pointKey(ring[(i + 1) % n]);
      const pair = prev < next ? `${prev}|${next}` : `${next}|${prev}`;
      const known = neighbours.get(key);
      if (known === undefined) neighbours.set(key, pair);
      else if (known !== pair) junctions.add(key);
    }
  }
  return junctions;
}

function simplifyRing(ring, junctions, tolerance) {
  const n = ring.length;
  const keys = ring.map(pointKey);
  let cuts = [];
  for (let i = 0; i < n; i += 1) if (junctions.has(keys[i])) cuts.push(i);
  if (cuts.length === 0) {
    let smallest = 0;
    for (let i = 1; i < n; i += 1) if (keys[i] < keys[smallest]) smallest = i;
    cuts = [smallest];
  }
  const out = [];
  for (let c = 0; c < cuts.length; c += 1) {
    const start = cuts[c];
    const end = cuts[(c + 1) % cuts.length];
    const run = [ring[start]];
    for (let i = (start + 1) % n; ; i = (i + 1) % n) {
      run.push(ring[i]);
      if (i === end) break;
    }
    // Canonical direction: by end keys, then (for a run that closes on itself)
    // by the keys next to the ends.
    const order = compareKeys(pointKey(run[0]), pointKey(run[run.length - 1]))
      || compareKeys(pointKey(run[1]), pointKey(run[run.length - 2]));
    const thinned = order > 0
      ? simplifyRun([...run].reverse(), tolerance).reverse()
      : simplifyRun(run, tolerance);
    out.push(...thinned.slice(0, -1));
  }
  out.push(out[0]);
  return out.length >= 4 ? out : null;
}

// geometries: one MultiPolygon coordinate array per outline. Returns the same
// shape, every ring thinned to within `tolerance` (degrees) and closed.
export function simplifySharedOutlines(geometries, tolerance) {
  const opened = geometries.map((polygons) => polygons.map((rings) => rings.map(openRing)));
  const all = opened.flatMap((polygons) => polygons.flatMap((rings) => rings)).filter((ring) => ring.length >= 3);
  const junctions = findJunctions(all);
  return opened.map((polygons, g) => polygons.map((rings, p) => rings.map((ring, r) => {
    const original = geometries[g][p][r];
    if (ring.length < 3) return original;
    return simplifyRing(ring, junctions, tolerance) || original;
  })));
}
