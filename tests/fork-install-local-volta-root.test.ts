import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CommandResult = { status: number; stdout: string; stderr: string; errorCode?: string };
type ResolveInstalledPackageRoot = (
  name: string,
  version: string,
  run: (command: string[]) => CommandResult,
  options?: {
    platform?: NodeJS.Platform;
    findExecutable?: (command: string) => string | null;
  },
) => string;
type ParsePackageIdentity = (source: string) => { name: string; version: string };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `ocx-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function writePackageRoot(
  root: string,
  name: string,
  version: string,
  binDeclaration: unknown = { ocx: "./bin/ocx.mjs" },
): { root: string; bin: string } {
  const binDirectory = join(root, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const bin = join(binDirectory, "ocx.mjs");
  writeFileSync(bin, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name,
    version,
    bin: binDeclaration,
  }), "utf8");
  return { root, bin };
}

function writeNpmGlobalPackage(
  globalRoot: string,
  name: string,
  version: string,
): { root: string; bin: string } {
  const root = join(globalRoot, ...name.split("/"));
  mkdirSync(root, { recursive: true });
  return writePackageRoot(root, name, version);
}

function writeDirectOcxPackage(root: string, name: string, version: string): {
  root: string;
  bin: string;
} {
  const binDirectory = join(root, "bin");
  mkdirSync(binDirectory, { recursive: true });
  const bin = join(binDirectory, "ocx");
  writeFileSync(bin, "volta direct wrapper\n", "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name,
    version,
    bin: { ocx: "./bin/ocx" },
  }), "utf8");
  return { root, bin };
}

function writeWindowsNpmShim(prefix: string, packageBin: string): string {
  const shim = join(prefix, "ocx.cmd");
  const target = `"%dp0%\\${packageBin.slice(prefix.length + 1).replace(/[\\/]/g, "\\")}"`;
  writeFileSync(shim, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    "IF EXIST \"%dp0%\\node.exe\" (",
    "  SET \"_prog=%dp0%\\node.exe\"",
    ") ELSE (",
    "  SET \"_prog=node\"",
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  ${target} %*`,
    "",
  ].join("\r\n"), "utf8");
  return shim;
}

function writeVoltaImage(name: string, version: string): {
  imageRoot: string;
  wrapper: string;
  packageRoot: string;
} {
  const imageRoot = temporaryRoot("volta-image");
  const wrapperDirectory = join(imageRoot, "bin");
  mkdirSync(wrapperDirectory, { recursive: true });
  const wrapper = join(wrapperDirectory, process.platform === "win32" ? "ocx.cmd" : "ocx");
  writeFileSync(wrapper, "volta wrapper\n", "utf8");
  const packageRoot = join(imageRoot, "lib", "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writePackageRoot(packageRoot, name, version);
  return { imageRoot, wrapper, packageRoot };
}

async function resolver(): Promise<ResolveInstalledPackageRoot> {
  const module = await import("../scripts/install-local");
  const resolveInstalledPackageRoot = (module as unknown as {
    resolveInstalledPackageRoot?: ResolveInstalledPackageRoot;
  }).resolveInstalledPackageRoot;
  expect(typeof resolveInstalledPackageRoot).toBe("function");
  if (!resolveInstalledPackageRoot) throw new Error("resolveInstalledPackageRoot is unavailable");
  return resolveInstalledPackageRoot;
}

async function identityParser(): Promise<ParsePackageIdentity> {
  const module = await import("../scripts/install-local");
  const parsePackageIdentity = (module as unknown as {
    parsePackageIdentity?: ParsePackageIdentity;
  }).parsePackageIdentity;
  expect(typeof parsePackageIdentity).toBe("function");
  if (!parsePackageIdentity) throw new Error("parsePackageIdentity is unavailable");
  return parsePackageIdentity;
}

describe("install-local resolves the package selected by Volta", () => {
  const name = "@bitkyc08/opencodex";
  const version = "2.37.0-ben.3";

  test("prefers the executable-backed Volta package over a stale npm root", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const fresh = writeDirectOcxPackage(temporaryRoot("volta-package"), name, version);
    const npmGlobalRoot = temporaryRoot("npm-global");
    writeNpmGlobalPackage(npmGlobalRoot, name, "2.36.0-ben.3");
    const commands: string[] = [];

    const resolved = resolveInstalledPackageRoot(name, version, command => {
      commands.push(command.join(" "));
      if (command.join(" ") === "volta which ocx") {
        return { status: 0, stdout: `${fresh.bin}\n`, stderr: "" };
      }
      if (command.join(" ") === "npm root -g") {
        return { status: 0, stdout: `${npmGlobalRoot}\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    });

    expect(resolved).toBe(realpathSync(fresh.root));
    expect(commands).toEqual(["volta which ocx"]);
  });

  test("falls back to npm root when Volta is unavailable", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const npmGlobalRoot = temporaryRoot("npm-fallback");
    const installed = writeNpmGlobalPackage(npmGlobalRoot, name, version);

    const resolved = resolveInstalledPackageRoot(name, version, command => {
      if (command.join(" ") === "volta which ocx") {
        return { status: -1, stdout: "", stderr: "volta not found", errorCode: "ENOENT" };
      }
      return { status: 0, stdout: `${npmGlobalRoot}\n`, stderr: "" };
    });

    expect(resolved).toBe(realpathSync(installed.root));
  });

  test("falls back to npm when Volta resolves a stale candidate", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const stale = writeDirectOcxPackage(temporaryRoot("volta-stale"), name, "2.36.0-ben.3");
    const npmGlobalRoot = temporaryRoot("npm-current");
    const installed = writeNpmGlobalPackage(npmGlobalRoot, name, version);
    const commands: string[] = [];

    const resolved = resolveInstalledPackageRoot(name, version, command => {
      commands.push(command.join(" "));
      return command.join(" ") === "volta which ocx"
        ? { status: 0, stdout: stale.bin, stderr: "" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" };
    }, { findExecutable: () => installed.bin });

    expect(resolved).toBe(realpathSync(installed.root));
    expect(commands).toEqual(["volta which ocx", "npm root -g"]);
  });

  test("rejects npm fallback when the active executable selects another package", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const stale = writeDirectOcxPackage(temporaryRoot("volta-shadow"), name, "2.36.0-ben.3");
    const npmGlobalRoot = temporaryRoot("npm-shadowed");
    writeNpmGlobalPackage(npmGlobalRoot, name, version);
    const shadow = writeDirectOcxPackage(temporaryRoot("path-shadow"), name, version);
    const commands: string[] = [];

    expect(() => resolveInstalledPackageRoot(name, version, command => {
      commands.push(command.join(" "));
      return command.join(" ") === "volta which ocx"
        ? { status: 0, stdout: stale.bin, stderr: "" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" };
    }, { findExecutable: () => shadow.bin })).toThrow("could not locate the installed package matching");

    expect(commands).toEqual(["volta which ocx", "npm root -g"]);
  });

  test("does not fall back when Volta exists but fails to resolve ocx", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const npmGlobalRoot = temporaryRoot("npm-after-volta-error");
    writeNpmGlobalPackage(npmGlobalRoot, name, version);
    const commands: string[] = [];

    expect(() => resolveInstalledPackageRoot(name, version, command => {
      commands.push(command.join(" "));
      return command.join(" ") === "volta which ocx"
        ? { status: 1, stdout: "", stderr: "volta resolver failed" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" };
    })).toThrow("could not locate the installed package matching");
    expect(commands).toEqual(["volta which ocx"]);
  });

  test("does not fall back for a non-ENOENT Volta spawn failure", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const npmGlobalRoot = temporaryRoot("npm-after-volta-eacces");
    writeNpmGlobalPackage(npmGlobalRoot, name, version);
    const commands: string[] = [];

    expect(() => resolveInstalledPackageRoot(name, version, command => {
      commands.push(command.join(" "));
      return command.join(" ") === "volta which ocx"
        ? { status: -1, stdout: "", stderr: "permission denied", errorCode: "EACCES" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" };
    })).toThrow("could not locate the installed package matching");
    expect(commands).toEqual(["volta which ocx"]);
  });

  test("fails closed when neither command identifies the installed version", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const stale = writeDirectOcxPackage(temporaryRoot("volta-wrong-version"), name, "2.36.0-ben.3");
    const npmGlobalRoot = temporaryRoot("npm-wrong-version");
    writeNpmGlobalPackage(npmGlobalRoot, name, "2.35.0-ben.3");

    expect(() => resolveInstalledPackageRoot(name, version, command => (
      command.join(" ") === "volta which ocx"
        ? { status: 0, stdout: stale.bin, stderr: "" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" }
    ))).toThrow("could not locate the installed package matching @bitkyc08/opencodex@2.37.0-ben.3");
  });

  test("resolves a regular Volta image wrapper through lib/node_modules", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const image = writeVoltaImage(name, version);

    const resolved = resolveInstalledPackageRoot(name, version, () => ({
      status: 0,
      stdout: `${image.wrapper}\n`,
      stderr: "",
    }));

    expect(resolved).toBe(realpathSync(image.packageRoot));
  });

  test.skipIf(process.platform === "win32")(
    "resolves a Volta ocx symlink to the package-declared bin",
    async () => {
      const resolveInstalledPackageRoot = await resolver();
      const installed = writePackageRoot(temporaryRoot("volta-symlink-package"), name, version);
      const wrapperRoot = temporaryRoot("volta-symlink-wrapper");
      const wrapperDirectory = join(wrapperRoot, "bin");
      mkdirSync(wrapperDirectory, { recursive: true });
      const wrapper = join(wrapperDirectory, "ocx");
      symlinkSync(installed.bin, wrapper);

      expect(resolveInstalledPackageRoot(name, version, () => ({
        status: 0,
        stdout: wrapper,
        stderr: "",
      }))).toBe(realpathSync(installed.root));
    },
  );

  test("supports an unscoped package in the Volta image layout", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const image = writeVoltaImage("opencodex", version);

    expect(resolveInstalledPackageRoot("opencodex", version, () => ({
      status: 0,
      stdout: image.wrapper,
      stderr: "",
    }))).toBe(realpathSync(image.packageRoot));
  });

  test("rejects an image wrapper whose basename is not ocx", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const image = writeVoltaImage(name, version);
    const wrongWrapper = join(image.imageRoot, "bin", "not-ocx");
    writeFileSync(wrongWrapper, "volta wrapper\n", "utf8");

    expect(() => resolveInstalledPackageRoot(name, version, () => ({
      status: 0,
      stdout: wrongWrapper,
      stderr: "",
    }))).toThrow("could not locate the installed package matching");
  });

  test("rejects string-bin metadata that would not register an ocx command", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const image = writeVoltaImage(name, version);
    writePackageRoot(image.packageRoot, name, version, "./bin/ocx.mjs");

    expect(() => resolveInstalledPackageRoot(name, version, () => ({
      status: 0,
      stdout: image.wrapper,
      stderr: "",
    }))).toThrow("could not locate the installed package matching");
  });

  test.skipIf(process.platform === "win32")(
    "rejects a Volta image whose bin directory escapes through a symlink",
    async () => {
      const resolveInstalledPackageRoot = await resolver();
      const imageRoot = temporaryRoot("volta-bin-link");
      const externalBin = temporaryRoot("external-bin");
      const wrapper = join(externalBin, "ocx");
      writeFileSync(wrapper, "volta wrapper\n", "utf8");
      symlinkSync(externalBin, join(imageRoot, "bin"), "dir");
      const packageRoot = join(imageRoot, "lib", "node_modules", ...name.split("/"));
      mkdirSync(packageRoot, { recursive: true });
      writePackageRoot(packageRoot, name, version);

      expect(() => resolveInstalledPackageRoot(name, version, () => ({
        status: 0,
        stdout: join(imageRoot, "bin", "ocx"),
        stderr: "",
      }))).toThrow("could not locate the installed package matching");
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a Volta image whose node_modules directory escapes through a symlink",
    async () => {
      const resolveInstalledPackageRoot = await resolver();
      const imageRoot = temporaryRoot("volta-modules-link");
      const binRoot = join(imageRoot, "bin");
      mkdirSync(binRoot, { recursive: true });
      const wrapper = join(binRoot, "ocx");
      writeFileSync(wrapper, "volta wrapper\n", "utf8");
      const externalModules = temporaryRoot("external-modules");
      writeNpmGlobalPackage(externalModules, name, version);
      mkdirSync(join(imageRoot, "lib"), { recursive: true });
      symlinkSync(externalModules, join(imageRoot, "lib", "node_modules"), "dir");

      expect(() => resolveInstalledPackageRoot(name, version, () => ({
        status: 0,
        stdout: wrapper,
        stderr: "",
      }))).toThrow("could not locate the installed package matching");
    },
  );

  for (const [label, stdout] of [
    ["empty", ""],
    ["relative", "relative/bin/ocx"],
    ["multiline", "/first/ocx\n/second/ocx"],
    ["missing", join(temporaryRoot("missing-wrapper"), "bin", "ocx")],
  ] as const) {
    test(`falls back to npm after Volta succeeds with ${label} output`, async () => {
      const resolveInstalledPackageRoot = await resolver();
      const npmGlobalRoot = temporaryRoot(`npm-after-${label}`);
      const installed = writeNpmGlobalPackage(npmGlobalRoot, name, version);
      const commands: string[] = [];

      const resolved = resolveInstalledPackageRoot(name, version, command => {
        commands.push(command.join(" "));
        return command.join(" ") === "volta which ocx"
          ? { status: 0, stdout, stderr: "" }
          : { status: 0, stdout: npmGlobalRoot, stderr: "" };
      }, { findExecutable: () => installed.bin });
      expect(resolved).toBe(realpathSync(installed.root));
      expect(commands).toEqual(["volta which ocx", "npm root -g"]);
    });
  }

  test("accepts a Windows npm cmd shim that strictly targets the validated package bin", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const stale = writeDirectOcxPackage(temporaryRoot("volta-windows-stale"), name, "2.36.0-ben.3");
    const prefix = temporaryRoot("windows-npm-prefix");
    const npmGlobalRoot = join(prefix, "node_modules");
    const installed = writeNpmGlobalPackage(npmGlobalRoot, name, version);
    const shim = writeWindowsNpmShim(prefix, installed.bin);

    const resolved = resolveInstalledPackageRoot(name, version, command => (
      command.join(" ") === "volta which ocx"
        ? { status: 0, stdout: stale.bin, stderr: "" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" }
    ), { platform: "win32", findExecutable: () => shim });

    expect(resolved).toBe(realpathSync(installed.root));
  });

  test("rejects a Windows npm cmd shim selected from another prefix", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const stale = writeDirectOcxPackage(temporaryRoot("volta-windows-shadow"), name, "2.36.0-ben.3");
    const prefix = temporaryRoot("windows-npm-owned");
    const npmGlobalRoot = join(prefix, "node_modules");
    writeNpmGlobalPackage(npmGlobalRoot, name, version);
    const shadowPrefix = temporaryRoot("windows-npm-shadow-prefix");
    const shadow = writePackageRoot(join(shadowPrefix, "package"), name, version);
    const shadowShim = writeWindowsNpmShim(shadowPrefix, shadow.bin);

    expect(() => resolveInstalledPackageRoot(name, version, command => (
      command.join(" ") === "volta which ocx"
        ? { status: 0, stdout: stale.bin, stderr: "" }
        : { status: 0, stdout: npmGlobalRoot, stderr: "" }
    ), { platform: "win32", findExecutable: () => shadowShim }))
      .toThrow("could not locate the installed package matching");
  });

  test("rejects a direct candidate whose executable is not the package ocx bin", async () => {
    const resolveInstalledPackageRoot = await resolver();
    const forged = writePackageRoot(temporaryRoot("forged-direct"), name, version);
    const rogue = join(forged.root, "bin", "ocx");
    writeFileSync(rogue, "#!/usr/bin/env node\n", "utf8");

    expect(() => resolveInstalledPackageRoot(name, version, () => ({
      status: 0,
      stdout: rogue,
      stderr: "",
    }))).toThrow("could not locate the installed package matching");
  });

  test.skipIf(process.platform === "win32")(
    "rejects an npm package whose ancestor symlink escapes the global root",
    async () => {
      const resolveInstalledPackageRoot = await resolver();
      const npmGlobalRoot = temporaryRoot("npm-symlink-root");
      const externalScope = temporaryRoot("external-scope");
      writePackageRoot(join(externalScope, "opencodex"), name, version);
      symlinkSync(externalScope, join(npmGlobalRoot, "@bitkyc08"), "dir");

      expect(() => resolveInstalledPackageRoot(name, version, command => (
        command.join(" ") === "volta which ocx"
          ? { status: -1, stdout: "", stderr: "volta unavailable", errorCode: "ENOENT" }
          : { status: 0, stdout: npmGlobalRoot, stderr: "" }
      ))).toThrow("could not locate the installed package matching");
    },
  );

  for (const [badName, badVersion] of [
    ["../escape", version],
    ["@scope/../../escape", version],
    [name, "2.37.0\nforged"],
    [name, ""],
    ["a".repeat(215), version],
  ] as const) {
    test("rejects unsafe package metadata before executing discovery commands", async () => {
      const resolveInstalledPackageRoot = await resolver();
      let commands = 0;

      expect(() => resolveInstalledPackageRoot(badName, badVersion, () => {
        commands += 1;
        return { status: 1, stdout: "", stderr: "" };
      })).toThrow("invalid installed package identity");
      expect(commands).toBe(0);
    });
  }

  test("parses package identity with the same early safety gate used by the installer", async () => {
    const parsePackageIdentity = await identityParser();

    expect(parsePackageIdentity(JSON.stringify({ name, version }))).toEqual({ name, version });
    expect(() => parsePackageIdentity(JSON.stringify({
      name: "a".repeat(215),
      version,
    }))).toThrow("invalid package.json identity");
    expect(() => parsePackageIdentity(JSON.stringify({
      name,
      version: "2.37.0\nforged",
    }))).toThrow("invalid package.json identity");
    expect(() => parsePackageIdentity("{broken")).toThrow("invalid package.json identity");
    expect(() => parsePackageIdentity("null")).toThrow("invalid package.json identity");
    expect(() => parsePackageIdentity("[]")).toThrow("invalid package.json identity");
  });
});
