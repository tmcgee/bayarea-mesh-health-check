// Version helpers shared by the server, the tests and the Docker tooling.
//
// From 1.0.0 the Bay Area fork numbers its own releases with SemVer and records
// the upstream release it is built on as build metadata:
//
//   1.0.0+upstream.1.3.8
//   ^         ^
//   |         +-- the yellowcooln/meshcore-health-check release merged in
//   +------------ this fork's release: major breaks setups, minor adds a
//                 feature, patch fixes
//
// Build metadata is ignored for precedence, so our own number alone orders
// releases while the base still says which upstream release to diff against.
// Releases before 1.0.0 were 1.3.8+bayarea.1 to 1.3.8+bayarea.22 (CHANGES.md).
//
// Docker image references accept only [A-Za-z0-9_][A-Za-z0-9_.-]{0,127} in a
// tag, so '+' is illegal there. dockerTag() maps the metadata separator to '-'
// for image tags only; package.json keeps the canonical SemVer string.

const DOCKER_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function dockerTag(version) {
  const tag = String(version || '').trim().replace(/\+/g, '-');
  if (!DOCKER_TAG_PATTERN.test(tag)) {
    throw new Error(`version "${version}" does not map to a legal Docker tag`);
  }
  return tag;
}

export function isLegalDockerTag(tag) {
  return DOCKER_TAG_PATTERN.test(String(tag || ''));
}

// The upstream release named in the build metadata, e.g. '1.3.8', or ''.
export function upstreamBase(version) {
  const match = String(version || '').match(/\+upstream\.(\d+\.\d+\.\d+)$/);
  return match ? match[1] : '';
}

export { DOCKER_TAG_PATTERN };
