#!/usr/bin/env node
// Read-only drift check for the MeshCore scope names (+bayarea.22).
//
// regions/us-ca-meshcore-scopes.json is matkam/meshcore-settings data/regions.json at
// PINNED_COMMIT, byte for byte (1.1.0; it was a flattened copy of the codes before). This
// script fetches that file twice from GitHub, at the pinned commit and at a ref (default
// `main`), and reports:
//   1. whether the shipped file is still byte-identical to the pinned file;
//   2. codes added, removed or probably renamed between the two commits;
//   3. codes kept but moved, re-outlined or renamed in display, which can leave the
//      app's coverage list (regions/region-overrides.json) or, in the 1.1.0 mode,
//      its region groups (regions/us-ca-bay-area.geojson) out of step.
//
// It never writes a file, never changes the app, sends no credentials, and is not run
// by the server, `npm test` or the smoke suite. Updating the list stays a reviewed change.
//
//   npm run check:scopes                 compare the pin with main
//   npm run check:scopes -- --ref <sha>  compare the pin with another ref
//   npm run check:scopes -- --json       machine-readable report
//
// Exit codes: 0 no drift, 1 drift found, 2 the check itself failed (network, format).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenTree } from '../lib/meshcore-scopes.js';

export { flattenTree };

export const REPO = 'matkam/meshcore-settings';
export const REPO_PATH = 'data/regions.json';
export const PINNED_COMMIT = '7ec46658920c0166a2398b841cd78d4c7f18b432';
// SHA-256 of data/regions.json at PINNED_COMMIT, so the offline test can tell the shipped
// file is still that file byte for byte without fetching it.
export const PINNED_SHA256 = '29283fdd87576b543321f634f1b2f96cea291cfe0bf8faf8872883b519f0e614';
export const KNOWN_FORMAT = 2;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15000;

const here = dirname(fileURLToPath(import.meta.url));
export const SHIPPED_FILE = join(here, '..', 'regions', 'us-ca-meshcore-scopes.json');

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const describe = (entry) => `${entry.code} (${entry.name || 'no name'}${entry.parent ? `, under ${entry.parent}` : ''})`;

// Pure comparison; no I/O. `shipped` is the shipped file's text, `pinned` and `current`
// are parsed regions.json documents and `pinnedText` the pinned file's text.
export function compareScopes({ shipped, pinned, current, pinnedText }) {
  const pinnedEntries = flattenTree(pinned);
  const currentEntries = flattenTree(current);
  const pinnedCodes = pinnedEntries.map((entry) => entry.code);
  const currentCodes = currentEntries.map((entry) => entry.code);
  const shippedNames = flattenTree(JSON.parse(shipped)).map((entry) => entry.code);
  const shippedIdentical = shipped === pinnedText;

  const pinnedByCode = new Map(pinnedEntries.map((entry) => [entry.code, entry]));
  const currentByCode = new Map(currentEntries.map((entry) => [entry.code, entry]));
  let removed = pinnedEntries.filter((entry) => !currentByCode.has(entry.code));
  let added = currentEntries.filter((entry) => !pinnedByCode.has(entry.code));

  // A removed and an added code with the same non-empty outline is most likely a rename.
  const renamed = [];
  for (const old of [...removed]) {
    if (!old.outline.length) continue;
    const match = added.find((entry) => sameList(entry.outline, old.outline));
    if (!match) continue;
    renamed.push({ from: old.code, to: match.code, fromName: old.name, toName: match.name, outline: old.outline });
    removed = removed.filter((entry) => entry !== old);
    added = added.filter((entry) => entry !== match);
  }

  const changed = [];
  for (const entry of currentEntries) {
    const old = pinnedByCode.get(entry.code);
    if (!old) continue;
    const fields = [];
    if (old.parent !== entry.parent) fields.push({ field: 'parent', from: old.parent, to: entry.parent });
    if (old.name !== entry.name) fields.push({ field: 'name', from: old.name, to: entry.name });
    if (old.kind !== entry.kind) fields.push({ field: 'kind', from: old.kind, to: entry.kind });
    if (!sameList(old.outline, entry.outline)) {
      fields.push({
        field: 'outline',
        gained: entry.outline.filter((county) => !old.outline.includes(county)),
        lost: old.outline.filter((county) => !entry.outline.includes(county)),
      });
    }
    if (fields.length) changed.push({ code: entry.code, fields });
  }

  const shippedMatchesPin = shippedIdentical;
  const order = !added.length && !removed.length && !renamed.length && !sameList(pinnedCodes, currentCodes);
  const formats = { pinned: pinned.format, current: current.format };
  const formatChanged = current.format !== KNOWN_FORMAT;
  const drift = !shippedMatchesPin || formatChanged || order
    || added.length > 0 || removed.length > 0 || renamed.length > 0 || changed.length > 0;
  return {
    drift,
    shippedMatchesPin,
    shippedOnly: shippedNames.filter((name) => !pinnedCodes.includes(name)),
    pinOnly: pinnedCodes.filter((code) => !shippedNames.includes(code)),
    counts: { shipped: shippedNames.length, pinned: pinnedCodes.length, current: currentCodes.length },
    formats,
    formatChanged,
    updated: { pinned: pinned.updated ?? null, current: current.updated ?? null },
    added: added.map(describe),
    removed: removed.map(describe),
    renamed,
    changed,
    orderChanged: order,
  };
}

export function formatReport(report, { pinnedRef, currentRef }) {
  const lines = [];
  const short = (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref);
  lines.push(`Scope names: ${REPO} ${REPO_PATH}, pinned ${short(pinnedRef)} vs ${short(currentRef)}`);
  lines.push(`  counts: shipped ${report.counts.shipped}, pinned ${report.counts.pinned}, current ${report.counts.current}`);
  lines.push(`  file dated: pinned ${report.updated.pinned ?? '?'}, current ${report.updated.current ?? '?'}`);
  lines.push(report.shippedMatchesPin
    ? '  shipped file is byte-identical to the pinned file'
    : `  shipped file differs from the pin: only shipped [${report.shippedOnly.join(', ')}], only pinned [${report.pinOnly.join(', ')}]`);
  if (report.formatChanged) {
    lines.push(`  format is ${report.formats.current}, not ${KNOWN_FORMAT}: the comparison below may be incomplete`);
  }
  for (const entry of report.added) lines.push(`  added    ${entry}`);
  for (const entry of report.removed) lines.push(`  removed  ${entry}`);
  for (const entry of report.renamed) {
    lines.push(`  renamed? ${entry.from} -> ${entry.to} (same outline: ${entry.outline.join(', ')})`);
  }
  for (const entry of report.changed) {
    const parts = entry.fields.map((change) => (change.field === 'outline'
      ? `outline +[${change.gained.join(', ')}] -[${change.lost.join(', ')}]`
      : `${change.field} '${change.from}' -> '${change.to}'`));
    lines.push(`  changed  ${entry.code}: ${parts.join('; ')}`);
  }
  if (report.orderChanged) lines.push('  same codes, different order');
  lines.push(report.drift
    ? 'Drift found. Nothing was changed; updating the shipped list is a reviewed release.'
    : 'No drift.');
  return lines.join('\n');
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'bayarea-mesh-health-check scope drift check', Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error(`${url}: larger than ${MAX_BYTES} bytes`);
  return text;
}

// Resolve a branch or tag to a commit so the report names exactly what it compared.
// Unauthenticated public API; on failure fall back to the ref as given.
async function resolveRef(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  try {
    const body = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`));
    if (typeof body.sha === 'string') return body.sha;
  } catch {
    // Unauthenticated calls are limited to 60 an hour per IP; the raw file still loads.
  }
  process.stderr.write(`note: could not resolve ${ref} to a commit (GitHub API unavailable); comparing the ref as given\n`);
  return ref;
}

async function fetchTree(ref) {
  const text = await fetchText(`https://raw.githubusercontent.com/${REPO}/${ref}/${REPO_PATH}`);
  try {
    return { doc: JSON.parse(text), text };
  } catch {
    throw new Error(`${REPO_PATH} at ${ref} is not valid JSON`);
  }
}

function parseArgs(argv) {
  const options = { ref: 'main', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--ref' && argv[index + 1]) options.ref = argv[++index];
    else if (arg.startsWith('--ref=')) options.ref = arg.slice(6);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(options.ref)) throw new Error('ref must be a branch, tag or commit');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shipped = readFileSync(SHIPPED_FILE, 'utf8');
  const currentRef = await resolveRef(options.ref);
  const [pinned, current] = await Promise.all([fetchTree(PINNED_COMMIT), fetchTree(currentRef)]);
  const report = compareScopes({ shipped, pinned: pinned.doc, current: current.doc, pinnedText: pinned.text });
  const refs = { pinnedRef: PINNED_COMMIT, currentRef };
  process.stdout.write(options.json
    ? `${JSON.stringify({ ...refs, ...report }, null, 2)}\n`
    : `${formatReport(report, refs)}\n`);
  return report.drift ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`check:scopes failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
