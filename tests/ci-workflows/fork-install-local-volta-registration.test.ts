import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type VoltaRegistration = {
  sync(): void;
  verify(): void;
  rollback<T extends { ok: boolean }>(restorePackage: () => T): T;
};
type CreateVoltaRegistrationSync = (
  packageRoot: string,
  packageName: string,
  options?: { env?: NodeJS.ProcessEnv; renameSync?: typeof renameSync; platform?: NodeJS.Platform },
) => VoltaRegistration | null;

const roots: string[] = [];
const packageName = "@bitkyc08/opencodex";
const oldVersion = "2.38.0-ben.1";
const currentVersion = "2.46.0-ben.1";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createSync(): Promise<CreateVoltaRegistrationSync> {
  const module = await import("../../scripts/install-local-volta");
  const factory = (module as { createVoltaRegistrationSync?: CreateVoltaRegistrationSync })
    .createVoltaRegistrationSync;
  expect(typeof factory).toBe("function");
  if (!factory) throw new Error("createVoltaRegistrationSync is unavailable");
  return factory;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fixture(
  version = currentVersion,
  registrationVersion = oldVersion,
  hostPlatform = process.platform,
): {
  voltaHome: string;
  packageRoot: string;
  env: NodeJS.ProcessEnv;
  records: { package: string; ocx: string; opencodex: string };
} {
  const root = mkdtempSync(join(tmpdir(), "ocx-volta-registration-"));
  roots.push(root);
  const voltaHome = hostPlatform === "win32" ? join(root, "Volta") : join(root, "volta home with spaces");
  const imageSource = hostPlatform === "win32"
    ? join(voltaHome, "tools", "image", "packages", "@bitkyc08", "opencodex", "node_modules")
    : join(voltaHome, "tools", "image", "packages", "@bitkyc08", "opencodex", "lib", "node_modules");
  const packageRoot = join(imageSource, "@bitkyc08", "opencodex");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(packageRoot, "bin", "ocx.mjs"), "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o755 });
  writeFileSync(join(packageRoot, "bin", "opencodex.mjs"), "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o755 });
  writeJson(join(packageRoot, "package.json"), {
    name: packageName,
    version,
    bin: { ocx: "./bin/ocx.mjs", opencodex: "./bin/opencodex.mjs" },
  });

  const platform = { node: "22.21.1", npm: "10.9.0", pnpm: null, yarn: null };
  const records = {
    package: join(voltaHome, "tools", "user", "packages", "@bitkyc08", "opencodex.json"),
    ocx: join(voltaHome, "tools", "user", "bins", "ocx.json"),
    opencodex: join(voltaHome, "tools", "user", "bins", "opencodex.json"),
  };
  writeJson(records.package, {
    name: packageName,
    version: registrationVersion,
    platform,
    bins: ["ocx", "opencodex"],
    manager: "Npm",
    preserved: { installSource: "fixture" },
  });
  for (const name of ["ocx", "opencodex"] as const) {
    writeJson(records[name], {
      name,
      package: packageName,
      version: registrationVersion,
      platform,
      manager: "Npm",
      preserved: { installSource: "fixture" },
    });
  }
  return { voltaHome, packageRoot, env: { VOLTA_HOME: voltaHome, HOME: join(root, "other-home") }, records };
}

function recordVersions(records: { package: string; ocx: string; opencodex: string }): string[] {
  return Object.values(records).map(path => readJson(path).version as string);
}

function registrationJournalExists(voltaHome: string): boolean {
  const userRoot = join(voltaHome, "tools", "user");
  return readdirSync(userRoot).some(name => name.startsWith(".ocx-volta-registration-") && name.endsWith(".journal"));
}

describe("install-local Volta registration synchronization", () => {
  test("synchronizes all Volta records from the real package manifest and preserves pins", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture();
    const sync = create(realpathSync(packageRoot), packageName, { env });

    expect(sync).not.toBeNull();
    sync?.sync();
    sync?.verify();

    expect(recordVersions(records)).toEqual([currentVersion, currentVersion, currentVersion]);
    expect(readJson(records.package)).toMatchObject({
      platform: { node: "22.21.1", npm: "10.9.0", pnpm: null, yarn: null },
      bins: ["ocx", "opencodex"],
      manager: "Npm",
      preserved: { installSource: "fixture" },
    });
    expect(readJson(records.ocx)).toMatchObject({
      name: "ocx",
      package: packageName,
      manager: "Npm",
      platform: { node: "22.21.1", npm: "10.9.0", pnpm: null, yarn: null },
    });
  });

  test("leaves normal npm, nvm, and nvm-windows package roots untouched", async () => {
    const create = await createSync();
    const root = mkdtempSync(join(tmpdir(), "ocx-non-volta-registration-"));
    roots.push(root);
    const rootsOutsideVolta = [
      join(root, "npm", "lib", "node_modules", "@bitkyc08", "opencodex"),
      join(root, ".nvm", "versions", "node", "v22.21.1", "lib", "node_modules", "@bitkyc08", "opencodex"),
      join(root, "nvm-windows", "v22.21.1", "node_modules", "@bitkyc08", "opencodex"),
    ];
    for (const packageRoot of rootsOutsideVolta) {
      mkdirSync(packageRoot, { recursive: true });
      writeJson(join(packageRoot, "package.json"), { name: packageName, version: currentVersion, bin: { ocx: "bin/ocx.mjs" } });
      expect(create(packageRoot, packageName, { env: { HOME: join(root, "no-volta-home") } })).toBeNull();
    }
  });

  test("recognizes Volta's Windows default home without treating nvm-windows as Volta", async () => {
    const create = await createSync();
    const { voltaHome, packageRoot, records } = fixture(currentVersion, oldVersion, "win32");
    const sync = create(packageRoot, packageName, {
      env: { LOCALAPPDATA: dirname(voltaHome) },
      platform: "win32",
    });

    expect(sync).not.toBeNull();
    if (!sync) throw new Error("Windows Volta registration synchronization was not created");
    sync.sync();
    expect(recordVersions(records)).toEqual([currentVersion, currentVersion, currentVersion]);
  });

  test("does not replace current Volta registrations", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture(currentVersion, currentVersion);
    const registrationTargets = new Set(Object.values(records).map(path => realpathSync(path)));
    const sync = create(packageRoot, packageName, {
      env,
      renameSync: (_source, destination) => {
        if (registrationTargets.has(String(destination))) throw new Error("current registration was replaced");
        renameSync(_source, destination);
      },
    });

    expect(sync).not.toBeNull();
    if (!sync) throw new Error("Volta registration synchronization was not created");
    expect(() => sync.sync()).not.toThrow();
    sync.verify();
  });

  test.skipIf(process.platform === "win32")(
    "rejects a swapped registration directory even when every version is already current",
    async () => {
      const create = await createSync();
      const { voltaHome, packageRoot, env, records } = fixture(currentVersion, currentVersion);
      const binDirectory = dirname(records.ocx);
      const external = join(dirname(voltaHome), "current-external-bins");
      const externalOcx = join(external, "ocx.json");
      const externalOpenCodex = join(external, "opencodex.json");
      mkdirSync(external, { recursive: true });
      const originalOcx = readFileSync(records.ocx, "utf8");
      const originalOpenCodex = readFileSync(records.opencodex, "utf8");
      writeFileSync(externalOcx, originalOcx, "utf8");
      writeFileSync(externalOpenCodex, originalOpenCodex, "utf8");
      const sync = create(packageRoot, packageName, { env });

      rmSync(binDirectory, { recursive: true, force: true });
      symlinkSync(external, binDirectory, "dir");

      expect(() => sync?.verify()).toThrow("must be a regular directory");
      expect(() => sync?.sync()).toThrow("must be a regular directory");
      expect(readFileSync(externalOcx, "utf8")).toBe(originalOcx);
      expect(readFileSync(externalOpenCodex, "utf8")).toBe(originalOpenCodex);
    },
  );

  test("fails closed when a bin record belongs to another package", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture();
    const invalid = readJson(records.ocx);
    invalid.package = "@other/package";
    writeJson(records.ocx, invalid);

    expect(() => create(packageRoot, packageName, { env })).toThrow("Volta bin registration does not match its managed package");
    expect(recordVersions(records)).toEqual([oldVersion, oldVersion, oldVersion]);
  });

  test("restores every record when a later atomic replacement fails", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture();
    const registrationTargets = new Set(Object.values(records).map(path => realpathSync(path)));
    let replacements = 0;
    const sync = create(packageRoot, packageName, {
      env,
      renameSync: (source, destination) => {
        if (registrationTargets.has(String(destination)) && ++replacements === 2) {
          throw new Error("synthetic second registration rename failure");
        }
        renameSync(source, destination);
      },
    });

    expect(() => sync?.sync()).toThrow("synthetic second registration rename failure");
    expect(recordVersions(records)).toEqual([oldVersion, oldVersion, oldVersion]);
  });

  test("does not overwrite a record changed between preflight and its replacement", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture();
    const registrationTargets = new Set(Object.values(records).map(path => realpathSync(path)));
    let changed = false;
    const sync = create(packageRoot, packageName, {
      env,
      renameSync: (source, destination) => {
        renameSync(source, destination);
        if (!changed && registrationTargets.has(String(destination))) {
          changed = true;
          const victim = Object.values(records).find(path => path !== destination)!;
          const external = readJson(victim);
          external.version = "external-change";
          writeJson(victim, external);
        }
      },
    });

    expect(() => sync?.sync()).toThrow(/changed|concurrent|Volta/i);
    expect(recordVersions(records)).toContain("external-change");
    expect(recordVersions(records)).not.toContain(currentVersion);
  });

  test.skipIf(process.platform === "win32")(
    "refuses a registration directory swapped for an external symlink before writing it",
    async () => {
      const create = await createSync();
      const { voltaHome, packageRoot, env, records } = fixture();
      const registrationTargets = new Set(Object.values(records).map(path => realpathSync(path)));
      const binDirectory = dirname(records.ocx);
      const external = join(dirname(voltaHome), "external-bins");
      const externalOcx = join(external, "ocx.json");
      const externalOpenCodex = join(external, "opencodex.json");
      mkdirSync(external, { recursive: true });
      writeFileSync(externalOcx, "external ocx", "utf8");
      writeFileSync(externalOpenCodex, "external opencodex", "utf8");
      let swapped = false;
      const sync = create(packageRoot, packageName, {
        env,
        renameSync: (source, destination) => {
          renameSync(source, destination);
          if (!swapped && registrationTargets.has(String(destination))) {
            swapped = true;
            rmSync(binDirectory, { recursive: true, force: true });
            symlinkSync(external, binDirectory, "dir");
          }
        },
      });

      expect(() => sync?.sync()).toThrow(/regular directory|symlink|Volta/i);
      expect(readFileSync(externalOcx, "utf8")).toBe("external ocx");
      expect(readFileSync(externalOpenCodex, "utf8")).toBe("external opencodex");
    },
  );

  test("uses the manifest version again when rollback restores the previous package", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture();
    const sync = create(packageRoot, packageName, { env });
    sync?.sync();
    expect(recordVersions(records)).toEqual([currentVersion, currentVersion, currentVersion]);
    const manifest = readJson(join(packageRoot, "package.json"));
    manifest.version = oldVersion;
    writeJson(join(packageRoot, "package.json"), manifest);

    sync?.sync();
    sync?.verify();

    expect(recordVersions(records)).toEqual([oldVersion, oldVersion, oldVersion]);
  });

  test("keeps a recovery journal when the package rollback callback throws", async () => {
    const create = await createSync();
    const { voltaHome, packageRoot, env } = fixture(currentVersion, currentVersion);
    const sync = create(packageRoot, packageName, { env });

    expect(() => sync?.rollback(() => {
      expect(registrationJournalExists(voltaHome)).toBe(true);
      throw new Error("synthetic package rollback failure");
    })).toThrow("synthetic package rollback failure");
    expect(registrationJournalExists(voltaHome)).toBe(true);
    expect(() => create(packageRoot, packageName, { env })).toThrow(/journal|recovery|incomplete/i);
  });

  test("keeps a recovery journal when package rollback reports failure", async () => {
    const create = await createSync();
    const { voltaHome, packageRoot, env } = fixture(currentVersion, currentVersion);
    const sync = create(packageRoot, packageName, { env });

    expect(sync?.rollback(() => {
      expect(registrationJournalExists(voltaHome)).toBe(true);
      return { ok: false };
    })).toEqual({ ok: false });
    expect(registrationJournalExists(voltaHome)).toBe(true);
    expect(() => create(packageRoot, packageName, { env })).toThrow(/journal|recovery|incomplete/i);
  });

  test("synchronizes old metadata before removing the journal after package rollback", async () => {
    const create = await createSync();
    const { voltaHome, packageRoot, env, records } = fixture(currentVersion, currentVersion);
    const sync = create(packageRoot, packageName, { env });

    const result = sync?.rollback(() => {
      expect(registrationJournalExists(voltaHome)).toBe(true);
      const manifest = readJson(join(packageRoot, "package.json"));
      manifest.version = oldVersion;
      writeJson(join(packageRoot, "package.json"), manifest);
      return { ok: true, marker: "restored" };
    });

    expect(result).toEqual({ ok: true, marker: "restored" });
    expect(recordVersions(records)).toEqual([oldVersion, oldVersion, oldVersion]);
    expect(registrationJournalExists(voltaHome)).toBe(false);
  });

  test("fails closed on the next attempt when a failed rollback leaves recovery evidence", async () => {
    const create = await createSync();
    const { packageRoot, env, records } = fixture();
    const registrationTargets = new Set(Object.values(records).map(path => realpathSync(path)));
    let replacements = 0;
    const sync = create(packageRoot, packageName, {
      env,
      renameSync: (source, destination) => {
        if (registrationTargets.has(String(destination)) && ++replacements >= 2) {
          throw new Error("synthetic durable failure");
        }
        renameSync(source, destination);
      },
    });

    expect(() => sync?.sync()).toThrow("synthetic durable failure");
    expect(() => create(packageRoot, packageName, { env })?.sync()).toThrow(/journal|recovery|incomplete/i);
    expect(existsSync(records.package)).toBe(true);
  });
});
