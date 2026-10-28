// Regional test channels (bayarea.19).
//
// #healthcheck stays the promoted channel. For a regions test, a user sends the code to
// #<region>-healthcheck instead (#slo-healthcheck), where <region> is one of the scope
// names from MESHCORE_REGION_SCOPES_FILE. The server cannot read a channel it has no
// name for (a packet carries only a 1-byte hash of the key), so every valid name is
// built here in advance: hashtag key = sha256("#name") truncated to 16 bytes.
//
// Decryption reuses the server's GroupText path; only a MAC-valid candidate is accepted,
// which also settles the few names that share a hash byte.
//
// The region in the channel name is the scope the user meant to send under. Whether the
// copies were heard under it is compareIntendedScope's job. The name does not set the
// scope; the user picks that in the companion app.
import { createHash } from 'node:crypto';

const hashtagSecret = (label) => createHash('sha256').update(label).digest().subarray(0, 16);
const channelHash = (secret) => createHash('sha256').update(secret).digest().subarray(0, 1).toString('hex');

// scopeNames: stored form with the leading '#' ('#slo'). baseName: TEST_CHANNEL_NAME.
export function buildRegionalChannels(scopeNames, baseName) {
  const base = String(baseName || '').trim().toLowerCase().replace(/^#/, '');
  const byHash = new Map();
  const byName = new Map();
  if (!base) return { byHash, byName, names: [] };
  for (const scope of scopeNames || []) {
    const region = String(scope).replace(/^#/, '').toLowerCase();
    if (!region) continue;
    const name = `${region}-${base}`;
    if (byName.has(name)) continue;
    const secret = hashtagSecret(`#${name}`);
    const hmacKey = Buffer.alloc(32);
    secret.copy(hmacKey);
    const entry = { name, scope: String(scope).startsWith('#') ? String(scope) : `#${scope}`, hash: channelHash(secret), aesKey: secret, hmacKey };
    byName.set(name, entry);
    if (!byHash.has(entry.hash)) byHash.set(entry.hash, []);
    byHash.get(entry.hash).push(entry);
  }
  return { byHash, byName, names: [...byName.keys()] };
}

// Each receipt (one per observer) carries the scope states of its copies. Every copy is
// put in one bucket; the verdict covers the whole code.
//   as-intended  known, and the name is the intended scope
//   ambiguous    ambiguous, and the intended scope is one of the candidates
//   unscoped     no scope at all
//   other        a different listed scope, or a scope not in the list
//   unrecorded   no scope recorded for the copy (older receipts, decode failures)
export function compareIntendedScope(intended, receipts) {
  if (!intended) return null;
  const counts = { asIntended: 0, ambiguous: 0, unscoped: 0, other: 0, unrecorded: 0 };
  const otherNames = new Set();
  for (const receipt of receipts || []) {
    const scopes = Array.isArray(receipt?.meshcoreScopes) && receipt.meshcoreScopes.length
      ? receipt.meshcoreScopes
      : [{ state: 'not-present', names: [] }];
    for (const scope of scopes) {
      const names = Array.isArray(scope?.names) ? scope.names : [];
      if (scope?.state === 'known' && names[0] === intended) counts.asIntended += 1;
      else if (scope?.state === 'ambiguous' && names.includes(intended)) counts.ambiguous += 1;
      else if (scope?.state === 'unscoped') counts.unscoped += 1;
      else if (scope?.state === 'known' || scope?.state === 'ambiguous') {
        counts.other += 1;
        for (const name of names) otherNames.add(name);
      } else if (scope?.state === 'unknown' || scope?.state === 'disabled') {
        counts.other += 1;
        otherNames.add('(unlisted)');
      } else counts.unrecorded += 1;
    }
  }
  const matched = counts.asIntended + counts.ambiguous;
  const missed = counts.unscoped + counts.other;
  let verdict = 'waiting';
  if (matched && !missed) verdict = 'as-intended';
  else if (matched && missed) verdict = 'mixed';
  else if (missed) verdict = 'not-as-intended';
  else if (counts.unrecorded) verdict = 'unrecorded';
  return { intended, verdict, counts, otherNames: [...otherNames].sort() };
}
