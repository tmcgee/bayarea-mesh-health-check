// Passive evidence of which MeshCore routing scopes each repeater uses (bayarea.18).
//
// Two sources, both read from packets the in-area observers already publish:
//
// 1. Advert default scope. A node with `region default <name>` sends its own flood
//    adverts as transport packets carrying that scope's code. An advert heard with a
//    code shows the advertiser's default scope; one heard without a code shows no
//    default (or firmware older than scopes).
// 2. Forwarding. Every hop in the path of a scoped flood packet repeated it, so that
//    repeater allowed the scope (explicitly or through its `*` wildcard). Firmware
//    before v1.10 repeats scoped packets without checking, so this is evidence, not
//    proof. Hops are hash prefixes; candidates come from adverts heard here.
//
// Nothing here changes scoring. Names are public (CoreScope lists them).
import { recognizeMeshcoreScopeAnyType } from './meshcore-scopes.js';

export const SCOPE_EVIDENCE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = { retentionMs: 7 * DAY_MS, maxNodes: 4000, maxHops: 4000, cacheSize: 1024 };
const UNLISTED = '(unlisted)';
const ROLES = { 1: 'companion', 2: 'repeater', 3: 'room', 4: 'sensor' };

function scopeLabels(scope) {
  if (scope.state === 'known' || scope.state === 'ambiguous') return scope.names;
  if (scope.state === 'unknown') return [UNLISTED];
  return [];
}

function cleanScope(value) {
  const state = typeof value?.state === 'string' ? value.state : 'unavailable';
  const names = Array.isArray(value?.names) ? value.names.filter((name) => typeof name === 'string') : [];
  return { state, names };
}

export function createScopeEvidence(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const clock = settings.now || Date.now;
  const nodes = new Map(); // full public key -> advert evidence
  const hops = new Map(); // `${hashSize}:${hop}` -> forwarding evidence
  // One recognition per distinct packet, not per observer copy; also de-duplicates
  // forwarding credit so a packet heard by ten observers counts once per hop.
  const packetCache = new Map();

  function cachedRecognition(config, packet) {
    const cacheKey = `${packet.payloadType}:${packet.transportCodes?.[0]}:${packet.payloadBytes.toString('hex')}`;
    let entry = packetCache.get(cacheKey);
    if (entry) {
      packetCache.delete(cacheKey);
    } else {
      entry = { scope: recognizeMeshcoreScopeAnyType(config, packet), credited: new Set() };
      if (packetCache.size >= settings.cacheSize) {
        packetCache.delete(packetCache.keys().next().value);
      }
    }
    packetCache.set(cacheKey, entry);
    return entry;
  }

  function trim(map, max) {
    if (map.size <= max) return;
    const oldest = [...map.entries()].sort((a, b) => a[1].lastHeardAt - b[1].lastHeardAt);
    for (const [key] of oldest.slice(0, map.size - max)) map.delete(key);
  }

  // packet: parsePacketHex output. advert: { publicKey, name, role, timestamp } or null.
  // Returns true when stored evidence changed.
  function notePacket(config, packet, advert = null) {
    if (!packet?.payloadBytes?.length || packet.routeType == null) return false;
    const heardAt = clock();
    let changed = false;
    const hasCode = (packet.routeType === 0 || packet.routeType === 3)
      && Array.isArray(packet.transportCodes) && packet.transportCodes[0] !== 0;
    const recognition = hasCode ? cachedRecognition(config, packet) : null;
    const scope = recognition ? recognition.scope : { state: 'unscoped', names: [] };

    if (advert?.publicKey && packet.payloadType === 4) {
      const key = advert.publicKey;
      const node = nodes.get(key) || {
        key, name: null, role: null, firstHeardAt: heardAt, lastHeardAt: heardAt,
        advertScope: null, advertScopeAt: null, scopedAdverts: 0, unscopedAdverts: 0, lastAdvertTimestamp: null,
      };
      if (advert.name) node.name = advert.name;
      if (advert.role) node.role = advert.role;
      node.lastHeardAt = heardAt;
      // Count each advert once, however many observers hear it.
      if (advert.timestamp == null || advert.timestamp !== node.lastAdvertTimestamp) {
        node.lastAdvertTimestamp = advert.timestamp ?? null;
        if (hasCode) node.scopedAdverts += 1;
        else node.unscopedAdverts += 1;
        node.advertScope = scope;
        node.advertScopeAt = heardAt;
      } else if (hasCode && node.advertScope?.state === 'unscoped') {
        // A copy of the same advert with a code outranks one without (a pre-scope
        // repeater may strip nothing, but a zero-hop copy can arrive first).
        node.advertScope = scope;
      }
      nodes.set(key, node);
      trim(nodes, settings.maxNodes);
      changed = true;
    }

    // Forwarding evidence: flood paths only; a direct packet's path is its route, not
    // the repeaters that already forwarded it.
    if (recognition && packet.routeType === 0 && Array.isArray(packet.path) && packet.path.length) {
      const labels = scopeLabels(scope);
      for (const hop of packet.path) {
        const hopKey = `${packet.pathHashSize || 1}:${hop}`;
        if (!labels.length || recognition.credited.has(hopKey)) continue;
        recognition.credited.add(hopKey);
        const entry = hops.get(hopKey) || {
          hop, hashSize: packet.pathHashSize || 1, firstHeardAt: heardAt, lastHeardAt: heardAt, scopes: {},
        };
        entry.lastHeardAt = heardAt;
        for (const label of labels) {
          const item = entry.scopes[label] || { packets: 0, ambiguous: 0, lastHeardAt: heardAt };
          item.packets += 1;
          if (scope.state === 'ambiguous') item.ambiguous += 1;
          item.lastHeardAt = heardAt;
          entry.scopes[label] = item;
        }
        hops.set(hopKey, entry);
        changed = true;
      }
      trim(hops, settings.maxHops);
    }
    return changed;
  }

  function prune(now = clock()) {
    let removed = 0;
    for (const map of [nodes, hops]) {
      for (const [key, entry] of map) {
        if (now - entry.lastHeardAt > settings.retentionMs) {
          map.delete(key);
          removed += 1;
        }
      }
    }
    return removed;
  }

  function candidatesForHop(hop) {
    const matches = [];
    for (const node of nodes.values()) {
      if (node.key.startsWith(hop) && node.role !== 'companion') {
        matches.push({ key: node.key, name: node.name, role: node.role });
      }
    }
    return matches;
  }

  function view({ includeUnscoped = false, isExcludedKey = () => false } = {}) {
    prune();
    const all = [...nodes.values()].filter((node) => !isExcludedKey(node.key));
    const scoped = all.filter((node) => node.scopedAdverts > 0);
    const listed = (includeUnscoped ? all : scoped)
      .sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key)))
      .map((node) => ({
        key: node.key,
        name: node.name,
        role: node.role,
        advertScope: cleanScope(node.advertScope),
        scopedAdverts: node.scopedAdverts,
        unscopedAdverts: node.unscopedAdverts,
        firstHeardAt: node.firstHeardAt,
        lastHeardAt: node.lastHeardAt,
      }));
    const forwarders = [...hops.values()]
      .sort((a, b) => b.lastHeardAt - a.lastHeardAt)
      .map((entry) => {
        const candidates = candidatesForHop(entry.hop).filter((item) => !isExcludedKey(item.key));
        return {
          hop: entry.hop,
          hashSize: entry.hashSize,
          candidates: candidates.slice(0, 8),
          candidateCount: candidates.length,
          scopes: Object.fromEntries(Object.entries(entry.scopes).map(([name, item]) => [name, { ...item }])),
          firstHeardAt: entry.firstHeardAt,
          lastHeardAt: entry.lastHeardAt,
        };
      });
    return {
      retentionDays: Math.round(settings.retentionMs / DAY_MS),
      advertisers: all.length,
      scopedAdvertisers: scoped.length,
      nodes: listed,
      forwarders,
    };
  }

  function serialize() {
    return {
      version: SCOPE_EVIDENCE_VERSION,
      nodes: [...nodes.values()].map((node) => ({ ...node, advertScope: cleanScope(node.advertScope) })),
      hops: [...hops.values()].map((entry) => ({ ...entry, scopes: { ...entry.scopes } })),
    };
  }

  function restore(value) {
    nodes.clear();
    hops.clear();
    packetCache.clear();
    if (!value || value.version !== SCOPE_EVIDENCE_VERSION) return;
    const number = (input) => (Number.isFinite(Number(input)) ? Number(input) : 0);
    for (const raw of Array.isArray(value.nodes) ? value.nodes : []) {
      if (typeof raw?.key !== 'string' || !/^[0-9A-F]{64}$/.test(raw.key)) continue;
      nodes.set(raw.key, {
        key: raw.key,
        name: typeof raw.name === 'string' ? raw.name : null,
        role: Object.values(ROLES).includes(raw.role) ? raw.role : null,
        firstHeardAt: number(raw.firstHeardAt),
        lastHeardAt: number(raw.lastHeardAt),
        advertScope: raw.advertScope ? cleanScope(raw.advertScope) : null,
        advertScopeAt: raw.advertScopeAt == null ? null : number(raw.advertScopeAt),
        scopedAdverts: number(raw.scopedAdverts),
        unscopedAdverts: number(raw.unscopedAdverts),
        lastAdvertTimestamp: raw.lastAdvertTimestamp == null ? null : number(raw.lastAdvertTimestamp),
      });
    }
    for (const raw of Array.isArray(value.hops) ? value.hops : []) {
      if (typeof raw?.hop !== 'string' || !/^[0-9A-F]{2,6}$/.test(raw.hop)) continue;
      const hashSize = [1, 2, 3].includes(raw.hashSize) ? raw.hashSize : 1;
      const scopes = {};
      for (const [name, item] of Object.entries(raw.scopes || {})) {
        scopes[name] = { packets: number(item?.packets), ambiguous: number(item?.ambiguous), lastHeardAt: number(item?.lastHeardAt) };
      }
      hops.set(`${hashSize}:${raw.hop}`, {
        hop: raw.hop, hashSize, firstHeardAt: number(raw.firstHeardAt), lastHeardAt: number(raw.lastHeardAt), scopes,
      });
    }
    prune();
  }

  // Cheap enough for every snapshot: no hop-candidate search.
  function summary({ isExcludedKey = () => false } = {}) {
    const now = clock();
    const live = (entry) => now - entry.lastHeardAt <= settings.retentionMs;
    const kept = [...nodes.values()].filter((node) => live(node) && !isExcludedKey(node.key));
    return {
      retentionDays: Math.round(settings.retentionMs / DAY_MS),
      advertisers: kept.length,
      scopedAdvertisers: kept.filter((node) => node.scopedAdverts > 0).length,
      forwarderHops: [...hops.values()].filter(live).length,
    };
  }

  return { notePacket, prune, view, summary, serialize, restore, size: () => ({ nodes: nodes.size, hops: hops.size }) };
}

export function advertRoleName(deviceRole) {
  return ROLES[deviceRole] || null;
}
