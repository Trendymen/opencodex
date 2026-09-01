import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultLocalPackageStageOptions,
  prepareBundledLocalPackage,
  probeBundledBunBinary,
} from "../scripts/install-local-vendor";
import { localGlobalInstallCommand } from "../scripts/install-local";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function fixture(options: { omitTransitive?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-local-package-stage-fixture-"));
  roots.push(root);
  write(join(root, "package.json"), JSON.stringify({
    name: "ocx-stage-fixture",
    version: "1.0.0",
    type: "module",
    main: "dist/index.js",
    exports: { ".": "./dist/index.js" },
    bin: { fixture: "bin/fixture.mjs" },
    files: ["bin", "dist", "README.md", "LICENSE"],
    scripts: { prepack: "node -e \"process.exit(99)\"" },
    dependencies: { "fixture-dep": "1.0.0" },
  }, null, 2) + "\n");
  write(join(root, "bin/fixture.mjs"), "#!/usr/bin/env node\nconsole.log('fixture');\n", 0o755);
  write(join(root, "dist/index.js"), "export const fixture = true;\n");
  write(join(root, "README.md"), "fixture\n");
  write(join(root, "LICENSE"), "test only\n");
  write(join(root, "secret.txt"), "must-not-pack\n");

  write(join(root, "node_modules/fixture-dep/package.json"), JSON.stringify({
    name: "fixture-dep",
    version: "1.0.0",
    main: "index.js",
    dependencies: { "fixture-transitive": "1.0.0" },
  }));
  write(join(root, "node_modules/fixture-dep/index.js"), "module.exports = require('fixture-transitive');\n");
  if (!options.omitTransitive) {
    write(join(root, "node_modules/fixture-dep/node_modules/fixture-transitive/package.json"), JSON.stringify({
      name: "fixture-transitive",
      version: "1.0.0",
      main: "index.js",
    }));
    write(join(root, "node_modules/fixture-dep/node_modules/fixture-transitive/index.js"), "module.exports = 42;\n");
  }
  return root;
}

describe("Fork local package staging", () => {
  test("packs and validates an offline self-contained package without mutating root metadata", () => {
    const root = fixture();
    const before = readFileSync(join(root, "package.json"), "utf8");
    const prepared = prepareBundledLocalPackage(root);
    const stageRoot = dirname(dirname(prepared.tarball));
    try {
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
      expect(prepared.rootManifestBytes).toBe(before);
      expect(lstatSync(prepared.tarball).isFile()).toBe(true);
      expect(lstatSync(prepared.tarball).isSymbolicLink()).toBe(false);
      expect(existsSync(prepared.npmCache)).toBe(true);
      const manifest = readFileSync(join(dirname(prepared.tarball), "package.json"), "utf8");
      expect(JSON.parse(manifest).bundleDependencies).toEqual(["fixture-dep"]);
      expect(existsSync(join(dirname(prepared.tarball), "secret.txt"))).toBe(false);
      expect(existsSync(join(stageRoot, "validation/node_modules/ocx-stage-fixture/secret.txt"))).toBe(false);
      expect(existsSync(join(stageRoot, "validation/node_modules/ocx-stage-fixture/dist/index.js"))).toBe(true);
      expect(lstatSync(join(dirname(prepared.tarball), "bin/fixture.mjs")).mode & 0o111).not.toBe(0);
    } finally {
      prepared.cleanup();
    }
    expect(existsSync(stageRoot)).toBe(false);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  test("an incomplete bundled dependency closure fails offline and cleans its owned stage", () => {
    const root = fixture({ omitTransitive: true });
    const stages: string[] = [];
    expect(() => prepareBundledLocalPackage(root, {
      ...defaultLocalPackageStageOptions,
      makeTempRoot: (prefix) => {
        const stage = mkdtempSync(join(tmpdir(), prefix));
        stages.push(stage);
        return stage;
      },
    })).toThrow();
    expect(stages).toHaveLength(1);
    expect(existsSync(stages[0]!)).toBe(false);
  });

  test("a missing current-platform Bun binary fails before global replacement", () => {
    const root = fixture();
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { bun: "1.0.0" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    write(join(root, "node_modules/bun/package.json"), JSON.stringify({
      name: "bun",
      version: "1.0.0",
      main: "index.js",
    }));
    write(join(root, "node_modules/bun/index.js"), "module.exports = {};\n");
    expect(() => prepareBundledLocalPackage(root)).toThrow(/Bun binary missing|incomplete/i);
  });

  test.skipIf(process.platform === "win32")("rejects a package file symlink escaping the source root", () => {
    const root = fixture();
    const outside = join(dirname(root), `outside-${Date.now()}.txt`);
    roots.push(outside);
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "dist/escape.js"));
    expect(() => prepareBundledLocalPackage(root)).toThrow(/escape|outside|contained/i);
  });

  test.skipIf(process.platform === "win32")("rejects a link escaping its declared package subtree", () => {
    const root = fixture();
    symlinkSync(join(root, "secret.txt"), join(root, "dist/internal-secret.js"));
    expect(() => prepareBundledLocalPackage(root)).toThrow(/escape|contained|subtree/i);
  });

  test.skipIf(process.platform === "win32")("rejects an escaping link in an ancestor of a files entry", () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "ocx-stage-outside-dir-"));
    roots.push(outside);
    write(join(outside, "payload"), "outside");
    symlinkSync(outside, join(root, "linked-dir"));
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = ["linked-dir/payload"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => prepareBundledLocalPackage(root)).toThrow(/escape|contained|root/i);
  });

  test("the real global install command reuses the validated cache and forbids network fallback", () => {
    expect(localGlobalInstallCommand({ tarball: "/owned/package.tgz", npmCache: "/owned/cache" })).toEqual([
      "npm", "install", "-g", "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
      "--package-lock=false", "--cache", "/owned/cache", "/owned/package.tgz",
    ]);
  });

  test("Bun probe uses the exact extracted binary, version arg, and five-second timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-bun-probe-"));
    roots.push(root);
    const binary = join(root, process.platform === "win32" ? "bun.exe" : "bun");
    writeFileSync(binary, Buffer.alloc(1_000_000));
    const calls: Array<{ command: readonly string[]; timeoutMs?: number }> = [];
    const success = (
      command: readonly string[],
      _cwd: string,
      _env: NodeJS.ProcessEnv,
      options?: { timeoutMs?: number },
    ) => {
      calls.push({ command, timeoutMs: options?.timeoutMs });
      return { exitCode: 0, stdout: "1.4.0\n", timedOut: false };
    };
    expect(() => probeBundledBunBinary(binary, root, success)).not.toThrow();
    expect(calls).toEqual([{ command: [binary, "--version"], timeoutMs: 5_000 }]);

    expect(() => probeBundledBunBinary(binary, root, () => ({
      exitCode: 1, stdout: "", timedOut: false,
    }))).toThrow(/probe failed/);
    expect(() => probeBundledBunBinary(binary, root, () => ({
      exitCode: 0, stdout: "", timedOut: true,
    }))).toThrow(/timed out/);
    expect(() => probeBundledBunBinary(binary, root, () => { throw new Error("spawn"); }))
      .toThrow(/could not start/);
    expect(() => probeBundledBunBinary(binary, root, () => ({
      exitCode: 0, stdout: "not-a-version", timedOut: false,
    }))).toThrow(/invalid version/);
  });

  test("default runner distinguishes normal completion from a real timeout", () => {
    const completed = defaultLocalPackageStageOptions.run(
      [process.execPath, "--version"],
      process.cwd(),
      { ...process.env },
      { timeoutMs: 5_000 },
    );
    expect(completed.exitCode).toBe(0);
    expect(completed.timedOut).toBe(false);

    const timed = defaultLocalPackageStageOptions.run(
      [process.execPath, "-e", "await Bun.sleep(1_000)"],
      process.cwd(),
      { ...process.env },
      { timeoutMs: 20 },
    );
    expect(timed.timedOut).toBe(true);
  });
});
