import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyPackageVersion,
  prepareForkOfficialBase,
  safeGitDiagnostic,
} from "../../scripts/prepare-fork-official-base";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { forkVersionTagError } from "../../src/fork/version-policy.mjs";

const decoder = new TextDecoder();
const roots: string[] = [];
const seedRoots: string[] = [];

function fakeGitEnvironment(fakeBin: string, values: Record<string, string> = {}): Record<string, string> {
  const withoutPathAliases = Object.fromEntries(Object.entries({ ...process.env, ...values, Path: "discarded-path-alias" })
    .filter(([key]) => key.toUpperCase() !== "PATH")) as Record<string, string>;
  return { ...withoutPathAliases, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` };
}

function hostileGitDiagnostic(ownedPath: string): string {
  const fakeToken = "secret" + "-token";
  const adversarial = [
    `Authorization: Bearer ${fakeToken}\u0007\u2028forged-line`,
    ownedPath,
    `https://${"user"}:${fakeToken}@${"example.invalid"}/repo.git?access_token=${fakeToken}#private-fragment`,
    `Authorization: Bearer ${fakeToken}`,
    `/${"Users"}/${"private" + "-name"}/work/repo`,
    `/${"home"}/${"linux" + "-private"}/work/repo`,
    `C:${"\\"}${"Users"}${"\\"}${"windows" + "-private"}${"\\"}work${"\\"}repo`,
    `/${"private"}/var/folders/xy/ocx-fork-${"official"}-${"secret"}/repo.git`,
    `/${"tmp"}/ocx-fork-${"official"}-${"secret"}/repo.git`,
    `D:${"\\"}Temp${"\\"}ocx-fork-${"official"}-${"secret"}${"\\"}repo.git`,
  ];
  return `${adversarial.join("\n")}\n${"neutral diagnostic filler ".repeat(220)}`;
}

function git(cwd: string, args: readonly string[], input?: string) {
  const result = Bun.spawnSync(["git", "--no-lazy-fetch", ...args], { cwd, stdin: input === undefined ? undefined : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

function requireGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(repo: string, subject: string): string {
  writeFileSync(join(repo, `${subject}.txt`), `${subject}\n`);
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", subject]);
  return requireGit(repo, ["rev-parse", "HEAD"]);
}

type Fixture = {
  root: string;
  official: string;
  originBare: string;
  checkout: string;
  officialTagCommit: string;
};

let fixtureSeed: Fixture | undefined;

function createFixtureSeed(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-"));
  seedRoots.push(root);
  const official = join(root, "official");
  const originBare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  mkdirSync(official);
  requireGit(official, ["init", "--initial-branch=main"]);
  requireGit(official, ["config", "user.name", "Fixture"]);
  requireGit(official, ["config", "user.email", "fixture" + "@" + "example.invalid"]);
  commit(official, "root");
  writeFileSync(join(official, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
  const officialTagCommit = commit(official, "baseline");
  requireGit(official, ["tag", "v2.35.0", officialTagCommit]);
  commit(official, "main-one");
  commit(official, "main-two");
  requireGit(root, ["clone", "--bare", pathToFileURL(official).href, originBare]);
  requireGit(official, ["branch", "sync/v2.35.0", officialTagCommit]);
  requireGit(official, ["branch", "upstream-release", officialTagCommit]);
  requireGit(official, ["push", pathToFileURL(originBare).href,
    "refs/heads/sync/v2.35.0:refs/heads/sync/v2.35.0",
    "refs/heads/upstream-release:refs/heads/upstream-release",
  ]);
  requireGit(originBare, ["tag", "-d", "v2.35.0"]);
  requireGit(originBare, ["tag", "v2.35.0-ben.1", officialTagCommit]);
  requireGit(root, [
    "clone", "--depth=1", "--branch", "sync/v2.35.0", "--single-branch",
    pathToFileURL(originBare).href, checkout,
  ]);
  requireGit(checkout, ["config", "user.name", "Fixture Checkout"]);
  requireGit(checkout, ["config", "user.email", "fixture-checkout" + "@" + "example.invalid"]);
  return { root, official, originBare, checkout, officialTagCommit };
}

function createFixture(): Fixture {
  const seed = fixtureSeed ??= createFixtureSeed();
  const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-"));
  roots.push(root);
  for (const name of ["official", "origin.git", "checkout"]) {
    cpSync(join(seed.root, name), join(root, name), { recursive: true });
  }
  const official = join(root, "official");
  const originBare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  requireGit(originBare, ["remote", "set-url", "origin", pathToFileURL(official).href]);
  requireGit(checkout, ["remote", "set-url", "origin", pathToFileURL(originBare).href]);
  return { root, official, originBare, checkout, officialTagCommit: seed.officialTagCommit };
}

function createUnreleasedShallowFixture(): Fixture {
  const fixture = createFixture();
  rmSync(fixture.checkout, { recursive: true, force: true });
  requireGit(fixture.root, ["clone", "--depth=1", "--no-tags", "--branch", "main",
    "--single-branch", pathToFileURL(fixture.originBare).href, fixture.checkout]);
  return fixture;
}

function fetchHeadSnapshot(repo: string): string | undefined {
  const rawPath = requireGit(repo, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  const path = isAbsolute(rawPath) ? rawPath : resolve(repo, rawPath);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function createReleasedForkFixture(options: { diverged?: boolean; full?: boolean } = {}): Fixture {
  const fixture = createFixture();
  const { official, originBare, checkout, officialTagCommit, root } = fixture;
  if (options.diverged) {
    requireGit(official, ["checkout", "-b", "other-fork", officialTagCommit]);
    commit(official, "other-fork");
  }
  requireGit(official, ["tag", "-a", "v2.35.0-ben.2", "-m", "released fork",
    options.diverged ? "HEAD" : officialTagCommit]);
  requireGit(official, ["checkout", "main"]);
  commit(official, "main-three");
  commit(official, "main-four");
  requireGit(official, ["push", pathToFileURL(originBare).href,
    "refs/heads/main:refs/heads/main", "refs/tags/v2.35.0-ben.2:refs/tags/v2.35.0-ben.2"]);
  rmSync(checkout, { recursive: true, force: true });
  requireGit(root, ["clone", ...(options.full ? [] : ["--depth=1"]), "--no-tags", "--branch", "main",
    "--single-branch", pathToFileURL(originBare).href, checkout]);
  requireGit(checkout, ["fetch", ...(options.full ? [] : ["--depth=1"]), "--no-tags", "origin",
    "refs/tags/v2.35.0-ben.2:refs/tags/v2.35.0-ben.2"]);
  requireGit(checkout, ["fetch", ...(options.full ? [] : ["--depth=1"]), "--no-tags", pathToFileURL(official).href,
    "refs/tags/v2.35.0:refs/tags/v2.35.0"]);
  return fixture;
}

function releasedForkError(repo: string): string | null {
  return forkVersionTagError("2.35.0-ben.2", requireGit(repo, ["tag", "--list"]).split("\n"), tag =>
    git(repo, ["merge-base", "--is-ancestor", `${tag}^{commit}`, "HEAD"]).exitCode === 0);
}

function assertNoOwnedResidue(
  fixture: Fixture,
  beforeFetchHead: string | undefined,
  sentinel: string,
  beforeVerifierRoots: string[],
) {
  expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/ocx-ci/official-tag"]).exitCode).not.toBe(0);
  expect(fetchHeadSnapshot(fixture.checkout)).toBe(beforeFetchHead);
  expect(requireGit(fixture.checkout, ["rev-parse", "refs/heads/keep-sentinel"])).toBe(sentinel);
  expect(verifierRoots()).toEqual(beforeVerifierRoots);
}

function verifierRoots(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith("ocx-fork-official-")).sort();
}

function runAsCandidate<T>(run: () => T, overrides: Record<string, string | undefined> = {}): T {
  const previous = {
    actions: process.env.GITHUB_ACTIONS,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    lane: process.env.OCX_CANDIDATE_CI_LANE,
  };
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/dev",
    OCX_CANDIDATE_CI_LANE: "all",
    ...overrides,
  };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    if (previous.actions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous.actions;
    if (previous.event === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = previous.event;
    if (previous.ref === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = previous.ref;
    if (previous.lane === undefined) delete process.env.OCX_CANDIDATE_CI_LANE;
    else process.env.OCX_CANDIDATE_CI_LANE = previous.lane;
  }
}

function runOutsideCandidate<T>(run: () => T): T {
  const previous = {
    actions: process.env.GITHUB_ACTIONS,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
  };
  process.env.GITHUB_ACTIONS = "false";
  process.env.GITHUB_EVENT_NAME = "push";
  process.env.GITHUB_REF = "refs/heads/main";
  try {
    return run();
  } finally {
    if (previous.actions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous.actions;
    if (previous.event === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = previous.event;
    if (previous.ref === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = previous.ref;
  }
}

function prepare(
  fixture: Fixture,
  officialUrl = pathToFileURL(fixture.official).href,
  runGit?: (cwd: string, args: readonly string[], input?: string) => ReturnType<typeof git>,
  options: { officialReleaseEvidence?: unknown } = {},
) {
  const rawFetchHead = requireGit(fixture.checkout, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  const fetchHeadPath = isAbsolute(rawFetchHead) ? rawFetchHead : resolve(fixture.checkout, rawFetchHead);
  writeFileSync(fetchHeadPath, "sentinel-fetch-head\n\u0000byte-specific\n");
  const beforeFetchHead = fetchHeadSnapshot(fixture.checkout);
  const beforeVerifierRoots = verifierRoots();
  const sentinel = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
  requireGit(fixture.checkout, ["update-ref", "refs/heads/keep-sentinel", sentinel]);
  return {
    beforeFetchHead,
    beforeVerifierRoots,
    sentinel,
    run: () => prepareForkOfficialBase({
      repoRoot: fixture.checkout,
      officialRepositoryUrl: officialUrl,
      runGit,
      officialReleaseEvidence: {
        tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
      },
      ...options,
    } as Parameters<typeof prepareForkOfficialBase>[0]),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const root of seedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Fork CI official baseline preparation", () => {
  test("classifies only strict fork, stable, and preview package versions before Git", () => {
    expect(classifyPackageVersion("2.35.0-ben.2")).toEqual({
      kind: "fork", version: "2.35.0-ben.2", base: "2.35.0", tag: "v2.35.0",
    });
    for (const value of [
      " 2.35.0-ben.2 ", "2.35.0-ben", "2.35.0-ben.0", "2.35.0-ben.02",
      "2.35.0-ben.9007199254740993", "2.35.0-ben.2.extra", "2.35.0-rc.1",
      "2.35.0-beta.1", "2.35.0-foo.1", "not-semver",
    ]) expect(() => classifyPackageVersion(value)).toThrow();
    expect(classifyPackageVersion("2.35.0")).toEqual({ kind: "non-fork", version: "2.35.0" });
    expect(classifyPackageVersion("2.36.0-preview.20260829"))
      .toEqual({ kind: "non-fork", version: "2.36.0-preview.20260829" });
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-version-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0" }));
    let calls = 0;
    expect(prepareForkOfficialBase({
      repoRoot: root,
      officialRepositoryUrl: "https://example.invalid/unused.git",
      runGit: () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toEqual({ kind: "not-fork", version: "2.35.0" });
    expect(calls).toBe(0);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben" }));
    expect(() => prepareForkOfficialBase({
      repoRoot: root,
      officialRepositoryUrl: "https://example.invalid/unused.git",
      runGit: () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    })).toThrow("prepare official base:");
    expect(calls).toBe(0);
  });

  test("requires a matching formal Release even when the official repository has main", () => {
    for (const missing of [true, false]) {
      const fixture = createFixture();
      const evidence = missing ? undefined : {
        tag_name: "v2.35.0", draft: true, prerelease: false, target_commitish: fixture.officialTagCommit,
      };
      const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: evidence });
      expect(prepared.run).toThrow("official release evidence");
      expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }
  });

  test("accepts a verified release without an origin upstream-release branch", () => {
    const fixture = createFixture();
    requireGit(fixture.originBare, ["update-ref", "-d", "refs/heads/upstream-release"]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run()).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a verified official tag that is not on the checkout history", () => {
    const fixture = createFixture();
    requireGit(fixture.checkout, ["fetch", "--unshallow", "origin"]);
    requireGit(fixture.checkout, ["checkout", "--orphan", "unrelated"]);
    commit(fixture.checkout, "unrelated-root");
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run).toThrow("verify official ancestry");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("fetches fixed HEAD history when a shallow checkout cannot prove the official tag ancestry", () => {
    const fixture = createUnreleasedShallowFixture();
    const head = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
    expect(git(fixture.checkout, ["cat-file", "-t", fixture.officialTagCommit]).exitCode).not.toBe(0);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    }, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run()).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    expect(calls.filter(args => args.includes("--unshallow"))).toEqual([
      ["fetch", "--unshallow", "--no-tags", "--no-write-fetch-head", "origin", head],
    ]);
    const bareDir = calls.find(args => args[0] === "init" && args[1] === "--bare")?.[2];
    const importIndex = calls.findIndex(args => args[0] === "fetch" && args.includes(bareDir!));
    const unshallowIndex = calls.findIndex(args => args.includes("--unshallow"));
    expect(unshallowIndex).toBeGreaterThan(-1);
    expect(importIndex).toBeGreaterThan(unshallowIndex);
    expect(requireGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.officialTagCommit, head]).exitCode).toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("does not treat a fatal official ancestry query as an unproven shallow history", () => {
    const fixture = createFixture();
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args[0] === "merge-base" && args.includes(fixture.officialTagCommit)) {
        return { exitCode: 128, stdout: "", stderr: "fatal ancestry failure" };
      }
      return git(cwd, args, input);
    }, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run).toThrow("verify official ancestry");
    expect(calls.some(args => args.includes("--unshallow"))).toBe(false);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test.skipIf(process.platform === "win32")("does not lazily fetch a missing ancestry object from a checkout promisor", () => {
    const fixture = createFixture();
    const tree = requireGit(fixture.checkout, ["rev-parse", "HEAD^{tree}"]);
    const parent = requireGit(fixture.checkout, ["commit-tree", tree, "-p", fixture.officialTagCommit, "-m", "fixture parent"]);
    const head = requireGit(fixture.checkout, ["commit-tree", tree, "-p", parent, "-m", "fixture head"]);
    requireGit(fixture.checkout, ["push", pathToFileURL(fixture.official).href, `${parent}:refs/heads/promisor-fixture`]);
    requireGit(fixture.checkout, ["update-ref", "HEAD", head]);
    rmSync(join(fixture.checkout, ".git", "objects", parent.slice(0, 2), parent.slice(2)));
    const marker = join(fixture.root, "promisor-invoked");
    const uploadPack = join(fixture.root, "promisor-upload-pack");
    writeFileSync(uploadPack, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");\nprocess.exit(1);\n`, { mode: 0o700 });
    requireGit(fixture.checkout, ["config", "remote.promisor.url", pathToFileURL(fixture.official).href]);
    requireGit(fixture.checkout, ["config", "remote.promisor.promisor", "true"]);
    requireGit(fixture.checkout, ["config", "remote.promisor.partialclonefilter", "blob:none"]);
    requireGit(fixture.checkout, ["config", "remote.promisor.uploadpack", uploadPack]);
    requireGit(fixture.checkout, ["config", "core.repositoryformatversion", "1"]);
    requireGit(fixture.checkout, ["config", "extensions.partialClone", "promisor"]);
    const unsafeQuery = Bun.spawnSync(["git", "cat-file", "-t", parent], { cwd: fixture.checkout, stdout: "pipe", stderr: "pipe" });
    expect(unsafeQuery.exitCode).not.toBe(0);
    expect(existsSync(marker), decoder.decode(unsafeQuery.stderr)).toBe(true);
    rmSync(marker);
    const prepared = prepare(fixture);
    const fakeBin = join(fixture.root, "git-wrapper");
    const gitLog = join(fixture.root, "git-wrapper.jsonl");
    const realGit = Bun.which("git");
    expect(realGit).toBeTruthy();
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "git"), `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nconst { spawnSync } = require("node:child_process");\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + "\\n");\nconst result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
      expect(prepared.run).toThrow("verify official ancestry");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const commands = readFileSync(gitLog, "utf8").trim().split("\n").map(JSON.parse) as string[][];
    expect(commands.find(args => args.includes("merge-base"))?.[0]).toBe("--no-lazy-fetch");
    expect(commands.every(args => args[0] === "--no-lazy-fetch")).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test.each(["fatal", "malformed", "wrong type"])("rejects an invalid local object probe: %s", mode => {
    const fixture = createUnreleasedShallowFixture();
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args.includes("--batch-check=%(objectname) %(objecttype)")) {
        expect(args[0]).toBe("cat-file");
        expect(input).toBe(`${fixture.officialTagCommit}\n`);
        if (mode === "fatal") return { exitCode: 128, stdout: "", stderr: "fatal object probe" };
        const stdout = mode === "wrong type" ? `${fixture.officialTagCommit} blob\n` : "unexpected response\n";
        return { exitCode: 0, stdout, stderr: "" };
      }
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("verify official ancestry");
    expect(calls.some(args => args.includes("--unshallow"))).toBe(false);
    const bareDir = calls.find(args => args[0] === "init" && args[1] === "--bare")?.[2];
    expect(calls.some(args => args[0] === "fetch" && args.includes(bareDir!))).toBe(false);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects failure to fetch fixed HEAD history for an unproven official ancestor", () => {
    const fixture = createUnreleasedShallowFixture();
    const head = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args.includes("--unshallow")) return { exitCode: 128, stdout: "", stderr: "history fetch failed" };
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("history fetch failed");
    expect(calls.filter(args => args.includes("--unshallow"))).toEqual([
      ["fetch", "--unshallow", "--no-tags", "--no-write-fetch-head", "origin", head],
    ]);
    expect(requireGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a fatal official ancestry recheck after fetching shallow history", () => {
    const fixture = createFixture();
    let checks = 0;
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args[0] === "merge-base" && args.includes(fixture.officialTagCommit)) {
        checks++;
        return checks === 1
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 128, stdout: "", stderr: "fatal ancestry recheck" };
      }
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("verify official ancestry");
    expect(checks).toBe(2);
    expect(calls.some(args => args.includes("--unshallow"))).toBe(true);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a HEAD change during official ancestry verification", () => {
    const fixture = createFixture();
    let headReads = 0;
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD" && ++headReads === 2) {
        return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
      }
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("HEAD changed during official base verification");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("uses the checkout rather than an inherited GIT_DIR", () => {
    const fixture = createFixture();
    const prepared = prepare(fixture);
    const previous = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(fixture.official, ".git");
      expect(prepared.run()).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0^{commit}"])).toBe(fixture.officialTagCommit);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("does not accept ancestry forged by a local Git replacement", () => {
    const fixture = createFixture();
    requireGit(fixture.checkout, ["fetch", "--unshallow", "origin"]);
    requireGit(fixture.checkout, ["checkout", "--orphan", "unrelated"]);
    const head = commit(fixture.checkout, "unrelated-replacement-root");
    requireGit(fixture.checkout, ["replace", "--graft", head, fixture.officialTagCommit]);
    expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.officialTagCommit, head]).exitCode).toBe(0);
    expect(git(fixture.checkout, ["--no-replace-objects", "merge-base", "--is-ancestor", fixture.officialTagCommit, head]).exitCode).toBe(1);
    const prepared = prepare(fixture);
    expect(prepared.run).toThrow("verify official ancestry");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("does not accept ancestry forged by a local Git graft", () => {
    const fixture = createFixture();
    requireGit(fixture.checkout, ["fetch", "--unshallow", "origin"]);
    requireGit(fixture.checkout, ["checkout", "--orphan", "unrelated"]);
    const head = commit(fixture.checkout, "unrelated-graft-root");
    writeFileSync(join(fixture.checkout, ".git", "info", "grafts"), `${head} ${fixture.officialTagCommit}\n`);
    expect(git(fixture.checkout, ["merge-base", "--is-ancestor", fixture.officialTagCommit, head]).exitCode).toBe(0);
    const prepared = prepare(fixture);
    expect(prepared.run).toThrow("verify official ancestry");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("imports the observed lightweight official tag into an origin-only shallow checkout", () => {
    const fixture = createFixture();
    expect(requireGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const shallowPath = resolve(fixture.checkout, requireGit(fixture.checkout, ["rev-parse", "--git-path", "shallow"]));
    const beforeShallow = readFileSync(shallowPath);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    expect(requireGit(fixture.checkout, ["tag", "--list", "v*"]).split("\n").filter(Boolean)).toEqual(["v2.35.0-ben.1"]);
    expect(requireGit(fixture.official, ["rev-list", "--count", `${fixture.officialTagCommit}..refs/heads/main`])).toBe("2");
    const calls: string[][] = [];
    const prepared = prepare(fixture, pathToFileURL(fixture.official).href, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    const result = prepared.run();
    expect(result).toMatchObject({ kind: "prepared", tag: "v2.35.0", refKind: "lightweight" });
    expect(requireGit(fixture.checkout, ["cat-file", "-t", "refs/tags/v2.35.0"])).toBe("commit");
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"]))
      .toBe(fixture.officialTagCommit);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0^{commit}"]))
      .toBe(fixture.officialTagCommit);
    const officialFetch = calls.find(args => args.includes("fetch") && args.includes(pathToFileURL(fixture.official).href));
    expect(officialFetch).toBeDefined();
    const bareDir = calls.find(args => args[0] === "init" && args[1] === "--bare")?.[2];
    expect(officialFetch).toEqual([
      `--git-dir=${bareDir}`, "fetch", "--depth=1", "--no-tags", "--no-filter", pathToFileURL(fixture.official).href,
      "+refs/tags/v2.35.0:refs/tags/v2.35.0",
    ]);
    expect(readFileSync(shallowPath)).toEqual(beforeShallow);
    const checkoutFetches = calls.filter(args => args.includes("fetch") && !args.includes(pathToFileURL(fixture.official).href));
    expect(checkoutFetches.every(args => args.includes("--no-write-fetch-head"))).toBe(true);
    expect(calls.some(args => args.includes("--unshallow"))).toBe(false);
    const bareType = calls.findIndex(args => args.includes("cat-file") && args.includes("refs/tags/v2.35.0"));
    const bareRaw = calls.findIndex((args, position) => position > bareType && args.includes("rev-parse") && args.includes("refs/tags/v2.35.0"));
    const barePeeled = calls.findIndex((args, position) => position > bareRaw && args.includes("rev-parse") && args.includes("refs/tags/v2.35.0^{commit}"));
    expect(bareType).toBeGreaterThan(-1);
    expect(bareRaw).toBeGreaterThan(bareType);
    expect(barePeeled).toBeGreaterThan(bareRaw);
    const importIndex = calls.findIndex((args, position) => position > barePeeled
      && args.includes("fetch") && bareDir !== undefined && args.includes(bareDir));
    expect(importIndex).toBeGreaterThan(barePeeled);
    const checkoutType = calls.findIndex((args, position) => position > importIndex
      && args.includes("cat-file") && args.includes("refs/ocx-ci/official-tag"));
    const checkoutRaw = calls.findIndex((args, position) => position > checkoutType
      && args.includes("rev-parse") && args.includes("refs/ocx-ci/official-tag"));
    const checkoutPeeled = calls.findIndex((args, position) => position > checkoutRaw
      && args.includes("rev-parse") && args.includes("refs/ocx-ci/official-tag^{commit}"));
    expect(checkoutType).toBeGreaterThan(importIndex);
    expect(checkoutRaw).toBeGreaterThan(checkoutType);
    expect(checkoutPeeled).toBeGreaterThan(checkoutRaw);
    expect(calls.findIndex(args => args[0] === "merge-base")).toBeLessThan(importIndex);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("reuses a verified local official tag without a bare fetch (annotated=%s, full=%s)", (annotated, full) => {
    const fixture = createFixture();
    if (annotated) {
      requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
      requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official release", fixture.officialTagCommit]);
    }
    requireGit(fixture.official, ["tag", "v2.35.0-ben.1", fixture.officialTagCommit]);
    if (full) requireGit(fixture.checkout, ["fetch", "--unshallow", "--no-tags", "origin"]);
    requireGit(fixture.checkout, ["fetch", "--no-tags", pathToFileURL(fixture.official).href,
      "refs/tags/v2.35.0:refs/tags/v2.35.0"]);
    const raw = requireGit(fixture.official, ["rev-parse", "refs/tags/v2.35.0"]);
    const shallowPath = resolve(fixture.checkout, requireGit(fixture.checkout, ["rev-parse", "--git-path", "shallow"]));
    const beforeShallow = existsSync(shallowPath) ? readFileSync(shallowPath) : undefined;
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    expect(prepared.run()).toMatchObject({ kind: "prepared", refKind: annotated ? "annotated" : "lightweight",
      rawTagOid: raw, peeledCommit: fixture.officialTagCommit });
    const bareDir = calls.find(args => args[0] === "init" && args[1] === "--bare")?.[2];
    expect(calls.filter(args => args.includes("ls-remote"))).toEqual([[
      `--git-dir=${bareDir}`, "ls-remote", "--tags", pathToFileURL(fixture.official).href,
      "refs/tags/v2.35.0", "refs/tags/v2.35.0?{}",
    ]]);
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(raw);
    expect(existsSync(shallowPath) ? readFileSync(shallowPath) : undefined).toEqual(beforeShallow);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test.each(["empty", "malformed", "duplicate", "wrong ref", "wildcard ref", "peeled only", "duplicate peeled"])("rejects invalid exact-tag advertising: %s", mode => {
    const fixture = createFixture();
    const oid = fixture.officialTagCommit;
    const raw = `${oid}\trefs/tags/v2.35.0\n`;
    const responses: Record<string, string> = {
      empty: "", malformed: `not-an-oid\trefs/tags/v2.35.0\n`, duplicate: raw + raw,
      "wrong ref": `${oid}\trefs/tags/v2.35.1\n`, "peeled only": `${oid}\trefs/tags/v2.35.0^{}\n`,
      "wildcard ref": raw + `${oid}\trefs/tags/v2.35.0x{}\n`,
      "duplicate peeled": raw + `${oid}\trefs/tags/v2.35.0^{}\n`.repeat(2),
    };
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args.includes("ls-remote")) return { exitCode: 0, stdout: responses[mode]!, stderr: "" };
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("verify official tag");
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects an unrelated real tag matched by the peeled query pattern", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "v2.35.0x{}", fixture.officialTagCommit]);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("verify official tag: invalid remote tag advertisement");
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a forged local tag without fetching the official tag again", () => {
    const fixture = createFixture();
    const tree = requireGit(fixture.checkout, ["rev-parse", "HEAD^{tree}"]);
    const forged = requireGit(fixture.checkout, ["commit-tree", tree, "-p", fixture.officialTagCommit, "-m", "forged tag"]);
    requireGit(fixture.checkout, ["update-ref", "refs/tags/v2.35.0", forged]);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("existing local official tag does not match verified official tag");
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(forged);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("does not treat a malformed existing local ref as a cache miss", () => {
    const fixture = createFixture();
    const tagPath = join(fixture.checkout, ".git", "refs", "tags", "v2.35.0");
    writeFileSync(tagPath, "not-a-git-object\n");
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("verify official tag");
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(readFileSync(tagPath, "utf8")).toBe("not-a-git-object\n");
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test.each(["ref", "object", "peel"])("does not treat a local tag verification failure as a cache miss: %s", mode => {
    const fixture = createFixture();
    requireGit(fixture.checkout, ["update-ref", "refs/tags/v2.35.0", fixture.officialTagCommit]);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if ((mode === "ref" && args[0] === "show-ref" && args.includes("--exists"))
        || (mode === "object" && args.includes("--batch-check=%(objectname) %(objecttype)"))
        || (mode === "peel" && args[0] === "rev-parse" && args[1] === "refs/tags/v2.35.0^{commit}")) {
        return { exitCode: 128, stdout: "", stderr: "fatal local verification" };
      }
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("verify official tag");
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(fixture.officialTagCommit);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a tag that changes between advertising and bare fetch", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official release", fixture.officialTagCommit]);
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      if (args.includes("ls-remote")) return { exitCode: 0, stderr: "", stdout:
        `${"a".repeat(40)}\trefs/tags/v2.35.0\n${fixture.officialTagCommit}\trefs/tags/v2.35.0^{}\n` };
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("fetched tag does not match remote advertisement");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects HEAD drift on the local tag reuse path", () => {
    const fixture = createFixture();
    requireGit(fixture.checkout, ["update-ref", "refs/tags/v2.35.0", fixture.officialTagCommit]);
    let headReads = 0;
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "HEAD" && ++headReads === 2) {
        return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
      }
      return git(cwd, args, input);
    });
    expect(prepared.run).toThrow("HEAD changed during official base verification");
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(fixture.officialTagCommit);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("falls back to the bare verifier when a matching local tag object is missing", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official release", fixture.officialTagCommit]);
    const raw = requireGit(fixture.official, ["rev-parse", "refs/tags/v2.35.0"]);
    writeFileSync(join(fixture.checkout, ".git", "refs", "tags", "v2.35.0"), `${raw}\n`);
    expect(git(fixture.checkout, ["cat-file", "-e", raw]).exitCode).not.toBe(0);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    expect(prepared.run()).toMatchObject({ kind: "prepared", refKind: "annotated", rawTagOid: raw,
      peeledCommit: fixture.officialTagCommit });
    expect(calls.some(args => args.includes("fetch") && args.includes(pathToFileURL(fixture.official).href))).toBe(true);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(raw);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("falls back when a local annotated tag is present but its commit is missing", () => {
    const fixture = createUnreleasedShallowFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official release", fixture.officialTagCommit]);
    const raw = requireGit(fixture.official, ["rev-parse", "refs/tags/v2.35.0"]);
    const tagContents = git(fixture.official, ["cat-file", "tag", raw]);
    expect(tagContents.exitCode).toBe(0);
    const copy = git(fixture.checkout, ["hash-object", "-t", "tag", "-w", "--stdin"], tagContents.stdout);
    expect(copy.exitCode).toBe(0);
    expect(copy.stdout.trim()).toBe(raw);
    requireGit(fixture.checkout, ["update-ref", "refs/tags/v2.35.0", raw]);
    expect(git(fixture.checkout, ["cat-file", "-e", fixture.officialTagCommit]).exitCode).not.toBe(0);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    expect(prepared.run()).toMatchObject({ kind: "prepared", refKind: "annotated", rawTagOid: raw,
      peeledCommit: fixture.officialTagCommit });
    expect(calls.some(args => args.includes("fetch") && args.includes(pathToFileURL(fixture.official).href))).toBe(true);
    expect(calls.some(args => args.includes("--unshallow"))).toBe(true);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("does not let checkout URL rewriting redirect the official tag advertisement", () => {
    const fixture = createFixture();
    requireGit(fixture.checkout, ["update-ref", "refs/tags/v2.35.0", fixture.officialTagCommit]);
    requireGit(fixture.checkout, ["config", `url.${pathToFileURL(fixture.originBare).href}.insteadOf`, pathToFileURL(fixture.official).href]);
    const prepared = prepare(fixture);
    expect(prepared.run()).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test.each([false, true])("verifier fetch keeps the tag tree but not its parent (annotated=%s)", annotated => {
    const fixture = createFixture();
    if (annotated) {
      requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
      requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official release", fixture.officialTagCommit]);
    }
    const parent = requireGit(fixture.official, ["rev-parse", `${fixture.officialTagCommit}~1`]);
    const tree = requireGit(fixture.official, ["rev-parse", `${fixture.officialTagCommit}^{tree}`]);
    const blob = requireGit(fixture.official, ["rev-parse", `${fixture.officialTagCommit}:package.json`]);
    let inspected: { shallow: string; parentExit: number; treeType: string; blobType: string } | undefined;
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      const result = git(cwd, args, input);
      if (result.exitCode === 0 && args[0]?.startsWith("--git-dir=") && args.includes("fetch")) {
        const dir = args[0];
        inspected = {
          shallow: requireGit(cwd, [dir, "rev-parse", "--is-shallow-repository"]),
          parentExit: git(cwd, [dir, "cat-file", "-e", parent]).exitCode,
          treeType: requireGit(cwd, [dir, "cat-file", "-t", tree]),
          blobType: requireGit(cwd, [dir, "cat-file", "-t", blob]),
        };
      }
      return result;
    });
    expect(prepared.run()).toMatchObject({ kind: "prepared", refKind: annotated ? "annotated" : "lightweight" });
    expect(inspected).toEqual({ shallow: "true", parentExit: 1, treeType: "tree", blobType: "blob" });
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("imports the official tag with exact formal Release evidence when main is absent", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["checkout", "--orphan", "dev"]);
    requireGit(fixture.official, ["rm", "-rf", "."]);
    commit(fixture.official, "unrelated-dev-root");
    requireGit(fixture.official, ["branch", "-D", "main"]);
    expect(git(fixture.official, ["merge-base", "--is-ancestor", "v2.35.0", "refs/heads/dev"]).exitCode).toBe(1);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run()).toMatchObject({
      kind: "prepared", tag: "v2.35.0", rawTagOid: fixture.officialTagCommit,
      peeledCommit: fixture.officialTagCommit,
    });
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"]))
      .toBe(fixture.officialTagCommit);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("preserves an annotated official tag with Release evidence when main is absent", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["branch", "-m", "main", "dev"]);
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official release", fixture.officialTagCommit]);
    const rawTagOid = requireGit(fixture.official, ["rev-parse", "refs/tags/v2.35.0"]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run()).toMatchObject({ kind: "prepared", refKind: "annotated", rawTagOid,
      peeledCommit: fixture.officialTagCommit });
    expect(rawTagOid).not.toBe(fixture.officialTagCommit);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(rawTagOid);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0^{commit}"]))
      .toBe(fixture.officialTagCommit);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  for (const [name, evidence] of [
    ["missing", undefined],
    ["draft", { draft: true }],
    ["prerelease", { prerelease: true }],
    ["missing draft status", { draft: undefined }],
    ["wrong tag", { tag_name: "v2.35.1" }],
    ["branch target", { target_commitish: "dev" }],
    ["wrong commit target", { target_commitish: "a".repeat(40) }],
    ["malformed commit target", { target_commitish: "z".repeat(40) }],
  ] as const) {
    test(`rejects ${name} Release evidence when main is absent`, () => {
      const fixture = createFixture();
      requireGit(fixture.official, ["branch", "-m", "main", "dev"]);
      const release = evidence === undefined ? undefined : {
        tag_name: "v2.35.0", draft: false, prerelease: false,
        target_commitish: fixture.officialTagCommit, ...evidence,
      };
      const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: release });
      expect(prepared.run).toThrow("official release evidence");
      expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    });
  }

  test("accepts a verified release in candidate CI when the old marker differs", () => {
    const fixture = createFixture();
    const rootCommit = requireGit(fixture.official, ["rev-list", "--max-parents=0", "refs/heads/main"]);
    requireGit(fixture.originBare, ["update-ref", "refs/heads/upstream-release", rootCommit]);
    requireGit(fixture.official, ["branch", "-m", "main", "dev"]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(runAsCandidate(prepared.run)).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("does not depend on an official main query", () => {
    const fixture = createFixture();
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    }, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run()).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    const queries = calls.filter(args => args.includes("ls-remote"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("refs/tags/v2.35.0");
    expect(queries[0]).not.toContain("refs/heads/main");
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects an official tag whose imported raw identity differs", () => {
    const fixture = createFixture();
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "refs/ocx-ci/official-tag") {
        return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
      }
      return git(cwd, args, input);
    }, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run).toThrow("imported official tag does not match verified official tag");
    expect(calls.some(args => args.includes("fetch"))).toBe(true);
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects an official repository fetch failure even with Release evidence", () => {
    const fixture = createFixture();
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      if (args.includes("fetch") && args.includes(pathToFileURL(fixture.official).href)) {
        return { exitCode: 1, stdout: "", stderr: "official fetch failed" };
      }
      return git(cwd, args, input);
    }, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run).toThrow("official fetch failed");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects an official tag fetch failure when main is absent", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["branch", "-m", "main", "dev"]);
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      if (args.includes("fetch") && args.includes(pathToFileURL(fixture.official).href)) {
        return { exitCode: 1, stdout: "", stderr: "tag fetch failed" };
      }
      return git(cwd, args, input);
    }, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(prepared.run).toThrow("tag fetch failed");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("requires checkout ancestry even if Release evidence matches an unrelated tag", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["checkout", "--orphan", "unrelated"]);
    requireGit(fixture.official, ["rm", "-rf", "."]);
    const unrelated = commit(fixture.official, "unrelated-root");
    requireGit(fixture.official, ["tag", "v2.35.0", unrelated]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: unrelated,
    } });
    expect(prepared.run).toThrow("verify official ancestry:");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("reads Release evidence only from the fixed GitHub endpoint without credentials or redirects", async () => {
    const script = await import("../../scripts/prepare-fork-official-base");
    const readRelease = script.fetchOfficialReleaseEvidence;
    expect(typeof readRelease).toBe("function");
    let requestedUrl = "";
    let requestOptions: RequestInit | undefined;
    const evidence = { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) };
    expect(await readRelease("v2.35.0", async (url, init) => {
      requestedUrl = url;
      requestOptions = init;
      return Response.json(evidence);
    })).toEqual(evidence);
    expect(requestedUrl).toBe("https://api.github.com/repos/lidge-jun/opencodex/releases/tags/v2.35.0");
    expect(requestOptions?.credentials).toBe("omit");
    expect(requestOptions?.redirect).toBe("error");
    expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(requestOptions?.headers).has("authorization")).toBe(false);
  });

  test("uses only the supplied API token at the fixed Release endpoint", async () => {
    const { fetchOfficialReleaseEvidence } = await import("../../scripts/prepare-fork-official-base");
    const token = "fixture-token-for-release-api";
    let requestedUrl = "";
    let options: RequestInit | undefined;
    const evidence = { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) };
    expect(await fetchOfficialReleaseEvidence("v2.35.0", async (url, init) => {
      requestedUrl = url;
      options = init;
      return Response.json(evidence);
    }, token)).toEqual(evidence);
    expect(requestedUrl).toBe("https://api.github.com/repos/lidge-jun/opencodex/releases/tags/v2.35.0");
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  test("classifies Release API failures without exposing error messages, response bodies, or tokens", async () => {
    const { fetchOfficialReleaseEvidence } = await import("../../scripts/prepare-fork-official-base");
    const token = "fixture-token-for-release-api";
    const secret = "/fixture/private/fixture-private-content";
    const cases: Array<[(url: string, init: RequestInit) => Promise<Response>, string]> = [
      [async () => { throw new Error(`${secret} ${token}`); }, "request-failed"],
      [async () => { throw new DOMException(`${secret} ${token}`, "TimeoutError"); }, "request-timeout"],
      [async () => new Response(secret, { status: 503 }), "http-503"],
      [async () => new Response(secret, { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "http-403 rate-limit-exhausted"],
      [async () => new Response(secret, { status: 403, headers: { "x-ratelimit-remaining": "00" } }), "http-403"],
      [async () => new Response(secret, { status: 429, headers: { "x-ratelimit-remaining": "0" } }), "http-429"],
      [async () => new Response(null, { status: 200 }), "body-missing"],
      [async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`${secret} ${token}`)); } })), "body-read-failed"],
      [async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException(secret, "TimeoutError")); } })), "body-read-timeout"],
      [async () => new Response(`{${secret} ${token}`), "invalid-json"],
      [async () => new Response(secret.repeat(100_000)), "response-too-large"],
    ];
    for (const [request, category] of cases) {
      let message = "";
      try { await fetchOfficialReleaseEvidence("v2.35.0", request, token); } catch (error) { message = String(error); }
      expect(message).toBe(`Error: fetch official release evidence failed: ${category}`);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(token);
    }
  });

  for (const [name, request] of [
    ["network failure", async () => { throw new Error("network failed"); }],
    ["timeout", async () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["HTTP failure", async () => new Response("unavailable", { status: 503 })],
    ["malformed JSON", async () => new Response("{")],
    ["oversized response", async () => new Response("x".repeat(1_048_577))],
  ] as const) {
    test(`rejects a Release API ${name}`, async () => {
      const script = await import("../../scripts/prepare-fork-official-base");
      const readRelease = script.fetchOfficialReleaseEvidence;
      expect(typeof readRelease).toBe("function");
      await expect(readRelease("v2.35.0", request)).rejects.toThrow();
    });
  }

  test("CLI always obtains Release evidence and fails closed on API errors", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-release-cli-"));
    roots.push(root);
    const fakeScript = join(root, "fake-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.shift() !== "--no-lazy-fetch") process.exit(129);\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\\n");\nif (args.includes("ls-remote")) { process.stdout.write("a".repeat(40) + "\\t" + args.at(-2) + "\\n"); process.exit(0); }\nif (args.includes("--exists")) process.exit(2);\nif (args[0] === "rev-parse" && args.includes("--verify")) process.exit(1);\nif (args[0] === "cat-file" && args.at(-1).startsWith("refs/tags/")) process.exit(1);\nif (args.includes("--batch-check=%(objectname) %(objecttype)")) { process.stdout.write("a".repeat(40) + " commit\\n"); process.exit(0); }\nif (args.includes("cat-file")) { process.stdout.write("commit\\n"); process.exit(0); }\nif (args.includes("rev-parse")) process.stdout.write("a".repeat(40) + "\\n");\n`);
    const preload = join(root, "preload.mjs");
    writeFileSync(preload, `import { appendFileSync } from "node:fs";\nconst spawnSync = Bun.spawnSync.bind(Bun);\nBun.spawnSync = (command, options) => {\n  if (command[0] === "git") {\n    appendFileSync(process.env.FAKE_GIT_ENV_LOG, String(Object.keys(options.env ?? {}).some(key => ["OCX_OFFICIAL_RELEASE_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INDEX_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_NAMESPACE"].includes(key.toUpperCase()))) + "\\n");\n    return spawnSync([process.execPath, ${JSON.stringify(fakeScript)}, ...command.slice(1)], options);\n  }\n  return spawnSync(command, options);\n};\nglobalThis.fetch = async (url, init) => {\n  const header = new Headers(init.headers).get("authorization");\n  appendFileSync(process.env.FAKE_RELEASE_LOG, JSON.stringify({ url: String(url), credentials: init.credentials, redirect: init.redirect, authorization: header !== null, usesToken: header === "Bearer " + process.env.OCX_OFFICIAL_RELEASE_API_TOKEN }) + "\\n");\n  if (process.env.FAKE_RELEASE_MODE === "network") throw new Error("network failure");\n  if (process.env.FAKE_RELEASE_MODE === "http") return new Response("unavailable", { status: 503 });\n  if (process.env.FAKE_RELEASE_MODE === "auth-http") return new Response(process.env.OCX_OFFICIAL_RELEASE_API_TOKEN, { status: 403, headers: { "x-ratelimit-remaining": "0" } });\n  return new Response(process.env.FAKE_RELEASE_JSON);\n};\n`);
    const scriptPath = fileURLToPath(new URL("../../scripts/prepare-fork-official-base.ts", import.meta.url));
    const repoRoot = resolveRepoRoot();
    const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const tag = `v${version.split("-ben.")[0]}`;
    for (const mode of ["success", "auth", "network", "http", "auth-http", "invalid"]) {
      const gitLog = join(root, `${mode}-git.jsonl`);
      const gitEnvLog = join(root, `${mode}-git-env.log`);
      const releaseLog = join(root, `${mode}-release.jsonl`);
      const hasToken = mode === "auth" || mode === "auth-http";
      const succeeds = mode === "success" || mode === "auth";
      const result = Bun.spawnSync([process.execPath, "--preload", preload, scriptPath], {
        cwd: repoRoot,
        env: { ...process.env, FAKE_GIT_LOG: gitLog, FAKE_GIT_ENV_LOG: gitEnvLog, FAKE_RELEASE_LOG: releaseLog, FAKE_RELEASE_MODE: mode,
          OCX_OFFICIAL_RELEASE_API_TOKEN: hasToken ? "fixture-cli-api-token" : "",
          GH_TOKEN: "fixture-user-token", GITHUB_TOKEN: "fixture-other-token",
          GH_ENTERPRISE_TOKEN: "fixture-enterprise-token", GITHUB_ENTERPRISE_TOKEN: "fixture-enterprise-other-token",
          gIt_DiR: "must-not-reach-git", GiT_oBjEcT_dIrEcToRy: "must-not-reach-git", GIT_NAMESPACE: "must-not-reach-git",
          FAKE_RELEASE_JSON: JSON.stringify({ tag_name: tag, draft: mode === "invalid", prerelease: false, target_commitish: "a".repeat(40) }) },
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(succeeds ? 0 : 1);
      const stderr = decoder.decode(result.stderr);
      expect(stderr).not.toContain("fixture-cli-api-token");
      expect(stderr).not.toContain("fixture-user-token");
      expect(stderr).not.toContain("fixture-other-token");
      expect(stderr).not.toContain("fixture-enterprise-token");
      expect(stderr).not.toContain("fixture-enterprise-other-token");
      if (mode === "auth-http") expect(stderr).toContain("http-403 rate-limit-exhausted");
      expect(existsSync(releaseLog)).toBe(true);
      const releaseCalls = readFileSync(releaseLog, "utf8").trim().split("\n").map(JSON.parse);
      expect(releaseCalls).toEqual([{
        url: `https://api.github.com/repos/lidge-jun/opencodex/releases/tags/${tag}`,
        credentials: "omit", redirect: "error", authorization: hasToken, usesToken: hasToken,
      }]);
      const calls = existsSync(gitLog) ? readFileSync(gitLog, "utf8").trim().split("\n").map(JSON.parse) as string[][] : [];
      const gitEnvs = existsSync(gitEnvLog) ? readFileSync(gitEnvLog, "utf8").trim().split("\n") : [];
      expect(gitEnvs.every(value => value === "false")).toBe(true);
      const remoteQueries = calls.filter(args => args.includes("ls-remote"));
      expect(remoteQueries).toHaveLength(succeeds || mode === "invalid" ? 1 : 0);
      expect(remoteQueries.every(args => args.includes(`refs/tags/${tag}`) && !args.includes("refs/heads/main"))).toBe(true);
      expect(calls.filter(args => args[0] === "fetch" && args.includes("origin")))
        .toHaveLength(0);
      expect(calls.some(args => args[0] === "update-ref" && args[1] === `refs/tags/${tag}`))
        .toBe(succeeds);
      if (mode === "network" || mode === "http" || mode === "auth-http") {
        expect(calls.some(args => args[0] === "update-ref")).toBe(false);
      }
    }
  });

  test("zero-parent revision syntax preserves commit peeling and rejects non-commit tag targets", () => {
    const fixture = createFixture();
    const repo = fixture.official;
    requireGit(repo, ["tag", "-a", "annotated-commit", "-m", "commit", fixture.officialTagCommit]);
    const tree = requireGit(repo, ["rev-parse", "HEAD^{tree}"]);
    const blob = requireGit(repo, ["hash-object", "-w", "package.json"]);
    for (const [name, object] of [["tree", tree], ["blob", blob]] as const) {
      requireGit(repo, ["tag", name, object]);
      requireGit(repo, ["tag", "-a", `annotated-${name}`, "-m", name, object]);
    }
    for (const [ref, expectedExit] of [
      ["refs/tags/annotated-commit", 0], ["refs/tags/v2.35.0", 0], [fixture.officialTagCommit, 0],
      ["refs/tags/tree", 1], ["refs/tags/blob", 1], ["refs/tags/annotated-tree", 1],
      ["refs/tags/annotated-blob", 1], ["refs/tags/missing", 1],
    ] as const) {
      const original = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      const compatible = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}~0`]);
      expect(original.exitCode).toBe(expectedExit);
      expect(compatible.exitCode).toBe(original.exitCode);
      expect(compatible.stdout).toBe(original.stdout);
      if (expectedExit === 0) expect(compatible.stdout.trim()).toBe(fixture.officialTagCommit);
    }
  });

  test("Fork version commit probe uses a cmd-safe Git revision token", () => {
    const fixture = createReleasedForkFixture();
    const calls: string[][] = [];
    prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    }).run();
    const probe = calls.find(args => args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet");
    expect(probe).toEqual(["rev-parse", "--verify", "--quiet", "refs/tags/v2.35.0-ben.2~0"]);
    expect(probe?.[3]).not.toContain("^");
  });

  test("restores released Fork ancestry across four commits in a real depth-one clone", () => {
    const fixture = createReleasedForkFixture();
    const head = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
    const rawTag = requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0-ben.2"]);
    expect(requireGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(requireGit(fixture.official, ["rev-list", "--count", "v2.35.0-ben.2..HEAD"])).toBe("4");
    expect(releasedForkError(fixture.checkout)).toContain("tag is not on HEAD history");
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      return git(cwd, args, input);
    });
    const refs = requireGit(fixture.checkout, ["show-ref"]);
    prepared.run();
    expect(releasedForkError(fixture.checkout)).toBeNull();
    expect(requireGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(calls.filter(args => args.includes("--unshallow"))).toEqual([
      ["fetch", "--unshallow", "--no-tags", "--no-write-fetch-head", "origin", head],
    ]);
    expect(requireGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(head);
    expect(requireGit(fixture.checkout, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0-ben.2"])).toBe(rawTag);
    expect(requireGit(fixture.checkout, ["show-ref"])).toBe(refs);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("complete Fork history and already-proven shallow ancestry need no unshallow fetch", () => {
    for (const full of [true, false]) {
      const fixture = createReleasedForkFixture({ full });
      if (!full) {
        requireGit(fixture.checkout, ["checkout", "--detach", fixture.officialTagCommit]);
        requireGit(fixture.checkout, ["tag", "-d", "v2.35.0-ben.2"]);
        requireGit(fixture.checkout, ["tag", "v2.35.0-ben.2", "HEAD"]);
      }
      expect(requireGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe(String(!full));
      expect(releasedForkError(fixture.checkout)).toBeNull();
      const shallowPath = resolve(fixture.checkout, requireGit(fixture.checkout, ["rev-parse", "--git-path", "shallow"]));
      const beforeShallow = existsSync(shallowPath) ? readFileSync(shallowPath) : undefined;
      const calls: string[][] = [];
      const prepared = prepare(fixture, undefined, (cwd, args, input) => {
        calls.push([...args]);
        return git(cwd, args, input);
      });
      prepared.run();
      expect(releasedForkError(fixture.checkout)).toBeNull();
      expect(calls.some(args => args.includes("--unshallow"))).toBe(false);
      expect(existsSync(shallowPath) ? readFileSync(shallowPath) : undefined).toEqual(beforeShallow);
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }
  });

  test("unshallow cannot make a real divergent Fork tag pass the unchanged version guard", () => {
    const fixture = createReleasedForkFixture({ diverged: true });
    const head = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
    const rawTag = requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0-ben.2"]);
    const prepared = prepare(fixture);
    const refs = requireGit(fixture.checkout, ["show-ref"]);
    prepared.run();
    expect(requireGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(releasedForkError(fixture.checkout)).toContain("tag is not on HEAD history");
    expect(requireGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(head);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0-ben.2"])).toBe(rawTag);
    expect(requireGit(fixture.checkout, ["show-ref"])).toBe(refs);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("fatal Fork ancestry queries fail before any fetch with redacted diagnostics and cleanup", () => {
    const fixture = createReleasedForkFixture();
    const head = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
    const calls: string[][] = [];
    const prepared = prepare(fixture, undefined, (cwd, args, input) => {
      calls.push([...args]);
      if (args[0] === "merge-base") {
        return { exitCode: 128, stdout: "", stderr: `fatal ancestry query:\n${hostileGitDiagnostic(fixture.checkout)}` };
      }
      return git(cwd, args, input);
    });
    const refs = requireGit(fixture.checkout, ["show-ref"]);
    let message = "";
    try { prepared.run(); } catch (error) { message = String(error); }
    expect(message).toContain("fetch Fork version history: fatal ancestry query:");
    expect(message).toContain("[CREDENTIAL HEADER REDACTED]");
    expect(message).toContain("[REDACTED_PATH]");
    expect(message.length).toBeLessThanOrEqual(519);
    for (const leaked of [fixture.checkout, "secret-token", "Authorization: Bearer", "private-name", "\u0007", "\u2028"]) {
      expect(message).not.toContain(leaked);
    }
    expect(calls.some(args => args.includes("fetch"))).toBe(false);
    expect(requireGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(head);
    expect(requireGit(fixture.checkout, ["show-ref"])).toBe(refs);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("Fork history fetch failure stays closed, redacted, and cleaned up", () => {
    for (const throws of [false, true]) {
      const fixture = createReleasedForkFixture();
      const head = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
      const rawTag = requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0-ben.2"]);
      const calls: string[][] = [];
      const prepared = prepare(fixture, undefined, (cwd, args, input) => {
        calls.push([...args]);
        if (args.includes("--unshallow")) {
          const stderr = hostileGitDiagnostic(fixture.checkout);
          if (throws) throw new Error(stderr);
          return { exitCode: 1, stdout: "", stderr };
        }
        return git(cwd, args, input);
      });
      let message = "";
      try { prepared.run(); } catch (error) { message = String(error); }
      expect(message).toContain("fetch Fork version history:");
      expect(message).toContain("[CREDENTIAL HEADER REDACTED]");
      expect(message).toContain("[REDACTED_PATH]");
      expect(message.length).toBeLessThanOrEqual(519);
      for (const leaked of [fixture.checkout, "secret-token", "Authorization: Bearer", "private-name", "\u0007", "\u2028"]) {
        expect(message).not.toContain(leaked);
      }
      expect(calls.some(args => args.includes("fetch") && !args.includes("--unshallow"))).toBe(false);
      expect(requireGit(fixture.checkout, ["rev-parse", "HEAD"])).toBe(head);
      expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0-ben.2"])).toBe(rawTag);
      expect(releasedForkError(fixture.checkout)).toContain("tag is not on HEAD history");
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }
  });

  test("leaves an unrelated origin marker unchanged after verifying the official tag", () => {
    const fixture = createFixture();
    const different = requireGit(fixture.official, ["rev-parse", "refs/heads/main"]);
    requireGit(fixture.official, ["push", pathToFileURL(fixture.originBare).href,
      `${different}:refs/heads/upstream-release`,
    ]);
    const prepared = prepare(fixture);
    expect(prepared.run()).toMatchObject({ kind: "prepared", peeledCommit: fixture.officialTagCommit });
    expect(requireGit(fixture.originBare, ["rev-parse", "refs/heads/upstream-release"])).toBe(different);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("candidate CI accepts a verified official tag without a marker option", () => {
    const fixture = createFixture();
    const rootCommit = requireGit(fixture.official, ["rev-list", "--max-parents=0", "refs/heads/main"]);
    requireGit(fixture.originBare, ["update-ref", "refs/heads/upstream-release", rootCommit]);
    const prepared = prepare(fixture);
    const result = runAsCandidate(prepared.run);
    expect(result).toMatchObject({ kind: "prepared", tag: "v2.35.0", peeledCommit: fixture.officialTagCommit });
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("candidate CI rejects mismatched Release evidence despite an origin marker", () => {
    const fixture = createFixture();
    const different = requireGit(fixture.official, ["rev-parse", "refs/heads/main"]);
    requireGit(fixture.originBare, ["update-ref", "refs/heads/upstream-release", different]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: different,
    } });
    expect(() => runAsCandidate(prepared.run)).toThrow("invalid official release evidence");
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("a non-candidate environment still requires valid Release evidence", () => {
    const fixture = createFixture();
    const rootCommit = requireGit(fixture.official, ["rev-list", "--max-parents=0", "refs/heads/main"]);
    requireGit(fixture.originBare, ["update-ref", "refs/heads/upstream-release", rootCommit]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: true, prerelease: false, target_commitish: fixture.officialTagCommit,
    } });
    expect(() => runOutsideCandidate(prepared.run)).toThrow("invalid official release evidence");
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  for (const [name, environment] of [
    ["local dispatch", { GITHUB_ACTIONS: "false" }],
    ["missing Actions marker", { GITHUB_ACTIONS: undefined }],
    ["main dispatch", { GITHUB_REF: "refs/heads/main" }],
    ["preview dispatch", { GITHUB_REF: "refs/heads/preview" }],
    ["tag dispatch", { GITHUB_REF: "refs/tags/v2.35.0" }],
    ["legacy dev push", { GITHUB_EVENT_NAME: "push" }],
    ["scheduled dev run", { GITHUB_EVENT_NAME: "schedule" }],
    ["pull request", { GITHUB_EVENT_NAME: "pull_request" }],
    ["missing lane", { OCX_CANDIDATE_CI_LANE: undefined }],
    ["empty lane", { OCX_CANDIDATE_CI_LANE: "" }],
    ["release-only lane", { OCX_CANDIDATE_CI_LANE: "release-gates" }],
    ["macOS control lane", { OCX_CANDIDATE_CI_LANE: "macos-control" }],
    ["unknown lane", { OCX_CANDIDATE_CI_LANE: "unknown" }],
  ] as const) {
    test(`requires a formal Release in ${name}`, () => {
      const fixture = createFixture();
      const rootCommit = requireGit(fixture.official, ["rev-list", "--max-parents=0", "refs/heads/main"]);
      requireGit(fixture.originBare, ["update-ref", "refs/heads/upstream-release", rootCommit]);
      const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
        tag_name: "v2.35.0", draft: true, prerelease: false, target_commitish: fixture.officialTagCommit,
      } });
      expect(() => runAsCandidate(prepared.run, environment))
        .toThrow("invalid official release evidence");
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    });
  }

  test("full dev dispatch still requires Release evidence", () => {
    const fixture = createFixture();
    const rootCommit = requireGit(fixture.official, ["rev-list", "--max-parents=0", "refs/heads/main"]);
    requireGit(fixture.originBare, ["update-ref", "refs/heads/upstream-release", rootCommit]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: undefined });
    expect(() => runAsCandidate(prepared.run)).toThrow("official release evidence required");
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("imports an independently annotated official tag without losing its tag object", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "official v2.35.0", fixture.officialTagCommit]);
    const prepared = prepare(fixture);
    const result = prepared.run();
    const officialRaw = requireGit(fixture.official, ["rev-parse", "refs/tags/v2.35.0"]);
    expect(result).toEqual({
      kind: "prepared",
      version: "2.35.0-ben.2",
      tag: "v2.35.0",
      refKind: "annotated",
      rawTagOid: officialRaw,
      peeledCommit: fixture.officialTagCommit,
    });
    expect(officialRaw).not.toBe(fixture.officialTagCommit);
    expect(requireGit(fixture.checkout, ["cat-file", "-t", "refs/tags/v2.35.0"])).toBe("tag");
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(officialRaw);
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0^{commit}"]))
      .toBe(fixture.officialTagCommit);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects blob and tree official refs rather than treating them as tags", () => {
    for (const kind of ["blob", "tree"] as const) {
      const fixture = createFixture();
      requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
      const object = kind === "blob"
        ? requireGit(fixture.official, ["hash-object", "-w", "package.json"])
        : requireGit(fixture.official, ["write-tree"]);
      requireGit(fixture.official, ["update-ref", "refs/tags/v2.35.0", object]);
      const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
        tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: object,
      } });
      expect(prepared.run).toThrow("official release ref has unsupported object type");
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }
  });

  test("rejects an annotated tag whose commit is outside checkout ancestry", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["checkout", "--orphan", "not-main"]);
    requireGit(fixture.official, ["rm", "-rf", "."]);
    writeFileSync(join(fixture.official, "unrelated.txt"), "unrelated\n");
    requireGit(fixture.official, ["add", "unrelated.txt"]);
    requireGit(fixture.official, ["commit", "-m", "unrelated tag commit"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "not on main"]);
    const unrelated = requireGit(fixture.official, ["rev-parse", "HEAD"]);
    const prepared = prepare(fixture, undefined, undefined, { officialReleaseEvidence: {
      tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: unrelated,
    } });
    expect(prepared.run).toThrow("verify official ancestry:");
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a local same-name forged tag instead of overwriting it", () => {
    const fixture = createFixture();
    const forged = requireGit(fixture.checkout, ["rev-parse", "HEAD"]);
    requireGit(fixture.checkout, ["tag", "-a", "v2.35.0", "-m", "forged", forged]);
    const forgedRaw = requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"]);
    const prepared = prepare(fixture);
    expect(prepared.run).toThrow("existing local official tag does not match verified official tag");
    expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(forgedRaw);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects a pre-existing blob or tree local ref before zero-OID publication", () => {
    for (const kind of ["blob", "tree"] as const) {
      const fixture = createFixture();
      const object = kind === "blob"
        ? requireGit(fixture.checkout, ["hash-object", "-w", "package.json"])
        : requireGit(fixture.checkout, ["write-tree"]);
      requireGit(fixture.checkout, ["update-ref", "refs/tags/v2.35.0", object]);
      const prepared = prepare(fixture);
      expect(prepared.run).toThrow("existing local official tag has unsupported object type");
      expect(requireGit(fixture.checkout, ["rev-parse", "refs/tags/v2.35.0"])).toBe(object);
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }
  });

  test("keeps an identical official tag and rejects missing tag or repository", () => {
    const fixture = createFixture();
    const first = prepare(fixture);
    first.run();
    const second = prepare(fixture);
    expect(second.run()).toMatchObject({ kind: "prepared", tag: "v2.35.0" });
    assertNoOwnedResidue(fixture, second.beforeFetchHead, second.sentinel, second.beforeVerifierRoots);

    const broken = createFixture();
    requireGit(broken.official, ["tag", "-d", "v2.35.0"]);
    const missing = prepare(broken);
    expect(missing.run).toThrow();
    assertNoOwnedResidue(broken, missing.beforeFetchHead, missing.sentinel, missing.beforeVerifierRoots);

    const unavailable = createFixture();
    const prepared = prepare(unavailable, pathToFileURL(join(unavailable.root, "missing.git")).href);
    expect(prepared.run).toThrow("verify official tag:");
    assertNoOwnedResidue(unavailable, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("redacts hostile Git diagnostics to one bounded line", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-official-secret-"));
    roots.push(root);
    const hostile = hostileGitDiagnostic(join(realpathSync(root), "repo.git"));
    expect(hostile.length).toBeGreaterThan(4096);
    expect(hostile.length).toBeLessThanOrEqual(8192);
    const message = safeGitDiagnostic("fetch official refs", new Error(hostile), [
      root, realpathSync(root), join(root, "repo.git"), join(realpathSync(root), "repo.git"),
    ]);
    for (const leaked of ["user", "secret-token", "Authorization: Bearer", "private-name", "linux-private", "windows-private", "ocx-fork-official-secret", "?access_token", "#private-fragment", "\n", "\u0007", "\u2028"]) {
      expect(message).not.toContain(leaked);
    }
    expect(message).toContain("[CREDENTIAL HEADER REDACTED]");
    expect(message).toContain("[REDACTED_PATH]");
    expect(message.length).toBeLessThanOrEqual(512);
  });

  test("keeps the primary failure while reporting a cleanup-only failure safely", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-cleanup-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
    let cleanupCalls = 0;
    const primaryRunner = (_cwd: string, args: readonly string[]) => {
      if (args.includes("ls-remote")) return { exitCode: 0, stdout: `${"a".repeat(40)}\trefs/tags/v2.35.0\n`, stderr: "" };
      if (args.includes("--exists")) return { exitCode: 2, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--verify")) return { exitCode: 1, stdout: "", stderr: "" };
      if (args.includes("fetch") && args.includes("https://example.invalid/official.git")) {
        return { exitCode: 1, stdout: "", stderr: "official fetch failure" };
      }
      if (args[0] === "update-ref" && args[1] === "-d" && cleanupCalls++ >= 1) {
        throw new Error(`cleanup ${"secret" + "-token"}`);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let primaryMessage = "";
    try {
      prepareForkOfficialBase({
        repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: primaryRunner,
        officialReleaseEvidence: { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) },
      });
    } catch (error) {
      primaryMessage = error instanceof Error ? error.message : String(error);
    }
    expect(primaryMessage).toBe("prepare official base: fetch official refs: official fetch failure; cleanup also failed");

    let cleanupOnlyDeletes = 0;
    const cleanupOnlyRunner = (_cwd: string, args: readonly string[]) => {
      if (args.includes("ls-remote")) return { exitCode: 0, stdout:
        `${"b".repeat(40)}\trefs/tags/v2.35.0\n${"a".repeat(40)}\trefs/tags/v2.35.0^{}\n`, stderr: "" };
      if (args.includes("--exists")) return { exitCode: 2, stdout: "", stderr: "" };
      if (args[0] === "update-ref" && args[1] === "-d" && cleanupOnlyDeletes++ >= 1) {
        throw new Error(`cleanup ${"secret" + "-token"}`);
      }
      if (args.includes("--batch-check=%(objectname) %(objecttype)")) {
        return { exitCode: 0, stdout: `${"a".repeat(40)} commit\n`, stderr: "" };
      }
      if (args.includes("cat-file")) return { exitCode: 0, stdout: "tag\n", stderr: "" };
      if (args.includes("merge-base")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("rev-parse") && args.some(value => value.includes("^{commit}"))) {
        return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        if (args.includes("refs/tags/v2.35.0") && !args.some(value => value.startsWith("--git-dir="))) {
          return { exitCode: 1, stdout: "", stderr: "missing local tag" };
        }
        return { exitCode: 0, stdout: "b".repeat(40) + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let cleanupMessage = "";
    try {
      prepareForkOfficialBase({
        repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: cleanupOnlyRunner,
        officialReleaseEvidence: { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) },
      });
    } catch (error) {
      cleanupMessage = error instanceof Error ? error.message : String(error);
    }
    expect(cleanupMessage).toStartWith("cleanup official verifier:");
    expect(cleanupMessage).not.toContain("secret-token");
  });

  test("runner throws during a primary Git operation without leaking its owned bare path", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-throw-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
    let bareDir = "";
    const runner = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "init") bareDir = args[2] ?? "";
      if (args.includes("ls-remote")) return { exitCode: 0, stdout: `${"a".repeat(40)}\trefs/tags/v2.35.0\n`, stderr: "" };
      if (args.includes("--exists")) return { exitCode: 2, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--verify")) return { exitCode: 1, stdout: "", stderr: "" };
      if (args.includes("fetch") && args.includes("https://example.invalid/official.git")) throw new Error(`primary ${bareDir}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let message = "";
    try {
      prepareForkOfficialBase({ repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: runner,
        officialReleaseEvidence: { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("prepare official base: fetch official refs:");
    expect(message).not.toContain(bareDir);
    expect(existsSync(dirname(bareDir))).toBe(false);
  });

  test("post-mkdtemp setup failure cleans the owned ref and verifier root", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-setup-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
    let bareDir = "";
    let deletions = 0;
    const runner = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "update-ref" && args[1] === "-d") deletions += 1;
      if (args[0] === "init") {
        bareDir = args[2] ?? "";
        return { exitCode: 1, stdout: "", stderr: `cannot initialize ${bareDir}` };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let message = "";
    try {
      prepareForkOfficialBase({ repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: runner,
        officialReleaseEvidence: { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("prepare official base: init official verifier:");
    expect(message).toContain("[REDACTED_PATH]");
    expect(message).not.toContain(bareDir);
    expect(deletions).toBe(1);
    expect(existsSync(dirname(bareDir))).toBe(false);
  });

  test("raw chmod setup failure folds the verifier path and still invokes supplied cleanup runner", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-fs-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
    let verifierRoot = "";
    let deletions = 0;
    const runner = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "update-ref" && args[1] === "-d") deletions += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let message = "";
    try {
      prepareForkOfficialBase({
        repoRoot: root,
        officialRepositoryUrl: "https://example.invalid/official.git",
        runGit: runner,
        officialReleaseEvidence: { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) },
        filesystem: {
          chmodSync(path) {
            verifierRoot = String(path);
            throw new Error(`cannot chmod ${verifierRoot}`);
          },
          writeFileSync,
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("prepare official base:");
    expect(message).toContain("[REDACTED_PATH]");
    expect(message).not.toContain(verifierRoot);
    expect(deletions).toBe(1);
    expect(existsSync(verifierRoot)).toBe(false);
  });

  test("default production runner cleans the owned ref after raw chmod failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-default-fs-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
    const fakeBin = join(root, "fake-bin");
    const fakeLog = join(root, "default-runner.jsonl");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, process.platform === "win32" ? "git.cmd" : "git");
    const fakeScript = join(root, "default-runner-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.shift() !== "--no-lazy-fetch") process.exit(129);\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\\n");\n`);
    if (process.platform === "win32") writeFileSync(fakeGit, `@echo off\n"${process.execPath}" "${fakeScript}" %*\n`);
    else {
      writeFileSync(fakeGit, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
      chmodSync(fakeGit, 0o755);
    }
    const previousPath = process.env.PATH;
    const previousLog = process.env.FAKE_GIT_LOG;
    let verifierRoot = "";
    let message = "";
    try {
      process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
      process.env.FAKE_GIT_LOG = fakeLog;
      prepareForkOfficialBase({
        repoRoot: root,
        officialRepositoryUrl: "https://example.invalid/official.git",
        officialReleaseEvidence: { tag_name: "v2.35.0", draft: false, prerelease: false, target_commitish: "a".repeat(40) },
        filesystem: {
          chmodSync(path) {
            verifierRoot = String(path);
            throw new Error(`raw chmod ${verifierRoot}`);
          },
          writeFileSync,
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.FAKE_GIT_LOG;
      else process.env.FAKE_GIT_LOG = previousLog;
    }
    const calls = readFileSync(fakeLog, "utf8").trim().split("\n").map(JSON.parse) as string[][];
    expect(message).toContain("[REDACTED_PATH]");
    expect(message).not.toContain(verifierRoot);
    expect(calls).toEqual([
      ["update-ref", "-d", "refs/ocx-ci/official-tag"],
    ]);
    expect(existsSync(verifierRoot)).toBe(false);
  });

  test("direct production entry sandboxes Git environment, fixed URL, long hostile output, and cleanup suffix", () => {
    const fixture = createFixture();
    const fakeBin = join(fixture.root, "fake-bin");
    const fakeGitLog = join(fixture.root, "git-args.jsonl");
    mkdirSync(fakeBin);
    const fakeScript = join(fixture.root, "fake-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.shift() !== "--no-lazy-fetch") process.exit(129);\nconst rows = (() => { try { return readFileSync(process.env.FAKE_GIT_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();\nconst env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_CONFIG") || key.toUpperCase() === "PATH"));\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args, env }) + "\\n");\nconst deletes = rows.filter(row => row.args?.[0] === "update-ref" && row.args?.[1] === "-d").length;\nconst bare = rows.flatMap(row => row.args?.[0] === "init" ? [row.args[2]] : row.args ?? []).find(value => value?.startsWith("--git-dir="))?.slice("--git-dir=".length) ?? rows.find(row => row.args?.[0] === "init")?.args?.[2] ?? "";\nif (args.includes("ls-remote")) { process.stdout.write("a".repeat(40) + "\\t" + args.at(-2) + "\\n"); process.exit(0); }\nif (args.includes("--exists")) process.exit(2);\nif (args[0] === "rev-parse" && args.includes("--verify")) process.exit(1);\nif (args.includes("fetch") && args.includes("https://github.com/lidge-jun/opencodex.git")) { process.stderr.write(bare + "\\n" + process.env.FAKE_GIT_ERROR); process.exit(1); }\nif (args[0] === "update-ref" && args[1] === "-d" && deletes >= 1) { process.stderr.write("cleanup " + bare); process.exit(1); }\nprocess.exit(0);\n`);
    const fakeGit = join(fakeBin, process.platform === "win32" ? "git.cmd" : "git");
    if (process.platform === "win32") {
      writeFileSync(fakeGit, `@echo off\n"${process.execPath}" "${fakeScript}" %*\n`);
    } else {
      writeFileSync(fakeGit, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
      chmodSync(fakeGit, 0o755);
    }
    const scriptPath = fileURLToPath(new URL("../../scripts/prepare-fork-official-base.ts", import.meta.url));
    const repoRoot = resolveRepoRoot();
    const preload = join(fixture.root, "release-preload.mjs");
    writeFileSync(preload, `globalThis.fetch = async url => Response.json({ tag_name: String(url).split("/").at(-1), draft: false, prerelease: false, target_commitish: "a".repeat(40) });\n`);
    const hostile = hostileGitDiagnostic(join(repoRoot, "repo.git"));
    expect(hostile.length).toBeGreaterThan(4096);
    expect(hostile.length).toBeLessThanOrEqual(8192);
    const result = Bun.spawnSync([process.execPath, "--preload", preload, scriptPath, "https://evil.invalid/override"], {
      cwd: repoRoot,
      env: fakeGitEnvironment(fakeBin, {
        gIt_cOnFiG_cOuNt: "must-not-reach-fake-git",
        OCX_OFFICIAL_REPOSITORY_URL: "https://evil.invalid/from-env",
        FAKE_GIT_LOG: fakeGitLog,
        FAKE_GIT_ERROR: hostile,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = decoder.decode(result.stderr);
    expect(result.exitCode).not.toBe(0);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(stderr.split("\n").filter(Boolean)).toHaveLength(1);
    expect(stderr.length).toBeLessThanOrEqual(513);
    for (const leaked of ["user", "secret-token", "Authorization: Bearer", "private-name", "linux-private", "windows-private", "ocx-fork-official-secret", "?access_token", "#private-fragment", "\u0007", "\u2028"]) {
      expect(stderr).not.toContain(leaked);
    }
    expect(stderr).toContain("[CREDENTIAL HEADER REDACTED]");
    expect(stderr).toContain("[REDACTED_PATH]");
    expect(stderr.trimEnd()).toEndWith("; cleanup also failed");
    const lines = readFileSync(fakeGitLog, "utf8").trim().split("\n").map(JSON.parse) as Array<{ args: string[]; env: Record<string, string> }>;
    const officialFetch = lines.find(row => row.args.includes("fetch") && row.args.includes("https://github.com/lidge-jun/opencodex.git"));
    const generatedBareDir = lines.find(row => row.args[0] === "init")?.args[2] ?? "";
    expect(officialFetch).toBeDefined();
    expect(JSON.stringify(lines)).not.toContain("https://evil.invalid");
    expect(Object.keys(officialFetch?.env ?? {}).every(key => ["PATH", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key))).toBe(true);
    expect(Object.keys(officialFetch?.env ?? {})).not.toContain("gIt_cOnFiG_cOuNt");
    expect(stderr).not.toContain(generatedBareDir);
  });

  test("normal module import performs zero Git calls", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-import-"));
    roots.push(root);
    const fakeBin = join(root, "fake-bin");
    const fakeLog = join(root, "calls.log");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, process.platform === "win32" ? "git.cmd" : "git");
    const payload = process.platform === "win32"
      ? `@echo off\necho invoked>>"${fakeLog}"\nexit /b 1\n`
      : `#!/bin/sh\nprintf invoked >> "${fakeLog}"\nexit 1\n`;
    writeFileSync(fakeGit, payload);
    if (process.platform !== "win32") chmodSync(fakeGit, 0o755);
    const scriptUrl = pathToFileURL(fileURLToPath(new URL("../../scripts/prepare-fork-official-base.ts", import.meta.url))).href;
    const result = Bun.spawnSync([process.execPath, "--eval", `import(${JSON.stringify(scriptUrl)})`], {
      cwd: root,
      env: fakeGitEnvironment(fakeBin),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(fakeLog)).toBe(false, decoder.decode(result.stderr));
  });

  test("direct production entry redacts the generated bare path on a cleanup-only failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-cli-cleanup-"));
    roots.push(root);
    const fakeLog = join(root, "calls.jsonl");
    const fakeScript = join(root, "fake-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.shift() !== "--no-lazy-fetch") process.exit(129);\nconst rows = (() => { try { return readFileSync(process.env.FAKE_GIT_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\\n");\nconst bare = rows.find(row => row[0] === "init")?.[2] ?? "";\nconst deletes = rows.filter(row => row[0] === "update-ref" && row[1] === "-d").length;\nif (args.includes("ls-remote")) { process.stdout.write("b".repeat(40) + "\\t" + args.at(-2) + "\\n" + "a".repeat(40) + "\\t" + args.at(-2) + "^{}\\n"); process.exit(0); }\nif (args.includes("--exists")) process.exit(2);\nif (args[0] === "rev-parse" && args.includes("--verify")) process.exit(1);\nif (args[0] === "update-ref" && args[1] === "-d" && deletes >= 1) { process.stderr.write("cleanup " + bare); process.exit(1); }\nif (args.includes("--batch-check=%(objectname) %(objecttype)")) { process.stdout.write("a".repeat(40) + " commit\\n"); process.exit(0); }\nif (args.includes("cat-file")) { process.stdout.write("tag\\n"); process.exit(0); }\nif (args.includes("rev-parse")) { if (args[1]?.startsWith("refs/tags/") && !args.some(value => value.startsWith("--git-dir="))) process.exit(1); process.stdout.write(args.some(value => value.includes("^{commit}")) ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n"); process.exit(0); }\nprocess.exit(0);\n`);
    const preload = join(root, "git-preload.mjs");
    // Keep the real CLI entry while passing Git argv through a native executable on Windows.
    writeFileSync(preload, `const spawnSync = Bun.spawnSync.bind(Bun);\nBun.spawnSync = (command, options) => spawnSync(command[0] === "git" ? [process.execPath, ${JSON.stringify(fakeScript)}, ...command.slice(1)] : command, options);\nglobalThis.fetch = async url => Response.json({ tag_name: String(url).split("/").at(-1), draft: false, prerelease: false, target_commitish: "a".repeat(40) });\n`);
    const scriptPath = fileURLToPath(new URL("../../scripts/prepare-fork-official-base.ts", import.meta.url));
    const repoRoot = resolveRepoRoot();
    const { version } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const result = Bun.spawnSync([process.execPath, "--preload", preload, scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, FAKE_GIT_LOG: fakeLog },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = decoder.decode(result.stderr);
    const rows = readFileSync(fakeLog, "utf8").trim().split("\n").map(JSON.parse) as string[][];
    const bareDir = rows.find(row => row[0] === "init")?.[2] ?? "";
    const tagRef = `refs/tags/v${version.split("-ben.")[0]}`;
    expect(result.exitCode).not.toBe(0);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(stderr.split("\n").filter(Boolean)).toHaveLength(1);
    expect(stderr.length).toBeLessThanOrEqual(513);
    expect(stderr).toContain("[REDACTED_PATH]");
    expect(stderr).not.toContain(bareDir);
    expect(stderr).toStartWith("prepare official base: cleanup official verifier: cleanup ");
    expect(stderr).not.toContain("cleanup also failed");
    expect(bareDir).not.toBe("");
    expect(rows).toContainEqual([`--git-dir=${bareDir}`, "rev-parse", `${tagRef}^{commit}`]);
    expect(rows).toContainEqual(["rev-parse", "refs/ocx-ci/official-tag^{commit}"]);
    expect(rows).toContainEqual(["update-ref", tagRef, "b".repeat(40), "0".repeat(40)]);
    expect(rows.slice(-1)).toEqual([
      ["update-ref", "-d", "refs/ocx-ci/official-tag"],
    ]);
    expect(existsSync(dirname(bareDir))).toBe(false);
  });

  test("requires official-base preparation wherever the workflow opts into Fork provenance", async () => {
    type WorkflowJob = {
      name?: string;
      needs?: string | string[];
      if?: string;
      "runs-on"?: unknown;
      permissions?: Record<string, string>;
      strategy?: { matrix?: { os?: string[] } };
      steps?: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }>;
    };
    type Workflow = {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      permissions?: Record<string, string>;
      jobs?: Record<string, WorkflowJob | undefined>;
    };

    const workflow = await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text();
    const ci = Bun.YAML.parse(workflow) as Workflow;
    const prepareName = "Prepare verified Fork official base";
    const prepareRun = "bun scripts/prepare-fork-official-base.ts";
    const prepareSteps = Object.entries(ci.jobs ?? {}).flatMap(([jobName, job]) =>
      (job?.steps ?? [])
        .filter(step => step.run === prepareRun)
        .map(step => ({ jobName, step })),
    );
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(prepareSteps).toHaveLength(4);
    for (const { jobName } of prepareSteps) {
      const steps = ci.jobs?.[jobName]?.steps ?? [];
      const matching = prepareSteps.filter(step => step.jobName === jobName);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.step.name).toBe(prepareName);
      expect(matching[0]?.step.env?.OCX_CANDIDATE_CI_LANE).toBeUndefined();
      expect(matching[0]?.step.env?.OCX_OFFICIAL_RELEASE_API_TOKEN).toBe("${{ github.token }}");
      expect(ci.jobs?.[jobName]?.permissions).toBeUndefined();
      const prepareIndex = steps.indexOf(matching[0]!.step);
      const setupIndex = steps.findIndex(step => step.name === "Setup project Bun");
      const installIndex = steps.findIndex(step => step.name === "Install dependencies");
      const testIndex = steps.findIndex(step => /^Test\b/.test(step.name ?? ""));
      expect(setupIndex).toBeGreaterThanOrEqual(0);
      expect(installIndex).toBeGreaterThanOrEqual(0);
      expect(testIndex).toBeGreaterThanOrEqual(0);
      expect(prepareIndex).toBeGreaterThan(setupIndex);
      expect(prepareIndex).toBe(setupIndex + 1);
      expect(prepareIndex).toBeLessThan(installIndex);
      expect(prepareIndex).toBeLessThan(testIndex);
    }

    expect(await Bun.file(new URL("../../.github/actions/setup-project-bun/action.yml", import.meta.url)).text())
      .not.toContain(prepareRun);

    // Official job names, shard counts, runners, dispatch inputs and timeouts are
    // intentionally left to the upstream workflow and its own tests.
  });
});
