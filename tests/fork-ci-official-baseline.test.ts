import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyPackageVersion,
  prepareForkOfficialBase,
  safeGitDiagnostic,
} from "../scripts/prepare-fork-official-base";

const decoder = new TextDecoder();
const roots: string[] = [];

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

function git(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
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

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-"));
  roots.push(root);
  const official = join(root, "official");
  const originBare = join(root, "origin.git");
  const checkout = join(root, "checkout");
  mkdirSync(official);
  requireGit(official, ["init", "--initial-branch=main"]);
  requireGit(official, ["config", "user.name", "Fixture"]);
  requireGit(official, ["config", "user.email", "fixture" + "@" + "example.invalid"]);
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

function fetchHeadSnapshot(repo: string): string | undefined {
  const rawPath = requireGit(repo, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  const path = isAbsolute(rawPath) ? rawPath : resolve(repo, rawPath);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function assertNoOwnedResidue(
  fixture: Fixture,
  beforeFetchHead: string | undefined,
  sentinel: string,
  beforeVerifierRoots: string[],
) {
  for (const ref of ["refs/ocx-ci/fork-marker", "refs/ocx-ci/official-tag"]) {
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", ref]).exitCode).not.toBe(0);
  }
  expect(fetchHeadSnapshot(fixture.checkout)).toBe(beforeFetchHead);
  expect(requireGit(fixture.checkout, ["rev-parse", "refs/heads/keep-sentinel"])).toBe(sentinel);
  expect(verifierRoots()).toEqual(beforeVerifierRoots);
}

function verifierRoots(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith("ocx-fork-official-")).sort();
}

function prepare(
  fixture: Fixture,
  officialUrl = pathToFileURL(fixture.official).href,
  runGit?: (cwd: string, args: readonly string[]) => ReturnType<typeof git>,
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
    run: () => prepareForkOfficialBase({ repoRoot: fixture.checkout, officialRepositoryUrl: officialUrl, runGit }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

  test("imports the observed lightweight official tag into an origin-only shallow checkout", () => {
    const fixture = createFixture();
    expect(requireGit(fixture.checkout, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(fixture.checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode).not.toBe(0);
    expect(requireGit(fixture.checkout, ["tag", "--list", "v*"]).split("\n").filter(Boolean)).toEqual(["v2.35.0-ben.1"]);
    expect(requireGit(fixture.official, ["rev-list", "--count", `${fixture.officialTagCommit}..refs/heads/main`])).toBe("2");
    const calls: string[][] = [];
    const prepared = prepare(fixture, pathToFileURL(fixture.official).href, (cwd, args) => {
      calls.push([...args]);
      return git(cwd, args);
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
      `--git-dir=${bareDir}`, "fetch", "--no-tags", "--filter=blob:none", pathToFileURL(fixture.official).href,
      "+refs/heads/main:refs/heads/official-main", "+refs/tags/v2.35.0:refs/tags/v2.35.0",
    ]);
    expect(officialFetch?.some(arg => arg === "--depth" || arg.startsWith("--depth=")
      || arg.startsWith("--shallow") || arg === "--unshallow")).toBe(false);
    const checkoutFetches = calls.filter(args => args.includes("fetch") && !args.includes(pathToFileURL(fixture.official).href));
    expect(checkoutFetches.every(args => args.includes("--no-write-fetch-head"))).toBe(true);
    const index = (needle: string) => calls.findIndex(args => args.includes(needle));
    const bareType = calls.findIndex(args => args.includes("cat-file") && args.includes("refs/tags/v2.35.0"));
    const bareRaw = calls.findIndex((args, position) => position > bareType && args.includes("rev-parse") && args.includes("refs/tags/v2.35.0"));
    const barePeeled = calls.findIndex((args, position) => position > bareRaw && args.includes("rev-parse") && args.includes("refs/tags/v2.35.0^{commit}"));
    expect(bareType).toBeGreaterThan(-1);
    expect(bareRaw).toBeGreaterThan(bareType);
    expect(barePeeled).toBeGreaterThan(bareRaw);
    expect(index("merge-base")).toBeGreaterThan(barePeeled);
    const importIndex = calls.findIndex((args, position) => position > index("merge-base")
      && args.includes("fetch") && bareDir !== undefined && args.includes(bareDir));
    expect(importIndex).toBeGreaterThan(index("merge-base"));
    const checkoutType = calls.findIndex((args, position) => position > importIndex
      && args.includes("cat-file") && args.includes("refs/ocx-ci/official-tag"));
    const checkoutRaw = calls.findIndex((args, position) => position > checkoutType
      && args.includes("rev-parse") && args.includes("refs/ocx-ci/official-tag"));
    const checkoutPeeled = calls.findIndex((args, position) => position > checkoutRaw
      && args.includes("rev-parse") && args.includes("refs/ocx-ci/official-tag^{commit}"));
    expect(checkoutType).toBeGreaterThan(importIndex);
    expect(checkoutRaw).toBeGreaterThan(checkoutType);
    expect(checkoutPeeled).toBeGreaterThan(checkoutRaw);
    assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
  });

  test("rejects an origin marker that does not equal the verified official tag", () => {
    const fixture = createFixture();
    const different = requireGit(fixture.official, ["rev-parse", "refs/heads/main"]);
    requireGit(fixture.official, ["push", pathToFileURL(fixture.originBare).href,
      `${different}:refs/heads/upstream-release`,
    ]);
    const prepared = prepare(fixture);
    expect(prepared.run).toThrow("official release tag does not match origin upstream-release");
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
      const prepared = prepare(fixture);
      expect(prepared.run).toThrow("official release ref has unsupported object type");
      assertNoOwnedResidue(fixture, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }
  });

  test("rejects an annotated tag whose commit is outside official main ancestry", () => {
    const fixture = createFixture();
    requireGit(fixture.official, ["tag", "-d", "v2.35.0"]);
    requireGit(fixture.official, ["checkout", "--orphan", "not-main"]);
    requireGit(fixture.official, ["rm", "-rf", "."]);
    writeFileSync(join(fixture.official, "unrelated.txt"), "unrelated\n");
    requireGit(fixture.official, ["add", "unrelated.txt"]);
    requireGit(fixture.official, ["commit", "-m", "unrelated tag commit"]);
    requireGit(fixture.official, ["tag", "-a", "v2.35.0", "-m", "not on main"]);
    const prepared = prepare(fixture);
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

  test("keeps an existing identical official tag and rejects missing marker, tag, main, and fetch failures", () => {
    const fixture = createFixture();
    const first = prepare(fixture);
    first.run();
    const second = prepare(fixture);
    expect(second.run()).toMatchObject({ kind: "prepared", tag: "v2.35.0" });
    assertNoOwnedResidue(fixture, second.beforeFetchHead, second.sentinel, second.beforeVerifierRoots);

    for (const mutation of ["marker", "tag", "main"] as const) {
      const broken = createFixture();
      if (mutation === "marker") requireGit(broken.originBare, ["update-ref", "-d", "refs/heads/upstream-release"]);
      if (mutation === "tag") requireGit(broken.official, ["tag", "-d", "v2.35.0"]);
      if (mutation === "main") requireGit(broken.official, ["branch", "-m", "main", "without-main"]);
      const prepared = prepare(broken);
      expect(prepared.run).toThrow();
      assertNoOwnedResidue(broken, prepared.beforeFetchHead, prepared.sentinel, prepared.beforeVerifierRoots);
    }

    const unavailable = createFixture();
    const prepared = prepare(unavailable, pathToFileURL(join(unavailable.root, "missing.git")).href);
    expect(prepared.run).toThrow("fetch official refs:");
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
      if (args[0] === "fetch" && args.includes("origin")) {
        return { exitCode: 1, stdout: "", stderr: "marker failure" };
      }
      if (args[0] === "update-ref" && args[1] === "-d" && cleanupCalls++ >= 2) {
        throw new Error(`cleanup ${"secret" + "-token"}`);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let primaryMessage = "";
    try {
      prepareForkOfficialBase({
        repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: primaryRunner,
      });
    } catch (error) {
      primaryMessage = error instanceof Error ? error.message : String(error);
    }
    expect(primaryMessage).toBe("prepare official base: fetch origin marker: marker failure; cleanup also failed");

    let cleanupOnlyDeletes = 0;
    const cleanupOnlyRunner = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "update-ref" && args[1] === "-d" && cleanupOnlyDeletes++ >= 2) {
        throw new Error(`cleanup ${"secret" + "-token"}`);
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
      if (args.includes("fetch") && args.includes("https://example.invalid/official.git")) throw new Error(`primary ${bareDir}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let message = "";
    try {
      prepareForkOfficialBase({ repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: runner });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("prepare official base: fetch official refs:");
    expect(message).not.toContain(bareDir);
    expect(verifierRoots()).toEqual([]);
  });

  test("post-mkdtemp setup failure cleans both owned refs and verifier root", () => {
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
      prepareForkOfficialBase({ repoRoot: root, officialRepositoryUrl: "https://example.invalid/official.git", runGit: runner });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("prepare official base: init official verifier:");
    expect(message).toContain("[REDACTED_PATH]");
    expect(message).not.toContain(bareDir);
    expect(deletions).toBe(4);
    expect(verifierRoots()).toEqual([]);
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
    expect(deletions).toBe(2);
    expect(verifierRoots()).toEqual([]);
  });

  test("default production runner cleans both owned refs after raw chmod failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-fork-base-default-fs-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.35.0-ben.2" }));
    const fakeBin = join(root, "fake-bin");
    const fakeLog = join(root, "default-runner.jsonl");
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, process.platform === "win32" ? "git.cmd" : "git");
    const fakeScript = join(root, "default-runner-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
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
      ["update-ref", "-d", "refs/ocx-ci/fork-marker"],
      ["update-ref", "-d", "refs/ocx-ci/official-tag"],
    ]);
    expect(verifierRoots()).toEqual([]);
  });

  test("direct production entry sandboxes Git environment, fixed URL, long hostile output, and cleanup suffix", () => {
    const fixture = createFixture();
    const fakeBin = join(fixture.root, "fake-bin");
    const fakeGitLog = join(fixture.root, "git-args.jsonl");
    mkdirSync(fakeBin);
    const fakeScript = join(fixture.root, "fake-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst rows = (() => { try { return readFileSync(process.env.FAKE_GIT_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();\nconst env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith("GIT_CONFIG") || key.toUpperCase() === "PATH"));\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({ args, env }) + "\\n");\nconst deletes = rows.filter(row => row.args?.[0] === "update-ref" && row.args?.[1] === "-d").length;\nconst bare = rows.flatMap(row => row.args?.[0] === "init" ? [row.args[2]] : row.args ?? []).find(value => value?.startsWith("--git-dir="))?.slice("--git-dir=".length) ?? rows.find(row => row.args?.[0] === "init")?.args?.[2] ?? "";\nif (args.includes("fetch") && args.includes("https://github.com/lidge-jun/opencodex.git")) { process.stderr.write(bare + "\\n" + process.env.FAKE_GIT_ERROR); process.exit(1); }\nif (args[0] === "update-ref" && args[1] === "-d" && deletes >= 2) { process.stderr.write("cleanup " + bare); process.exit(1); }\nprocess.exit(0);\n`);
    const fakeGit = join(fakeBin, process.platform === "win32" ? "git.cmd" : "git");
    if (process.platform === "win32") {
      writeFileSync(fakeGit, `@echo off\n"${process.execPath}" "${fakeScript}" %*\n`);
    } else {
      writeFileSync(fakeGit, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
      chmodSync(fakeGit, 0o755);
    }
    const scriptPath = fileURLToPath(new URL("../scripts/prepare-fork-official-base.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const hostile = hostileGitDiagnostic(join(repoRoot, "repo.git"));
    expect(hostile.length).toBeGreaterThan(4096);
    expect(hostile.length).toBeLessThanOrEqual(8192);
    const result = Bun.spawnSync([process.execPath, scriptPath, "https://evil.invalid/override"], {
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
    const scriptUrl = pathToFileURL(fileURLToPath(new URL("../scripts/prepare-fork-official-base.ts", import.meta.url))).href;
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
    const fakeBin = join(root, "fake-bin");
    const fakeLog = join(root, "calls.jsonl");
    mkdirSync(fakeBin);
    const fakeScript = join(root, "fake-git.mjs");
    writeFileSync(fakeScript, `import { appendFileSync, readFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst rows = (() => { try { return readFileSync(process.env.FAKE_GIT_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();\nappendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\\n");\nconst bare = rows.find(row => row[0] === "init")?.[2] ?? "";\nconst deletes = rows.filter(row => row[0] === "update-ref" && row[1] === "-d").length;\nif (args[0] === "update-ref" && args[1] === "-d" && deletes >= 2) { process.stderr.write("cleanup " + bare); process.exit(1); }\nif (args.includes("cat-file")) { process.stdout.write("tag\\n"); process.exit(0); }\nif (args.includes("rev-parse")) { if (args.includes("refs/tags/v2.35.0") && !args.some(value => value.startsWith("--git-dir="))) process.exit(1); process.stdout.write(args.some(value => value.includes("^{commit}")) ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n"); process.exit(0); }\nprocess.exit(0);\n`);
    const fakeGit = join(fakeBin, process.platform === "win32" ? "git.cmd" : "git");
    if (process.platform === "win32") writeFileSync(fakeGit, `@echo off\n"${process.execPath}" "${fakeScript}" %*\n`);
    else {
      writeFileSync(fakeGit, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
      chmodSync(fakeGit, 0o755);
    }
    const scriptPath = fileURLToPath(new URL("../scripts/prepare-fork-official-base.ts", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const result = Bun.spawnSync([process.execPath, scriptPath], {
      cwd: repoRoot,
      env: fakeGitEnvironment(fakeBin, { FAKE_GIT_LOG: fakeLog }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = decoder.decode(result.stderr);
    const rows = readFileSync(fakeLog, "utf8").trim().split("\n").map(JSON.parse) as string[][];
    const bareDir = rows.find(row => row[0] === "init")?.[2] ?? "";
    expect(result.exitCode).not.toBe(0);
    expect(decoder.decode(result.stdout)).toBe("");
    expect(stderr.split("\n").filter(Boolean)).toHaveLength(1);
    expect(stderr.length).toBeLessThanOrEqual(513);
    expect(stderr).toContain("[REDACTED_PATH]");
    expect(stderr).not.toContain(bareDir);
  });

  test("pins CI-only official-base preparation, dispatch Windows measurement, and hosted package smoke", async () => {
    type WorkflowJob = {
      name?: string;
      needs?: string | string[];
      if?: string;
      "runs-on"?: unknown;
      strategy?: { matrix?: { os?: string[] } };
      steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
    };
    type Workflow = {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      permissions?: Record<string, string>;
      jobs?: Record<string, WorkflowJob | undefined>;
    };

    const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
    const ci = Bun.YAML.parse(workflow) as Workflow;
    const prepareName = "Prepare verified Fork official base";
    const prepareRun = "bun scripts/prepare-fork-official-base.ts";
    const normalized = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

    expect(ci.permissions).toEqual({ contents: "read" });
    const prepareSteps = Object.entries(ci.jobs ?? {}).flatMap(([jobName, job]) =>
      (job?.steps ?? [])
        .filter(step => step.run === prepareRun)
        .map(step => ({ jobName, step })),
    );
    const targetJobs = ["test", "platform-macos", "platform-windows"];
    expect(prepareSteps.map(({ jobName }) => jobName).sort()).toEqual([...targetJobs].sort());
    for (const jobName of targetJobs) {
      const steps = ci.jobs?.[jobName]?.steps ?? [];
      const matching = prepareSteps.filter(step => step.jobName === jobName);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.step.name).toBe(prepareName);
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

    expect(await Bun.file(new URL("../.github/actions/setup-project-bun/action.yml", import.meta.url)).text())
      .not.toContain(prepareRun);

    const checkouts = Object.values(ci.jobs ?? {})
      .flatMap(job => job?.steps ?? [])
      .filter(step => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    expect(checkouts.every(step => step.with?.["persist-credentials"] === false)).toBe(true);

    const npmGlobal = ci.jobs?.["npm-global-smoke"]!;
    expect(npmGlobal.if).toBe("github.event_name == 'workflow_dispatch' || needs.changes.outputs.packaging == 'true'");
    expect(npmGlobal.needs).toBe("changes");
    expect(npmGlobal["runs-on"]).toBe("${{ matrix.os }}");
    expect(npmGlobal.strategy?.matrix?.os).toEqual(["ubuntu-latest", "windows-latest", "macos-latest"]);
    expect(JSON.stringify(npmGlobal)).not.toContain("self-hosted");
    expect(JSON.stringify(npmGlobal)).not.toContain("select-windows-runner");

    const dispatch = ci.on?.workflow_dispatch;
    expect(dispatch?.inputs).toMatchObject({
      run_windows: { type: "boolean", required: false, default: false },
    });
    const windows = ci.jobs?.["platform-windows"]!;
    expect(normalized(windows.if)).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.run_windows == true",
    );
    expect(windows.name).toBe("windows ${{ matrix.shard }}/4");

    // Task 6 owns executable release-result allowlist enforcement.
  });
});
