'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const script = join(__dirname, 'fork-prepare-release-history.cjs');
function prepare(options) {
  assert.ok(existsSync(script), 'release history preparation script is required');
  return require(script).prepareReleaseHistory(options);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ocx-history-preparation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), repoRoot = join(root, 'checkout');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '--quiet', '--initial-branch=dev', source]);
  const commit = text => {
    writeFileSync(join(source, 'file'), text);
    git(source, 'add', 'file');
    git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', text);
    return git(source, 'rev-parse', 'HEAD');
  };
  const base = commit('base');
  git(source, 'checkout', '--quiet', '-b', 'stable', base);
  const stable = commit('stable');
  git(source, 'tag', 'v2.99.0', stable);
  git(source, 'checkout', '--quiet', '-b', 'preview', base);
  const preview = commit('preview');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'tag', '-a', 'v2.99.0-preview.20261108', preview, '-m', 'preview');
  git(source, 'checkout', '--quiet', 'dev');
  commit('candidate');
  execFileSync('git', ['clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--branch', 'dev', source, repoRoot]);
  const mappings = [
    { version: '2.99.0', legacySha: stable },
    { version: '2.99.0-preview.20261108', legacySha: preview },
  ];
  const has = sha => {
    try { return git(repoRoot, 'cat-file', '-t', sha) === 'commit'; } catch { return false; }
  };
  assert.equal(has(stable), false);
  assert.equal(has(preview), false);
  return { root, source, repoRoot, git, mappings, stable, preview, has };
}

test('fetches the exact missing legacy commits without changing checkout refs or FETCH_HEAD', t => {
  const f = fixture(t);
  const refs = f.git(f.repoRoot, 'for-each-ref', '--format=%(refname) %(objectname)');
  const head = f.git(f.repoRoot, 'rev-parse', 'HEAD');
  const fetchHead = join(f.repoRoot, '.git', 'FETCH_HEAD');
  const before = existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : null;
  prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings });
  assert.equal(f.has(f.stable), true);
  assert.equal(f.has(f.preview), true);
  assert.equal(f.git(f.repoRoot, 'for-each-ref', '--format=%(refname) %(objectname)'), refs);
  assert.equal(f.git(f.repoRoot, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(fetchHead) ? readFileSync(fetchHead, 'utf8') : null, before);
  assert.equal(f.git(f.repoRoot, 'rev-parse', '--is-shallow-repository'), 'false');
});

test('rejects a moved official tag before importing either missing commit', t => {
  const f = fixture(t);
  f.git(f.source, 'tag', '--force', 'v2.99.0', f.preview);
  assert.throws(() => prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings }), /tag.*mismatch/i);
  assert.equal(f.has(f.stable), false);
  assert.equal(f.has(f.preview), false);
});

test('does not access the source when the fixed commits already exist', t => {
  const f = fixture(t);
  prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings });
  rmSync(f.source, { recursive: true, force: true });
  assert.doesNotThrow(() => prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings }));
});

test('checks and fetches only missing commits', t => {
  const f = fixture(t);
  f.git(f.repoRoot, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', f.source, f.stable);
  f.git(f.source, 'tag', '--force', 'v2.99.0', f.preview);
  prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings });
  assert.equal(f.has(f.preview), true);
});

test('ignores inherited Git redirection and repository overrides', t => {
  const f = fixture(t);
  const changes = {
    GIT_DIR: join(f.root, 'wrong-repository'),
    GIT_OBJECT_DIRECTORY: join(f.root, 'wrong-objects'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${join(f.root, 'wrong-source')}.insteadOf`,
    GIT_CONFIG_VALUE_0: f.source,
  };
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  try {
    assert.doesNotThrow(() => prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings }));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(f.has(f.stable), true);
  assert.equal(f.has(f.preview), true);
});

test('ignores checkout-local URL rewriting when contacting the fixed source', t => {
  const f = fixture(t);
  f.git(f.repoRoot, 'config', `url.${join(f.root, 'wrong-source')}.insteadOf`, f.source);
  prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings });
  assert.equal(f.has(f.stable), true);
  assert.equal(f.has(f.preview), true);
});

test('reports temporary directory failures without exposing their paths', t => {
  const f = fixture(t);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(f.root, 'private-path-canary', 'missing');
  try {
    assert.throws(() => prepare({ repoRoot: f.repoRoot, officialUrl: f.source, mappings: f.mappings }), error => {
      assert.match(error.message, /release history preparation failed/);
      assert.doesNotMatch(error.message, /private-path-canary/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
});

test('reports an unavailable source without exposing its path', t => {
  const f = fixture(t);
  assert.throws(() => prepare({ repoRoot: f.repoRoot, officialUrl: join(f.root, 'private-source-canary'), mappings: f.mappings }), error => {
    assert.match(error.message, /read official tags/);
    assert.doesNotMatch(error.message, /private-source-canary/);
    return true;
  });
  assert.equal(f.has(f.stable), false);
  assert.equal(f.has(f.preview), false);
});
