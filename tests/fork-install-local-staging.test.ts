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

function fixture(options: { omitTransitive?: boolean; optional?: "present" | "missing" } = {}): string {
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
    ...(options.optional ? { optionalDependencies: { "fixture-optional": "1.0.0" } } : {}),
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
  if (options.optional === "present") {
    write(join(root, "node_modules/fixture-optional/package.json"), JSON.stringify({
      name: "fixture-optional",
      version: "1.0.0",
      main: "index.js",
    }));
    write(join(root, "node_modules/fixture-optional/index.js"), "module.exports = 'optional';\n");
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

  test("a present root optional dependency is bundled and resolves from the offline archive", () => {
    const root = fixture({ optional: "present" });
    const prepared = prepareBundledLocalPackage(root);
    try {
      const stagedManifest = JSON.parse(readFileSync(join(dirname(prepared.tarball), "package.json"), "utf8"));
      expect(stagedManifest.bundleDependencies).toEqual(["fixture-dep", "fixture-optional"]);
      const installedRoot = join(dirname(dirname(prepared.tarball)), "validation/node_modules/ocx-stage-fixture");
      expect(existsSync(join(installedRoot, "node_modules/fixture-optional/package.json"))).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  test("a missing root optional dependency is omitted without network fallback", () => {
    const root = fixture({ optional: "missing" });
    const prepared = prepareBundledLocalPackage(root);
    try {
      const stagedManifest = JSON.parse(readFileSync(join(dirname(prepared.tarball), "package.json"), "utf8"));
      expect(stagedManifest.bundleDependencies).toEqual(["fixture-dep"]);
    } finally {
      prepared.cleanup();
    }
  });

  test("rejects forged pack integrity, hashes, rows, and archive surface evidence", () => {
    const mutations: Array<[string, (rows: any[]) => void]> = [
      ["integrity", rows => { rows[0].integrity = "sha512-forged"; }],
      ["shasum", rows => { rows[0].shasum = "0".repeat(40); }],
      ["duplicate file", rows => { rows[0].files.push({ ...rows[0].files[0] }); }],
      ["malformed file row", rows => { rows[0].files.push(null); }],
      ["absolute path", rows => { rows[0].files.push({ path: "/etc/passwd" }); }],
      ["dot segment", rows => { rows[0].files.push({ path: "dist/../secret.txt" }); }],
      ["sensitive path", rows => { rows[0].files.push({ path: ".env" }); }],
      ["outside surface", rows => { rows[0].files.push({ path: "secret.txt" }); }],
      ["multiple tarballs", rows => { rows.push({ ...rows[0] }); }],
    ];
    for (const [name, mutate] of mutations) {
      const root = fixture();
      expect(() => prepareBundledLocalPackage(root, {
        ...defaultLocalPackageStageOptions,
        run: (command, cwd, env, options) => {
          const result = defaultLocalPackageStageOptions.run(command, cwd, env, options);
          if (command[0] === "npm" && command[1] === "pack") {
            const rows = JSON.parse(result.stdout);
            mutate(rows);
            return { ...result, stdout: JSON.stringify(rows) };
          }
          return result;
        },
      }), name).toThrow();
    }
  });

  test("rejects empty, malformed, or structurally invalid npm pack JSON", () => {
    for (const stdout of ["", "not json", "{}", "[]"]) {
      const root = fixture();
      expect(() => prepareBundledLocalPackage(root, {
        ...defaultLocalPackageStageOptions,
        run: (command, cwd, env, options) => command[0] === "npm" && command[1] === "pack"
          ? { exitCode: 0, stdout, timedOut: false }
          : defaultLocalPackageStageOptions.run(command, cwd, env, options),
      }), stdout).toThrow();
    }
  });

  test("rejects a tarball filename that escapes the owned package directory", () => {
    const root = fixture();
    expect(() => prepareBundledLocalPackage(root, {
      ...defaultLocalPackageStageOptions,
      run: (command, cwd, env, options) => {
        const result = defaultLocalPackageStageOptions.run(command, cwd, env, options);
        if (command[0] !== "npm" || command[1] !== "pack") return result;
        const rows = JSON.parse(result.stdout);
        rows[0].filename = "../outside.tgz";
        return { ...result, stdout: JSON.stringify(rows) };
      },
    })).toThrow(/tarball|escape|package directory/i);
  });

  test.skipIf(process.platform === "win32")("rejects a symlink substituted for the packed tarball", () => {
    const root = fixture();
    const outside = join(root, "outside.tgz");
    write(outside, "not the packed bytes");
    expect(() => prepareBundledLocalPackage(root, {
      ...defaultLocalPackageStageOptions,
      run: (command, cwd, env, options) => {
        const result = defaultLocalPackageStageOptions.run(command, cwd, env, options);
        if (command[0] === "npm" && command[1] === "pack") {
          const rows = JSON.parse(result.stdout);
          const tarball = join(cwd, rows[0].filename);
          rmSync(tarball);
          symlinkSync(outside, tarball);
        }
        return result;
      },
    })).toThrow(/tarball|link|regular/i);
  });

  test("rejects installed identity, entrypoint, export, and declared-file drift", () => {
    const mutations: Array<[string, (installedRoot: string) => void]> = [
      ["identity", installedRoot => {
        const manifestPath = join(installedRoot, "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.name = "other-package";
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }],
      ["main", installedRoot => {
        const manifestPath = join(installedRoot, "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.main = "dist/missing.js";
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }],
      ["bin", installedRoot => {
        rmSync(join(installedRoot, "bin/fixture.mjs"));
      }],
      ["exports", installedRoot => {
        const manifestPath = join(installedRoot, "package.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.exports = { ".": "./dist/missing.js" };
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }],
      ["declared file", installedRoot => {
        rmSync(join(installedRoot, "README.md"));
      }],
    ];
    for (const [name, mutate] of mutations) {
      const root = fixture();
      expect(() => prepareBundledLocalPackage(root, {
        ...defaultLocalPackageStageOptions,
        run: (command, cwd, env, options) => {
          const result = defaultLocalPackageStageOptions.run(command, cwd, env, options);
          if (command[0] === "npm" && command[1] === "install" && result.exitCode === 0) {
            const prefix = command[command.indexOf("--prefix") + 1]!;
            mutate(join(prefix, "node_modules/ocx-stage-fixture"));
          }
          return result;
        },
      }), name).toThrow();
    }
  });

  test("the pre-build manifest snapshot rejects drift before staging ownership begins", () => {
    const root = fixture();
    const before = readFileSync(join(root, "package.json"), "utf8");
    const manifest = JSON.parse(before);
    manifest.files.push("secret.txt");
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    let madeStage = false;
    expect(() => prepareBundledLocalPackage(root, {
      ...defaultLocalPackageStageOptions,
      makeTempRoot: prefix => {
        madeStage = true;
        return defaultLocalPackageStageOptions.makeTempRoot(prefix);
      },
    }, before)).toThrow(/before local package preparation/i);
    expect(madeStage).toBe(false);
  });

  test("manifest drift during pack stays primary when stage cleanup also fails", () => {
    const root = fixture();
    const before = readFileSync(join(root, "package.json"), "utf8");
    const cleanup = new Error("cleanup failed");
    try {
      prepareBundledLocalPackage(root, {
        ...defaultLocalPackageStageOptions,
        run: (command, cwd, env, options) => {
          const result = defaultLocalPackageStageOptions.run(command, cwd, env, options);
          if (command[0] === "npm" && command[1] === "pack") {
            const changed = JSON.parse(before);
            changed.dependencies.extra = "1.0.0";
            writeFileSync(join(root, "package.json"), JSON.stringify(changed));
          }
          return result;
        },
        removeTree: () => { throw cleanup; },
      }, before);
      throw new Error("expected manifest drift");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors;
      expect((errors[0] as Error).message).toMatch(/root package.json changed during local package pack/i);
      expect(errors[1]).toBe(cleanup);
    }
  });

  test.skipIf(process.platform === "win32")("rejects a source link cycle inside a declared subtree", () => {
    const root = fixture();
    symlinkSync(".", join(root, "dist/cycle"));
    expect(() => prepareBundledLocalPackage(root)).toThrow(/cycle/i);
  });

  test.skipIf(process.platform === "win32")("rejects a special file declared in the package surface", () => {
    const root = fixture();
    const fifo = join(root, "declared.fifo");
    const result = Bun.spawnSync(["mkfifo", fifo]);
    expect(result.exitCode).toBe(0);
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.push("declared.fifo");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => prepareBundledLocalPackage(root)).toThrow(/non-file|special/i);
  });

  test.skipIf(process.platform === "win32")("default runner rejects a large executable junk Bun binary", () => {
    const root = fixture();
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { "fixture-dep": "1.0.0", bun: "1.0.0" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    write(join(root, "node_modules/bun/package.json"), JSON.stringify({
      name: "bun",
      version: "1.0.0",
      bin: { bun: "bin/bun" },
    }));
    write(join(root, "node_modules/bun/bin/bun"), Buffer.alloc(1_100_000).toString("binary"), 0o755);
    expect(() => prepareBundledLocalPackage(root)).toThrow(/execution probe|could not start|failed/i);
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
