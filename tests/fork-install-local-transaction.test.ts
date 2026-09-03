import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLocalInstallLifecycle } from "../scripts/install-local";
import { transactionalNpmUpdate } from "../src/update/transactional-install.mjs";

const roots: string[] = [];

function packageTree(root: string, version: string): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@bitkyc08/opencodex",
    version,
    bin: { ocx: "bin/ocx.mjs" },
    dependencies: { zod: "1.0.0" },
  }));
  writeFileSync(join(root, "bin", "ocx.mjs"), "x".repeat(2_048));
  writeFileSync(join(root, "node_modules", "zod", "package.json"), JSON.stringify({
    name: "zod",
    version: "1.0.0",
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("install:local transactional package replacement", () => {
  test("stages the validated tarball and restores the old tree when local post-verification fails", () => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-local-transaction-"));
    roots.push(fixture);
    const packageDir = join(fixture, "@bitkyc08", "opencodex");
    const preparedTree = join(fixture, "prepared");
    packageTree(packageDir, "2.40.0-ben.2");
    packageTree(preparedTree, "2.40.0-ben.3");
    let npmArgs: string[] = [];

    const result = transactionalNpmUpdate({
      packageDir,
      pkgName: "@bitkyc08/opencodex",
      targetVersion: "2.40.0-ben.3",
      tag: "latest",
      packageSpec: "/owned/opencodex-2.40.0-ben.3.tgz",
      installArgs: ["--ignore-scripts", "--offline", "--cache", "/owned/npm-cache"],
      runNpm: (args: string[]) => {
        npmArgs = args;
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const staged = join(prefix, "lib", "node_modules", "@bitkyc08", "opencodex");
        mkdirSync(dirname(staged), { recursive: true });
        cpSync(preparedTree, staged, { recursive: true });
        return { status: 0 };
      },
      verifyLive: () => ({ ok: false, failures: ["installed GUI verification failed"] }),
    });

    expect(npmArgs).toEqual([
      "install", "-g", "--prefix", expect.any(String),
      "--ignore-scripts", "--offline", "--cache", "/owned/npm-cache",
      "/owned/opencodex-2.40.0-ben.3.tgz",
    ]);
    expect(result).toMatchObject({ ok: false, phase: "post-verify", rolledBack: true });
    expect(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version)
      .toBe("2.40.0-ben.2");
  });

  test("does not restart from an unproven package tree after a swap and rollback double fault", async () => {
    const events: string[] = [];
    const failure = Object.assign(new Error("double fault"), { localInstallRecoverySafe: false });

    expect(runLocalInstallLifecycle(true, {
      stop: () => { events.push("stop"); },
      verifyStopped: () => { events.push("verify"); },
      replace: () => {
        events.push("replace");
        throw failure;
      },
      restart: () => { events.push("restart"); },
      ready: () => { events.push("ready"); },
    })).rejects.toBe(failure);
    await Promise.resolve();

    expect(events).toEqual(["stop", "verify", "replace"]);
  });
});
