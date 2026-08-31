import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isNewer } from "../src/update/notify";
import * as forkVersion from "../src/fork/version-policy.mjs";

const repoUrl = new URL("../", import.meta.url);

function readRepoFile(path: string): string {
  return readFileSync(new URL(path, repoUrl), "utf8");
}

type ForkVersionPolicy = {
  forkBaseVersion: (value: string) => string | null;
  isSameUpstreamVersion: (latest: string, current: string) => boolean;
  forkUpdateDecision?: (latest: string | null, current: string) => "same" | "proceed" | "unresolved";
  forkVersionTagError?: (
    version: string,
    tags: string[],
    pointsAtHead: (tag: string) => boolean,
  ) => string | null | undefined;
};

const forkPolicy = forkVersion as typeof forkVersion & ForkVersionPolicy;

describe("Trendymen fork version policy", () => {
  test("recognizes only the numbered ben fork suffix and exposes its upstream base", () => {
    expect(forkPolicy.forkBaseVersion("2.34.0-ben.1")).toBe("2.34.0");
    expect(forkPolicy.forkBaseVersion("2.34.0-ben.12")).toBe("2.34.0");
    expect(forkPolicy.forkBaseVersion("2.34.0-preview.1")).toBeNull();
    expect(forkPolicy.forkBaseVersion("2.34.0-trendymen.1")).toBeNull();
    expect(forkPolicy.forkBaseVersion("2.34.0-ben.0")).toBeNull();
    expect(forkPolicy.forkBaseVersion("9007199254740993.0.0-ben.1")).toBeNull();
  });

  test("treats the same upstream stable as equivalent and a higher stable as newer", () => {
    expect(isNewer("2.34.0", "2.34.0-ben.1", "latest")).toBe(false);
    expect(isNewer("2.35.0", "2.34.0-ben.1", "latest")).toBe(true);
    expect(forkPolicy.isSameUpstreamVersion("2.34.0", "2.34.0-ben.1")).toBe(true);
    expect(forkPolicy.isSameUpstreamVersion("2.35.0", "2.34.0-ben.1")).toBe(false);
  });

  test("guards both Bun and Node explicit update paths from same-base replacement", () => {
    const bunUpdate = readRepoFile("src/update/index.ts");
    const nodeLauncher = readRepoFile("bin/ocx.mjs");

    expect(bunUpdate).toContain("forkUpdateDecision(latest, current)");
    expect(nodeLauncher).toContain("forkUpdateDecision(latest || null, current)");
  });

  test("fails closed before updater side effects when a ben target cannot be resolved", () => {
    expect(typeof forkPolicy.forkUpdateDecision).toBe("function");
    if (!forkPolicy.forkUpdateDecision) return;

    expect(forkPolicy.forkUpdateDecision(null, "2.34.0-ben.1")).toBe("unresolved");
    expect(forkPolicy.forkUpdateDecision("2.34.0", "2.34.0-ben.1")).toBe("same");
    expect(forkPolicy.forkUpdateDecision("2.35.0", "2.34.0-ben.1")).toBe("proceed");
    expect(forkPolicy.forkUpdateDecision(null, "2.34.0")).toBe("proceed");

    const bunUpdate = readRepoFile("src/update/index.ts");
    const nodeLauncher = readRepoFile("bin/ocx.mjs");
    for (const [source, needle] of [
      [bunUpdate, "forkUpdateDecision(latest, current)"],
      [nodeLauncher, "forkUpdateDecision(latest || null, current)"],
    ] as const) {
      const guard = source.indexOf(needle);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(source.indexOf("const cachePreflight = runNpmCachePreflight()"));
    }
  });

  test.skipIf(process.platform === "win32")(
    "npm launcher exits before cache, stop, or install when the ben target is unresolved",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-ben-update-"));
      const packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
      const launcher = join(packageRoot, "bin", "ocx.mjs");
      const fakeBin = join(root, "fake-bin");
      const fakeNpm = join(fakeBin, "npm");
      const calls = join(root, "npm-calls.txt");
      const sideEffect = join(root, "side-effect");
      try {
        mkdirSync(dirname(launcher), { recursive: true });
        mkdirSync(fakeBin, { recursive: true });
        copyFileSync(new URL("../bin/ocx.mjs", import.meta.url), launcher);
        chmodSync(launcher, 0o755);
        symlinkSync(new URL("../src", import.meta.url).pathname, join(packageRoot, "src"), "dir");
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
          name: "@bitkyc08/opencodex",
          version: "2.34.0-ben.1",
          type: "module",
        }));
        writeFileSync(fakeNpm, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1" in
  view) exit 1 ;;
  *) touch "${sideEffect}"; exit 0 ;;
esac
`);
        chmodSync(fakeNpm, 0o755);

        const result = Bun.spawnSync([process.execPath, launcher, "update"], {
          cwd: root,
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = result.stdout.toString() + result.stderr.toString();
        expect(result.exitCode, output).toBe(1);
        expect(output).toContain("could not resolve the registry version for this fork build");
        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
        expect(existsSync(sideEffect)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("requires an official base and immutable monotonic ben tags", () => {
    expect(typeof forkPolicy.forkVersionTagError).toBe("function");
    if (!forkPolicy.forkVersionTagError) return;
    const validate = forkPolicy.forkVersionTagError;
    const baseTags = ["v2.34.0"];

    expect(validate("2.34.0-ben.1", baseTags, () => false)).toBeNull();
    expect(validate("2.34.0-ben.1", [...baseTags, "v2.34.0-ben.1"], () => true)).toBeNull();
    expect(validate("2.34.0-ben.1", [...baseTags, "v2.34.0-ben.1"], () => false))
      .toContain("already tagged on another commit");
    expect(validate("2.34.0-ben.1", [...baseTags, "v2.34.0-ben.2"], () => false))
      .toContain("behind existing ben.2");
    expect(validate("2.34.0-ben.1", [...baseTags, "v2.34.0-ben.02"], () => false)).toBeNull();
    expect(validate("2.35.0-ben.1", baseTags, () => false)).toContain("no official v2.35.0");
    expect(validate("2.34.0-ben.2", [...baseTags, "v2.35.0"], () => false))
      .toContain("behind v2.35.0");
    expect(validate("2.34.0", baseTags, () => false)).toBeUndefined();
  });

});
