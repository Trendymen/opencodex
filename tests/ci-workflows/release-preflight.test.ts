/**
 * The release preflight, asserted by shape and by execution.
 *
 * Run 35783865160 packaged 2.62.0 for nineteen minutes and then failed its ordering gate in
 * `publish` on `v2.63.0-preview.20260923`, a tag that already existed when the run's first job
 * started: the workflow-level `release` concurrency group had held the stable run until the
 * preview run finished. The runs were serialised; the check sat in the wrong place. These cases pin
 * the `preflight` job in front of every packaging job, keep the publish-job gate as the final
 * check, pin the shared concurrency group that makes the early answer trustworthy, and execute
 * `scripts/ci/release-preflight.sh` against a real tag set with fake `gh` and `npm`.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; permissions?: Record<string, string>; steps?: Step[]; "runs-on"?: string };
type Workflow = { concurrency?: { group?: string; "cancel-in-progress"?: boolean }; jobs?: Record<string, Job | undefined> };

const release = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "release.yml"), "utf8")) as Workflow;
const needsOf = (job: Job | undefined): string[] =>
  job?.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs;
const PREFLIGHT = repoPath("scripts", "ci", "release-preflight.sh");

describe("the release preflight job", () => {
  const preflight = release.jobs?.preflight;

  test("runs after dispatch validation with read-only permissions", () => {
    expect(needsOf(preflight)).toEqual(["validate-dispatch"]);
    expect(preflight?.permissions).toEqual({ contents: "read" });
    expect(preflight?.["runs-on"]).toBe("ubuntu-latest");
  });

  test("gates every packaging job", () => {
    for (const name of ["package-standalone", "package-desktop"]) {
      expect(`${name}:${needsOf(release.jobs?.[name]).includes("preflight")}`).toBe(`${name}:true`);
    }
  });

  test("runs the preflight script with dispatch inputs passed through env", () => {
    const step = (preflight?.steps ?? []).find(candidate => candidate.run?.includes("scripts/ci/release-preflight.sh"));
    expect(step?.run?.trim()).toBe("bash scripts/ci/release-preflight.sh");
    expect(step?.env).toMatchObject({
      RELEASE_VERSION: "${{ inputs.version }}",
      NPM_DIST_TAG: "${{ inputs.tag }}",
      DRY_RUN: "${{ inputs.dry-run }}",
      RESUME: "${{ inputs.resume-after-npm-publish }}",
    });
    // The script reads origin/dev and the tag set; both must be present in the checkout.
    const checkout = (preflight?.steps ?? []).find(candidate => candidate.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-tags"]).toBe(true);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect((preflight?.steps ?? []).some(candidate => candidate.run?.includes("+refs/heads/dev:refs/remotes/origin/dev"))).toBe(true);
  });

  test("leaves the publish-time ordering gate in place as the final check", () => {
    const steps = release.jobs?.publish?.steps ?? [];
    const ordering = steps.find(step => step.name === "Refuse a release the current tag set already outranks");
    const publish = steps.find(step => step.name === "Publish (or dry-run)");
    expect(ordering?.run).toContain("assert-releasable");
    expect(steps.indexOf(ordering!)).toBeLessThan(steps.indexOf(publish!));
  });

  test("keeps one release slot shared by every ref", () => {
    // A constant group is what serialised the stable run behind the preview one. A per-ref group
    // would let a main and a preview release run at once, and then no early check could be final.
    expect(release.concurrency?.group).toBe("release");
    expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

type Scenario = {
  version?: string;
  ref?: string;
  distTag?: string;
  tags?: string[];
  devVersion?: string | null;
  npm?: "absent" | "present" | "unreadable";
  githubRelease?: boolean;
  dryRun?: boolean;
  resume?: boolean;
};

// The official release script accepts stable and preview versions, while a Fork checkout may
// carry a ben.N package version. Exercise a copied script against matching fixture version sources.
const manifest = JSON.parse(readFileSync(repoPath("package.json"), "utf8")) as { name: string; version: string };
const OWN_VERSION = manifest.version.replace(/-ben\.[1-9]\d*$/, "");
const [MAJOR, MINOR] = OWN_VERSION.split(/[.-]/).map(Number) as [number, number];
const OWN_IS_PREVIEW = OWN_VERSION.includes("-preview.");
const OWN_REF = OWN_IS_PREVIEW ? "refs/heads/preview" : "refs/heads/main";
const OWN_TAG = OWN_IS_PREVIEW ? "preview" : "latest";
const NEXT_CORE = `${MAJOR}.${MINOR + 1}.0`;

const FAKE_GH = [
  "#!/bin/sh",
  '[ "$FIXTURE_GH_RELEASE" = "yes" ] && exit 0',
  'echo "release not found" >&2',
  "exit 1",
  "",
].join("\n");
const FAKE_NPM = [
  "#!/bin/sh",
  'case "$FIXTURE_NPM" in',
  '  present) echo "$RELEASE_VERSION" ;;',
  '  unreadable) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;',
  '  *) echo "npm error code E404" >&2; exit 1 ;;',
  "esac",
  "",
].join("\n");

function run(cwd: string, env: Record<string, string>, ...command: string[]): string {
  const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function preflight(scenario: Scenario): { status: number | null; output: string; summary: string } {
  const directory = mkdtempSync(join(tmpdir(), "ocx-release-preflight-"));
  try {
    const repo = join(directory, "repo");
    const bin = join(directory, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true });
    mkdirSync(join(repo, "desktop", "src-tauri"), { recursive: true });
    const version = scenario.version ?? OWN_VERSION;
    const preflightScript = join(repo, "scripts", "ci", "release-preflight.sh");
    copyFileSync(PREFLIGHT, preflightScript);
    copyFileSync(repoPath("scripts", "release-version-sources.ts"), join(repo, "scripts", "release-version-sources.ts"));
    copyFileSync(repoPath("scripts", "version-line.ts"), join(repo, "scripts", "version-line.ts"));
    writeFileSync(join(repo, "desktop", "src-tauri", "tauri.conf.json"), JSON.stringify({ version }));
    writeFileSync(join(repo, "desktop", "src-tauri", "Cargo.toml"), `[package]\nname = "opencodex-desktop"\nversion = "${version}"\n`);
    writeFileSync(join(repo, "desktop", "src-tauri", "Cargo.lock"), `[[package]]\nname = "opencodex-desktop"\nversion = "${version}"\n`);
    const nodeProbe = Bun.spawnSync(["node", "-p", "process.execPath"], {
      env: { ...process.env, HOME: process.env.OCX_REAL_HOME ?? process.env.HOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (nodeProbe.exitCode !== 0) throw new Error(`node executable unavailable: ${nodeProbe.stderr.toString()}`);
    symlinkSync(nodeProbe.stdout.toString().trim(), join(bin, "node"));
    writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    writeFileSync(join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
    const gitEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    };
    run(repo, gitEnv, "git", "init", "-q", "-b", "release");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: manifest.name, version }));
    run(repo, gitEnv, "git", "add", "package.json");
    run(repo, gitEnv, "git", "commit", "-q", "-m", "release");
    const head = run(repo, gitEnv, "git", "rev-parse", "HEAD");
    for (const tag of scenario.tags ?? []) run(repo, gitEnv, "git", "tag", tag);
    if (scenario.devVersion !== null) {
      run(repo, gitEnv, "git", "checkout", "-q", "-b", "dev");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version: scenario.devVersion ?? NEXT_CORE }));
      run(repo, gitEnv, "git", "commit", "-q", "--allow-empty", "-am", "dev pre-move");
      run(repo, gitEnv, "git", "update-ref", "refs/remotes/origin/dev", "HEAD");
      run(repo, gitEnv, "git", "checkout", "-q", "release");
    }
    const summary = join(directory, "summary.md");
    writeFileSync(summary, "");
    const result = Bun.spawnSync(["bash", preflightScript], {
      cwd: repo,
      env: {
        ...gitEnv,
        PATH: `${bin}${delimiter}${gitEnv.PATH}`,
        RELEASE_VERSION: version,
        NPM_DIST_TAG: scenario.distTag ?? OWN_TAG,
        GITHUB_REF: scenario.ref ?? OWN_REF,
        GITHUB_SHA: head,
        DRY_RUN: String(scenario.dryRun ?? false),
        RESUME: String(scenario.resume ?? false),
        GITHUB_STEP_SUMMARY: summary,
        FIXTURE_GH_RELEASE: scenario.githubRelease ? "yes" : "no",
        FIXTURE_NPM: scenario.npm ?? "absent",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: `${result.stdout.toString()}${result.stderr.toString()}`,
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    removeTreeWithRetry(directory);
  }
}

describe.skipIf(process.platform === "win32")("scripts/ci/release-preflight.sh, executed", () => {
  test("replays run 35783865160: a higher-core tag refuses the release before packaging", () => {
    const blocker = OWN_IS_PREVIEW ? `v${NEXT_CORE}` : `v${NEXT_CORE}-preview.20260923`;
    const result = preflight({ tags: ["v0.0.1", blocker] });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`${OWN_VERSION} does not outrank the current tag set`);
    expect(result.output).toContain("found 1 blocking problem(s)");
    expect(result.summary).toContain(`Release preflight refused ${OWN_VERSION}`);
  }, SPAWN_BUDGET_MS);

  test("passes a release every check can already approve", () => {
    const result = preflight({ tags: ["v0.0.1"] });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Release preflight passed");
    expect(result.summary).toBe("");
  }, SPAWN_BUDGET_MS);

  test("refuses a version npm already has unless the run is a dry run", () => {
    const real = preflight({ tags: ["v0.0.1"], npm: "present" });
    expect(real.status, real.output).toBe(1);
    expect(real.output).toContain("already exists on npm");
    const dry = preflight({ tags: ["v0.0.1"], npm: "present", dryRun: true });
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain("::notice::");
  }, SPAWN_BUDGET_MS);

  test("refuses an existing GitHub release outside the resume path", () => {
    const result = preflight({ tags: ["v0.0.1"], githubRelease: true });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("GitHub Release");
  }, SPAWN_BUDGET_MS);

  test("refuses a resume with nothing on npm to resume from", () => {
    const result = preflight({ tags: ["v0.0.1"], resume: true });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("is not on npm");
  }, SPAWN_BUDGET_MS);

  test("warns rather than blocks when npm cannot be read", () => {
    const result = preflight({ tags: ["v0.0.1"], npm: "unreadable" });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("::warning::Could not read npm");
  }, SPAWN_BUDGET_MS);

  test("requires the dev pre-move", () => {
    const behind = preflight({ tags: ["v0.0.1"], devVersion: OWN_VERSION });
    expect(behind.status, behind.output).toBe(1);
    expect(behind.output).toContain("merge the dev pre-move first");
    const missing = preflight({ tags: ["v0.0.1"], devVersion: null });
    expect(missing.status, missing.output).toBe(1);
    expect(missing.output).toContain("refs/remotes/origin/dev");
  }, SPAWN_BUDGET_MS);

  test("reports every problem in one run", () => {
    const wrongTag = OWN_TAG === "latest" ? "preview" : "latest";
    const result = preflight({ tags: ["v0.0.1"], distTag: wrongTag, npm: "present" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`npm dist-tag '${OWN_TAG}'`);
    expect(result.output).toContain("already exists on npm");
    expect(result.output).toContain("found 2 blocking problem(s)");
  }, SPAWN_BUDGET_MS);
});
