// A minimal matkam/meshcore-settings regions.json tree (format 2) for tests that need a
// scope file with chosen names: no root chain, one flat place per name, in order.
export function scopeTree(names, extra = {}) {
  return { format: 2, root: [], places: names.map((code) => ({ code })), ...extra };
}

export function scopeTreeText(names, extra) {
  return JSON.stringify(scopeTree(names, extra));
}
