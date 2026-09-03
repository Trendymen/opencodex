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
import { execFileSync } from "node:child_process";
import { forkUpdateDecision } from "../src/fork/version-policy.mjs";

describe("fork update monotonicity", () => {
  test("compares official bases and same-base Fork revisions on the latest channel", () => {
    const current = "2.40.0-ben.3";
    expect(forkUpdateDecision("2.39.0-ben.9", current, "latest")).toBe("older");
    expect(forkUpdateDecision("2.40.0-ben.2", current, "latest")).toBe("older");
    expect(forkUpdateDecision("2.40.0-ben.3", current, "latest")).toBe("same");
    expect(forkUpdateDecision("2.40.0-ben.4", current, "latest")).toBe("proceed");
    expect(forkUpdateDecision("2.41.0-ben.1", current, "latest")).toBe("proceed");
    expect(forkUpdateDecision("2.40.0", current, "latest")).toBe("same");
  });

  test("fails closed for malformed latest-channel targets on a recognized Fork build", () => {
    const current = "2.40.0-ben.3";
    for (const target of [
      null, undefined, 1, {}, "", "   ", "garbage", "02.40.0", "2.40.0-ben.0",
      "2.40.0-ben.02", "2.40.0-preview.1", "2.40.0-rc.1", "2.40.0\n2.41.0",
    ]) {
      expect(forkUpdateDecision(target, current, "latest"), String(target)).toBe("unresolved");
    }
  });

  test("allows only a canonical preview target after an explicit preview selection", () => {
    const current = "2.40.0-ben.3";
    expect(forkUpdateDecision("2.41.0-preview.1", current, "preview")).toBe("proceed");
    expect(forkUpdateDecision("2.41.0-preview.20260904.1", current, "preview")).toBe("proceed");
    expect(forkUpdateDecision("2.41.0-preview.alpha", current, "preview")).toBe("proceed");
    expect(forkUpdateDecision("2.41.0-preview.alpha-1.0", current, "preview")).toBe("proceed");
    expect(forkUpdateDecision("2.41.0-preview.0", current, "preview")).toBe("proceed");
    expect(forkUpdateDecision("2.41.0-preview.01", current, "preview")).toBe("unresolved");
    expect(forkUpdateDecision("2.41.0-preview.alpha..1", current, "preview")).toBe("unresolved");
    expect(forkUpdateDecision("2.41.0-preview.alpha_1", current, "preview")).toBe("unresolved");
    expect(forkUpdateDecision("garbage", current, "preview")).toBe("unresolved");
  });

  test("preserves the legacy policy for ordinary upstream versions", () => {
    expect(forkUpdateDecision("2.40.0", "2.40.0", "latest")).toBe("same");
    expect(forkUpdateDecision("2.40.0-preview.3", "2.40.0-preview.3", "preview")).toBe("same");
    expect(forkUpdateDecision(null, "2.40.0", "latest")).toBe("proceed");
    expect(forkUpdateDecision("garbage", "2.40.0", "latest")).toBe("proceed");
  });

  test.skipIf(process.platform === "win32")(
    "npm launcher rejects an older Fork revision and malformed registry output before side effects",
    () => {
      for (const latest of ["2.40.0-ben.2", "garbage"]) {
        const root = mkdtempSync(join(tmpdir(), "ocx-ben-monotonicity-"));
        const packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
        const launcher = join(packageRoot, "bin", "ocx.mjs");
        const fakeBin = join(root, "fake-bin");
        const fakeNpm = join(fakeBin, "npm");
        const fakeNpmCli = join(fakeBin, "npm-cli.cjs");
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
            version: "2.40.0-ben.3",
            type: "module",
          }));
          writeFileSync(fakeNpm, `#!/bin/sh\nexec node "${fakeNpmCli}" "$@"\n`);
          writeFileSync(fakeNpmCli, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "view") {
  process.stdout.write(${JSON.stringify(latest + "\n")});
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(sideEffect)}, "called");
`);
          chmodSync(fakeNpm, 0o755);

          const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
          const result = Bun.spawnSync([node, launcher, "update"], {
            cwd: root,
            env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
            stdout: "pipe",
            stderr: "pipe",
          });
          const output = result.stdout.toString() + result.stderr.toString();
          expect(result.exitCode, output).toBe(1);
          expect(output).toMatch(latest === "garbage" ? /could not resolve/i : /refusing to downgrade/i);
          expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
          expect(existsSync(sideEffect)).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );
});
