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
import { forkUpdateDecision } from "../src/fork/version-policy.mjs";

describe("fork updater downgrade guard", () => {
  test("rejects a stable registry target below the current fork base", () => {
    expect(forkUpdateDecision("2.39.0", "2.40.0-ben.3")).toBe("older");
    expect(forkUpdateDecision("2.40.0", "2.40.0-ben.3")).toBe("same");
    expect(forkUpdateDecision("2.41.0", "2.40.0-ben.3")).toBe("proceed");
  });

  test.skipIf(process.platform === "win32")(
    "npm launcher exits before cache, stop, or install for an older registry target",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-ben-downgrade-"));
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
          version: "2.40.0-ben.3",
          type: "module",
        }));
        writeFileSync(fakeNpm, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1" in
  view) printf '%s\\n' '2.39.0'; exit 0 ;;
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
        expect(output).toContain("refusing to downgrade this fork build");
        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
        expect(existsSync(sideEffect)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
