// Version helpers shared by the server, the tests and the Docker tooling.
//
// The Bay Area fork keeps the upstream release it is based on in the version
// string and appends its own build identity as SemVer build metadata:
//
//   1.3.8+bayarea.1
//    ^     ^
//    |     +-- fork build, bumped per Bay Area release
//    +-------- the upstream yellowcooln/meshcore-health-check release merged in
//
// Build metadata is ignored for precedence, which is the point: the number still
// says which upstream release to diff against. A hyphenated pre-release
// (1.3.8-bayarea.1) would sort BELOW plain 1.3.8, which is backwards.
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

export { DOCKER_TAG_PATTERN };
