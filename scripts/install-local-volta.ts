import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Volta v2.0.2 package/configure.rs writes Npm records from metadata.rs after replacing an image.
// Update only existing matching records; unexpected schema or bins stop the install.
type RegistrationRecord = Record<string, unknown>;
type RegistrationPath = { path: string; before: string; after: string };
type RegistrationSnapshot = { version: string; records: RegistrationPath[] };

export type VoltaRegistrationSyncOptions = {
  env?: NodeJS.ProcessEnv;
  renameSync?: typeof renameSync;
  platform?: NodeJS.Platform;
};

export type VoltaRegistrationSync = {
  sync(): void;
  verify(): void;
  rollback<T extends { ok: boolean }>(restorePackage: () => T): T;
};

type VoltaContext = {
  home: string;
  packageRoot: string;
  packageName: string;
  packageConfig: string;
  binConfigDirectory: string;
  journal: string;
  rename: typeof renameSync;
};

function packageNameIsSafe(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
    && !name.includes("..")
    && !name.includes("\\");
}

function binNameIsSafe(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) && name !== "." && name !== "..";
}

function versionIsSafe(version: unknown): version is string {
  return typeof version === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function isPlainRecord(value: unknown): value is RegistrationRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as RegistrationRecord;
  const rightRecord = right as RegistrationRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
}

function regularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

function regularDirectory(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
}

function regularDirectoryChain(root: string, leaf: string, label: string): void {
  if (root !== leaf && !canonicalContained(root, leaf)) {
    throw new Error(`${label} escapes the Volta home`);
  }
  regularDirectory(root, label);
  const relation = relative(root, leaf);
  let current = root;
  for (const part of relation.split(/[\\/]/)) {
    if (!part) continue;
    current = join(current, part);
    regularDirectory(current, label);
  }
}

function canonicalContained(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation.length > 0
    && relation !== ".."
    && !isAbsolute(relation)
    && !relation.startsWith(`..${sep}`)
    && !relation.startsWith("../")
    && !relation.startsWith("..\\");
}

function declaredBins(manifest: RegistrationRecord): string[] {
  const bin = manifest.bin;
  if (typeof bin === "string") {
    if (!binPathIsSafe(bin)) throw new Error("Volta package manifest declares an unsafe bin path");
    const name = basename(manifest.name as string).replace(/^@/, "");
    if (!binNameIsSafe(name)) throw new Error("Volta package manifest declares an unsafe bin name");
    return [name];
  }
  if (!isPlainRecord(bin)) throw new Error("Volta package manifest must declare bins as an object or string");
  const names = Object.keys(bin);
  if (names.length === 0 || names.some(name => !binNameIsSafe(name) || !binPathIsSafe(bin[name]))) {
    throw new Error("Volta package manifest declares an unsafe bin");
  }
  return names;
}

function binPathIsSafe(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")
    || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  return normalized.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function assertManifestBinTargets(packageRoot: string, manifest: RegistrationRecord): void {
  const values = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin as RegistrationRecord);
  for (const value of values) {
    if (!binPathIsSafe(value)) throw new Error("Volta package manifest declares an unsafe bin path");
    const target = resolve(packageRoot, value.startsWith("./") ? value.slice(2) : value);
    if (!canonicalContained(packageRoot, target)) {
      throw new Error("Volta package manifest bin escapes its package root");
    }
    regularFile(target, "Volta package manifest bin");
  }
}

function readJsonRecord(path: string, label: string): { raw: string; value: RegistrationRecord } {
  regularFile(path, label);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${label} could not be read`);
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isPlainRecord(value)) throw new Error("not an object");
    return { raw, value };
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateRegistrationTarget(context: VoltaContext, path: string, label: string): void {
  regularDirectoryChain(context.home, dirname(path), `${label} directory`);
  regularFile(path, label);
}

function sameBinSet(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((name, index) => typeof name === "string" && binNameIsSafe(name)
    && left.indexOf(name) === index && right.includes(name));
}

function validPlatform(platform: unknown): platform is RegistrationRecord {
  if (!isPlainRecord(platform) || !versionIsSafe(platform.node)) return false;
  return ["npm", "pnpm", "yarn"].every(name => {
    const value = platform[name];
    return value === undefined || value === null || versionIsSafe(value);
  });
}

function journalName(packageName: string): string {
  return `.ocx-volta-registration-${encodeURIComponent(packageName)}.journal`;
}

function resolveVoltaContext(
  packageRoot: string,
  packageName: string,
  options: VoltaRegistrationSyncOptions,
): VoltaContext | null {
  if (!packageNameIsSafe(packageName)) throw new Error("invalid Volta package name");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const defaultHome = platform === "win32"
    ? join(env.LOCALAPPDATA || join(env.USERPROFILE || env.HOME || homedir(), "AppData", "Local"), "Volta")
    : join(env.HOME || homedir(), ".volta");
  const configuredHome = env.VOLTA_HOME || defaultHome;
  const requestedRoot = resolve(packageRoot);
  const requestedImageRoot = join(resolve(configuredHome), "tools", "image", "packages");
  const lexicalManaged = canonicalContained(requestedImageRoot, requestedRoot);
  if (!existsSync(configuredHome)) {
    if (lexicalManaged) throw new Error("Volta home is missing for its managed package root");
    return null;
  }
  let home: string;
  try {
    home = realpathSync(configuredHome);
    regularDirectory(home, "Volta home");
  } catch {
    if (lexicalManaged) throw new Error("Volta home is invalid for its managed package root");
    return null;
  }
  const imageRoot = join(home, "tools", "image", "packages");
  if (!existsSync(packageRoot)) {
    if (lexicalManaged) throw new Error("Volta package root is missing");
    return null;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(packageRoot);
  } catch {
    if (lexicalManaged) throw new Error("Volta package root is invalid");
    return null;
  }
  const packageSegments = packageName.split("/");
  const sourceRoot = platform === "win32"
    ? join(imageRoot, ...packageSegments, "node_modules")
    : join(imageRoot, ...packageSegments, "lib", "node_modules");
  const expected = join(sourceRoot, ...packageSegments);
  const canonicalManaged = canonicalContained(imageRoot, canonicalRoot);
  if (canonicalRoot !== expected) {
    if (lexicalManaged || canonicalManaged) {
      throw new Error("Volta package root does not match its managed image source");
    }
    return null;
  }
  if (!canonicalManaged) throw new Error("Volta package root escapes its image source");
  regularDirectory(packageRoot, "Volta package root");

  const userRoot = join(home, "tools", "user");
  regularDirectoryChain(home, userRoot, "Volta user registration directory");
  regularDirectoryChain(userRoot, dirname(join(userRoot, "packages", ...packageSegments) + ".json"), "Volta package registration directory");
  regularDirectoryChain(userRoot, join(userRoot, "bins"), "Volta bin registration directory");
  return {
    home,
    packageRoot: canonicalRoot,
    packageName,
    packageConfig: join(userRoot, "packages", ...packageSegments) + ".json",
    binConfigDirectory: join(userRoot, "bins"),
    journal: join(userRoot, journalName(packageName)),
    rename: options.renameSync ?? renameSync,
  };
}

function snapshot(
  context: VoltaContext,
  requireCurrentVersion: boolean,
  journalAllowed = false,
): RegistrationSnapshot {
  if (!journalAllowed && existsSync(context.journal)) throw new Error("Volta registration recovery journal is present");
  regularDirectoryChain(context.home, context.packageRoot, "Volta package root");
  const manifestPath = join(context.packageRoot, "package.json");
  regularFile(manifestPath, "Volta package manifest");
  const manifest = readJsonRecord(manifestPath, "Volta package manifest").value;
  if (manifest.name !== context.packageName || !versionIsSafe(manifest.version)) {
    throw new Error("Volta package manifest identity is invalid");
  }
  const bins = declaredBins(manifest);
  assertManifestBinTargets(context.packageRoot, manifest);
  validateRegistrationTarget(context, context.packageConfig, "Volta package registration");
  const packageConfig = readJsonRecord(context.packageConfig, "Volta package registration");
  const platform = packageConfig.value.platform;
  if (packageConfig.value.name !== context.packageName
    || !versionIsSafe(packageConfig.value.version)
    || packageConfig.value.manager !== "Npm"
    || !validPlatform(platform)
    || !sameBinSet(packageConfig.value.bins, bins)) {
    throw new Error("Volta package registration does not match its managed package");
  }

  const records: RegistrationPath[] = [{
    path: context.packageConfig,
    before: packageConfig.raw,
    after: `${JSON.stringify({ ...packageConfig.value, version: manifest.version }, null, 2)}\n`,
  }];
  for (const bin of bins) {
    const path = join(context.binConfigDirectory, `${bin}.json`);
    validateRegistrationTarget(context, path, "Volta bin registration");
    const config = readJsonRecord(path, "Volta bin registration");
    if (config.value.name !== bin
      || config.value.package !== context.packageName
      || !versionIsSafe(config.value.version)
      || config.value.manager !== "Npm"
      || !sameValue(config.value.platform, platform)) {
      throw new Error("Volta bin registration does not match its managed package");
    }
    records.push({
      path,
      before: config.raw,
      after: `${JSON.stringify({ ...config.value, version: manifest.version }, null, 2)}\n`,
    });
  }
  if (requireCurrentVersion && records.some(record => JSON.parse(record.before).version !== manifest.version)) {
    throw new Error("Volta registration version does not match its managed package");
  }
  return { version: manifest.version, records };
}

function atomicWrite(context: VoltaContext, path: string, contents: string, expected?: string): void {
  validateRegistrationTarget(context, path, "Volta registration");
  if (expected !== undefined && readFileSync(path, "utf8") !== expected) {
    throw new Error("Volta registration changed during synchronization");
  }
  const temporary = join(dirname(path), `.${basename(path)}.ocx-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    validateRegistrationTarget(context, path, "Volta registration");
    if (expected !== undefined && readFileSync(path, "utf8") !== expected) {
      throw new Error("Volta registration changed during synchronization");
    }
    context.rename(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* cleanup only */ }
  }
}

function journalContents(context: VoltaContext, snapshot: RegistrationSnapshot, phase: string): string {
  return `${JSON.stringify({
    owner: context.packageName,
    operation: randomUUID(),
    phase,
    version: snapshot.version,
    records: snapshot.records,
  }, null, 2)}\n`;
}

function writeJournal(context: VoltaContext, snapshot: RegistrationSnapshot, phase: string): string {
  regularDirectoryChain(context.home, dirname(context.journal), "Volta user registration directory");
  const contents = journalContents(context, snapshot, phase);
  writeFileSync(context.journal, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(context.journal, 0o600);
  return contents;
}

function updateJournal(
  context: VoltaContext,
  previous: string,
  snapshot: RegistrationSnapshot,
  phase: string,
): string {
  const contents = journalContents(context, snapshot, phase);
  atomicWrite(context, context.journal, contents, previous);
  return contents;
}

function removeJournal(context: VoltaContext, expected: string): void {
  validateRegistrationTarget(context, context.journal, "Volta registration recovery journal");
  if (readFileSync(context.journal, "utf8") !== expected) {
    throw new Error("Volta registration recovery journal changed during synchronization");
  }
  rmSync(context.journal, { force: false });
}

function restoreBeforeImages(context: VoltaContext, records: RegistrationPath[]): boolean {
  let complete = true;
  for (const record of [...records].reverse()) {
    try {
      if (readFileSync(record.path, "utf8") === record.before) continue;
      if (readFileSync(record.path, "utf8") !== record.after) {
        complete = false;
        continue;
      }
      atomicWrite(context, record.path, record.before, record.after);
    } catch {
      complete = false;
    }
  }
  return complete;
}

function syncOwned(context: VoltaContext, journal: string, preserveJournalOnFailure: boolean): void {
  const current = snapshot(context, false, true);
  const ownedJournal = updateJournal(context, journal, current, "metadata-sync-pending");
  if (current.records.every(record => JSON.parse(record.before).version === current.version)) {
    snapshot(context, true, true);
    removeJournal(context, ownedJournal);
    return;
  }
  const completed: RegistrationPath[] = [];
  try {
    for (const record of current.records) {
      atomicWrite(context, record.path, record.after, record.before);
      completed.push(record);
    }
    snapshot(context, true, true);
    removeJournal(context, ownedJournal);
  } catch (error) {
    const restored = restoreBeforeImages(context, completed);
    if (!preserveJournalOnFailure
      && restored
      && current.records.every(record => readFileSync(record.path, "utf8") === record.before)) {
      try { removeJournal(context, ownedJournal); } catch { /* preserve the journal */ }
    }
    throw error;
  }
}

function assertTrustedRegistrationSnapshot(context: VoltaContext, trusted: RegistrationSnapshot): void {
  if (existsSync(context.journal)) throw new Error("Volta registration recovery journal is present");
  for (const record of trusted.records) {
    validateRegistrationTarget(context, record.path, "Volta registration");
    if (readFileSync(record.path, "utf8") !== record.before) {
      throw new Error("Volta registration changed before package rollback");
    }
  }
}

export function createVoltaRegistrationSync(
  packageRoot: string,
  packageName: string,
  options: VoltaRegistrationSyncOptions = {},
): VoltaRegistrationSync | null {
  const context = resolveVoltaContext(packageRoot, packageName, options);
  if (!context) return null;
  let trusted = snapshot(context, false);

  return {
    sync(): void {
      const current = snapshot(context, false);
      if (current.records.every(record => JSON.parse(record.before).version === current.version)) {
        trusted = snapshot(context, true);
        return;
      }
      const journal = writeJournal(context, current, "metadata-sync-pending");
      syncOwned(context, journal, false);
      trusted = snapshot(context, true);
    },
    verify(): void {
      snapshot(context, true);
    },
    rollback<T extends { ok: boolean }>(restorePackage: () => T): T {
      assertTrustedRegistrationSnapshot(context, trusted);
      const journal = writeJournal(context, trusted, "package-rollback-pending");
      const result = restorePackage();
      if (!result.ok) return result;
      syncOwned(context, journal, true);
      trusted = snapshot(context, true);
      return result;
    },
  };
}
