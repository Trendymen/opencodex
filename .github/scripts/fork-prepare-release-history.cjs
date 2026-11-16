'use strict';

const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { devNull, tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { LEGACY_MAPPINGS } = require('./release-history.cjs');

const OFFICIAL_URL = 'https://github.com/lidge-jun/opencodex.git';
const REPO_ROOT = resolve(__dirname, '../..');
const SHA = /^[a-f0-9]{40}$/;

function gitEnvironment() {
  const env = {};
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull };
}

function runGit(args, env, stage, input) {
  const result = spawnSync('git', ['--no-lazy-fetch', '-c', 'credential.helper=', '-c', 'http.extraHeader=',
    '-c', 'http.followRedirects=false', ...args], {
    env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`release history preparation failed: ${stage}`);
  return result.stdout.trim();
}

function prepareReleaseHistory({ repoRoot = REPO_ROOT, officialUrl = OFFICIAL_URL, mappings = LEGACY_MAPPINGS } = {}) {
  const env = gitEnvironment();
  if (!Array.isArray(mappings) || mappings.some(item => !/^\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(item.version) || !SHA.test(item.legacySha))) {
    throw new Error('release history preparation failed: invalid fixed mapping');
  }
  if (!mappings.length) return;
  const output = runGit(['-C', repoRoot, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], env,
    'read local object', mappings.map(({ legacySha }) => legacySha).join('\n') + '\n').split('\n');
  if (output.length !== mappings.length) throw new Error('release history preparation failed: invalid object response');
  const missing = mappings.filter(({ legacySha }, index) => {
    if (![`${legacySha} commit`, `${legacySha} missing`].includes(output[index])) {
      throw new Error('release history preparation failed: invalid object type');
    }
    return output[index] === `${legacySha} missing`;
  });
  if (!missing.length) return;

  let root;
  try { root = mkdtempSync(join(tmpdir(), 'ocx-release-history-')); }
  catch { throw new Error('release history preparation failed: create temporary directory'); }
  try {
    const bare = join(root, 'source.git');
    runGit(['init', '--bare', '--quiet', '--template=', bare], env, 'initialize verifier');
    const refs = missing.flatMap(({ version }) => [`refs/tags/v${version}`, `refs/tags/v${version}^{}`]);
    const remoteRefs = runGit([`--git-dir=${bare}`, 'ls-remote', '--tags', officialUrl, ...refs], env, 'read official tags');
    const entries = new Map();
    for (const line of remoteRefs.split('\n')) {
      const match = /^([a-f0-9]{40})\t(refs\/tags\/[^\s]+)$/.exec(line);
      if (!match || entries.has(match[2])) throw new Error('release history preparation failed: invalid tag response');
      entries.set(match[2], match[1]);
    }
    for (const { version, legacySha } of missing) {
      const ref = `refs/tags/v${version}`, raw = entries.get(ref), peeled = entries.get(`${ref}^{}`);
      if (!raw || (peeled ?? raw) !== legacySha) throw new Error('release history preparation failed: official tag mismatch');
    }

    const objectDir = runGit(['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], env, 'resolve object directory');
    const head = runGit(['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], env, 'read checkout head');
    if (!SHA.test(head)) throw new Error('release history preparation failed: invalid checkout head');
    const objectEnv = { ...env, GIT_OBJECT_DIRECTORY: objectDir };
    runGit([`--git-dir=${bare}`, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
      '--no-auto-maintenance', `--negotiation-tip=${head}`, officialUrl,
      ...missing.map(item => item.legacySha)], objectEnv, 'fetch fixed history');
    for (const { legacySha } of missing) {
      if (runGit(['-C', repoRoot, 'cat-file', '-t', legacySha], env, 'verify imported object') !== 'commit') {
        throw new Error('release history preparation failed: invalid imported object');
      }
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { throw new Error('release history preparation failed: cleanup temporary directory'); }
  }
}

if (require.main === module) {
  try { prepareReleaseHistory(); }
  catch (error) {
    const message = typeof error?.message === 'string' && /^release history preparation failed: [a-z ]+$/.test(error.message)
      ? error.message : 'release history preparation failed: unexpected error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
module.exports = { prepareReleaseHistory };
