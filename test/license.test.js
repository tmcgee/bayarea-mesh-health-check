// Attribution guard (+bayarea.23): upstream added MIT on 2026-10-29 (e9017b4).
// Its copyright line and notice must travel with this fork, and so must
// matkam/meshcore-settings' for the scope names and fixture.
import './support/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

test('LICENSE keeps upstream MIT copyright and adds the fork', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License\n/);
  assert.match(license, /^Copyright \(c\) 2026 yellowcooln and contributors$/m);
  assert.match(license, /^Copyright \(c\) 2026 Tim McGee \(Bay Area changes\)$/m);
  assert.match(license, /The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
});

test('package metadata names the license and this repository', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'git+https://gitlab.com/tmcgee/bayarea-mesh-health-check.git');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages[''].license, 'MIT');
});

test('NOTICE credits upstream and carries matkam\'s MIT notice', () => {
  const notice = read('NOTICE.md');
  assert.match(notice, /yellowcooln\/meshcore-health-check/);
  assert.match(notice, /Copyright \(c\) 2026 matkam/);
  assert.match(notice, /> The above copyright notice and this permission notice shall be included in all/);
  assert.match(read('README.md'), /\[LICENSE\]\(LICENSE\)/);
});

test('upstream funding and Dependabot config stay out of the fork', () => {
  // The GitHub mirror would show upstream's Sponsor button and Dependabot
  // would open PRs against a dev branch that does not exist here.
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'FUNDING.yml')), false);
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'dependabot.yml')), false);
});
