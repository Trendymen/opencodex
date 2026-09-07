import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { commandInvocation } from "../src/lib/win-exec";
import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";

export function bundledDependenciesForLocalPackage(
  dependencies: Record<string, string> | undefined,
  presentOptionalDependencies: readonly string[] = [],
): string[] {
  return [...new Set([
    ...Object.keys(dependencies ?? {}),
    ...presentOptionalDependencies,
  ])].sort();
}

export type LocalPackageStageOptions = Readonly<{
  makeTempRoot(prefix: string): string;
  run(
    command: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options?: LocalPackageRunOptions,
  ): LocalPackageRunResult;
  removeTree(path: string): void;
}>;

export type LocalPackageRunOptions = Readonly<{ timeoutMs?: number }>;
export type LocalPackageRunResult = Readonly<{
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}>;

export type PreparedLocalPackage = Readonly<{
  tarball: string;
  npmCache: string;
  rootManifestBytes: string;
  cleanup(): void;
}>;

function runCommand(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: LocalPackageRunOptions = {},
): LocalPackageRunResult {
  const invocation = commandInvocation(command[0]!, command.slice(1));
  const result = Bun.spawnSync([invocation.file, ...invocation.args], {
    cwd, env, stdout: "pipe", stderr: "pipe",
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    ...(options.timeoutMs !== undefined ? { maxBuffer: 4_096 } : {}),
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    timedOut: result.exitedDueToTimeout === true,
  };
}

export const defaultLocalPackageStageOptions: LocalPackageStageOptions = {
  makeTempRoot: prefix => mkdtempSync(join(tmpdir(), prefix)),
  run: runCommand,
  removeTree: path => rmSync(path, { recursive: true, force: true }),
};

export function assertRootManifestUnchanged(
  packageRoot: string,
  expectedBytes: string,
  phase: string,
): void {
  if (readFileSync(join(packageRoot, "package.json"), "utf8") !== expectedBytes) {
    throw new Error(`root package.json changed during ${phase}`);
  }
}

function pathContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw new Error("package files entries must be non-empty relative paths");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error("package files entry escapes the package root");
  }
  return value;
}

function copyContainedEntry(
  source: string,
  destination: string,
  containmentRoot: string,
  active = new Set<string>(),
): void {
  const canonicalRoot = realpathSync(containmentRoot);
  const canonicalSource = realpathSync(source);
  if (!pathContained(canonicalRoot, canonicalSource)) {
    throw new Error("package source escapes its contained source root");
  }
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) {
    const target = realpathSync(source);
    if (!pathContained(canonicalRoot, target)) throw new Error("package link escapes its contained source root");
    copyContainedEntry(target, destination, containmentRoot, active);
    return;
  }
  if (entry.isDirectory()) {
    const real = realpathSync(source);
    if (active.has(real)) throw new Error("package source contains a link cycle");
    active.add(real);
    mkdirSync(destination, { recursive: true, mode: entry.mode & 0o777 });
    for (const name of readdirSync(source)) {
      copyContainedEntry(join(source, name), join(destination, name), containmentRoot, active);
    }
    active.delete(real);
    try { chmodSync(destination, entry.mode & 0o777); } catch { /* Windows projection is best effort. */ }
    return;
  }
  if (!entry.isFile()) throw new Error("package source contains a non-file entry");
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  try { chmodSync(destination, entry.mode & 0o777); } catch { /* Windows projection is best effort. */ }
}

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  files?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  main?: unknown;
  exports?: unknown;
  bin?: unknown;
  [key: string]: unknown;
};

const SENSITIVE_ARCHIVE_SEGMENTS = new Set([".env", ".npmrc", ".git", ".gitconfig"]);

function validatePackFiles(
  files: unknown[],
  manifest: PackageManifest,
  allowedDependencyRoots: ReadonlySet<string>,
): void {
  const declared = Array.isArray(manifest.files) ? manifest.files.map(safeRelativePath) : [];
  const seen = new Set<string>();
  for (const raw of files) {
    if (!raw || typeof raw !== "object") throw new Error("npm pack file row must be an object");
    const path = (raw as { path?: unknown }).path;
    const normalized = safeRelativePath(path).replaceAll("\\", "/");
    if (seen.has(normalized)) throw new Error("npm pack file manifest contains a duplicate path");
    seen.add(normalized);
    if (normalized.split("/").some(part => SENSITIVE_ARCHIVE_SEGMENTS.has(part))) {
      throw new Error("npm pack file manifest contains a sensitive path");
    }
    const allowedDependency = [...allowedDependencyRoots]
      .some(root => normalized === root || normalized.startsWith(`${root}/`));
    const allowed = normalized === "package.json"
      || declared.some(entry => normalized === entry || normalized.startsWith(`${entry.replaceAll("\\", "/")}/`))
      || allowedDependency;
    if (!allowed) throw new Error(`npm pack file is outside the allowed surface: ${normalized}`);
  }
  if (!seen.has("package.json")) throw new Error("npm pack file manifest omits package.json");
}

function parsePackTarball(
  output: string,
  manifest: PackageManifest,
  packageRoot: string,
  allowedDependencyRoots: ReadonlySet<string>,
): string {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("npm pack did not produce JSON output"); }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    throw new Error("npm pack JSON must contain exactly one package");
  }
  const row = parsed[0] as Record<string, unknown>;
  if (row.name !== manifest.name || row.version !== manifest.version) throw new Error("npm pack package identity mismatch");
  if (typeof row.integrity !== "string" || typeof row.shasum !== "string" || !Array.isArray(row.files)) {
    throw new Error("npm pack JSON is missing integrity or file-manifest evidence");
  }
  if (typeof row.filename !== "string" || !/^[^/\\]+\.tgz$/.test(row.filename)) {
    throw new Error("npm pack returned an invalid tarball filename");
  }
  const tarball = resolve(packageRoot, row.filename);
  if (relative(packageRoot, tarball) !== row.filename) throw new Error("tarball path escapes package stage");
  const stat = lstatSync(tarball);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packed tarball must be a regular file");
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  if (row.integrity !== integrity || row.shasum !== shasum) {
    throw new Error("npm pack integrity metadata does not match tarball bytes");
  }
  validatePackFiles(row.files, manifest, allowedDependencyRoots);
  return tarball;
}

function scopedPackageParts(name: string): string[] {
  return name.startsWith("@") ? name.split("/") : [name];
}

function resolveInstalledDependency(start: string, name: string, boundary: string): string | null {
  let directory = start;
  while (pathContained(boundary, directory)) {
    const candidate = join(directory, "node_modules", ...scopedPackageParts(name));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (directory === boundary) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function presentRootOptionalDependencies(
  packageRoot: string,
  manifest: PackageManifest,
): string[] {
  return Object.keys(manifest.optionalDependencies ?? {}).filter(name => (
    resolveInstalledDependency(packageRoot, name, packageRoot) !== null
  ));
}

function collectDependencyPackageRoots(
  packageRoot: string,
  boundary: string,
  archiveRoot: string,
  roots = new Set<string>(),
  visited = new Set<string>(),
): Set<string> {
  const real = realpathSync(packageRoot);
  if (visited.has(real)) return roots;
  visited.add(real);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  for (const name of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]) {
    const found = resolveInstalledDependency(packageRoot, name, boundary);
    if (!found) continue;
    const archivePath = relative(archiveRoot, found).replaceAll("\\", "/");
    if (!archivePath.startsWith("node_modules/") || archivePath.includes("..")) {
      throw new Error("dependency package root escapes staged node_modules");
    }
    roots.add(archivePath);
    collectDependencyPackageRoots(found, boundary, archiveRoot, roots, visited);
  }
  return roots;
}

function verifyDependencyClosure(packageRoot: string, boundary: string, visited = new Set<string>()): void {
  const real = realpathSync(packageRoot);
  if (visited.has(real)) return;
  visited.add(real);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const found = resolveInstalledDependency(packageRoot, dependency, boundary);
    if (!found) throw new Error(`bundled dependency is not runtime-resolvable: ${dependency}`);
    verifyDependencyClosure(found, boundary, visited);
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    const found = resolveInstalledDependency(packageRoot, dependency, boundary);
    if (found) verifyDependencyClosure(found, boundary, visited);
  }
}

function collectExportTargets(value: unknown, targets: string[]): void {
  if (typeof value === "string") {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, targets);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) collectExportTargets(entry, targets);
  }
}

function verifyInstalledTarget(installedRoot: string, rawTarget: string, label: string): void {
  const target = rawTarget.startsWith("./") ? rawTarget.slice(2) : rawTarget;
  const safe = safeRelativePath(target);
  const path = resolve(installedRoot, safe);
  if (!pathContained(installedRoot, path) || !existsSync(path)) throw new Error(`installed package ${label} target is missing`);
  const real = realpathSync(path);
  if (!pathContained(realpathSync(installedRoot), real)) throw new Error(`installed package ${label} target escapes package root`);
  if (!lstatSync(path).isFile()) throw new Error(`installed package ${label} target must be a regular file`);
}

export function probeBundledBunBinary(
  binary: string,
  cwd: string,
  run: LocalPackageStageOptions["run"],
): void {
  if (!isRealBunBinary(binary)) throw new Error("bundled Bun binary missing or incomplete for the current platform");
  let result: LocalPackageRunResult;
  try {
    result = run([binary, "--version"], cwd, { ...process.env }, { timeoutMs: 5_000 });
  } catch {
    throw new Error("bundled Bun current-platform execution probe could not start");
  }
  if (result.timedOut) throw new Error("bundled Bun current-platform execution probe timed out");
  if (result.exitCode !== 0) throw new Error("bundled Bun current-platform execution probe failed");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(result.stdout.trim())) {
    throw new Error("bundled Bun current-platform execution probe returned an invalid version");
  }
}

function verifyInstalledPackage(
  validationRoot: string,
  rootManifest: PackageManifest,
  run: LocalPackageStageOptions["run"],
  requiredBundledDependencies: readonly string[],
): void {
  if (typeof rootManifest.name !== "string" || typeof rootManifest.version !== "string") {
    throw new Error("package identity must be strings");
  }
  const installedRoot = join(validationRoot, "node_modules", ...scopedPackageParts(rootManifest.name));
  const installed = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as PackageManifest;
  for (const field of ["name", "version", "main", "exports", "bin"] as const) {
    if (JSON.stringify(installed[field]) !== JSON.stringify(rootManifest[field])) {
      throw new Error(`installed package ${field} differs from source manifest`);
    }
  }
  for (const raw of Array.isArray(rootManifest.files) ? rootManifest.files : []) {
    const declared = resolve(installedRoot, safeRelativePath(raw));
    if (!pathContained(installedRoot, declared) || !existsSync(declared)) {
      throw new Error("installed package omits a declared files entry");
    }
  }
  if (typeof installed.main === "string") verifyInstalledTarget(installedRoot, installed.main, "main");
  if (typeof installed.bin === "string") verifyInstalledTarget(installedRoot, installed.bin, "bin");
  else if (installed.bin && typeof installed.bin === "object") {
    for (const target of Object.values(installed.bin as Record<string, unknown>)) {
      if (typeof target !== "string") throw new Error("installed package bin target must be a string");
      verifyInstalledTarget(installedRoot, target, "bin");
    }
  }
  const exportTargets: string[] = [];
  collectExportTargets(installed.exports, exportTargets);
  for (const target of exportTargets) verifyInstalledTarget(installedRoot, target, "exports");
  verifyDependencyClosure(installedRoot, validationRoot);
  for (const dependency of requiredBundledDependencies) {
    if (!resolveInstalledDependency(installedRoot, dependency, validationRoot)) {
      throw new Error(`bundled dependency is missing after offline validation: ${dependency}`);
    }
  }
  if (requiredBundledDependencies.includes("bun")) {
    const bunRoot = resolveInstalledDependency(installedRoot, "bun", validationRoot);
    const binary = bunRoot && ["bun.exe", "bun"]
      .map(name => join(bunRoot, "bin", name))
      .find(isRealBunBinary);
    if (!binary) throw new Error("bundled Bun binary missing or incomplete for the current platform");
    probeBundledBunBinary(binary, installedRoot, run);
  }
}

function throwAggregate(primary: unknown, cleanup: unknown, message: string): never {
  throw new AggregateError([primary, cleanup], message);
}

export function prepareBundledLocalPackage(
  packageRoot: string,
  options: LocalPackageStageOptions = defaultLocalPackageStageOptions,
  expectedRootManifestBytes?: string,
): PreparedLocalPackage {
  const root = realpathSync(packageRoot);
  const rootManifestPath = join(root, "package.json");
  const observedRootManifestBytes = readFileSync(rootManifestPath, "utf8");
  const rootManifestBytes = expectedRootManifestBytes ?? observedRootManifestBytes;
  if (observedRootManifestBytes !== rootManifestBytes) {
    throw new Error("root package.json changed before local package preparation");
  }
  const rootManifest = JSON.parse(rootManifestBytes) as PackageManifest;
  if (typeof rootManifest.name !== "string" || typeof rootManifest.version !== "string") {
    throw new Error("package manifest requires string name and version");
  }
  if (!Array.isArray(rootManifest.files)) throw new Error("package manifest requires a files array");

  const stageRoot = options.makeTempRoot("ocx-local-package-stage-");
  const stagedPackage = join(stageRoot, "package");
  const validationRoot = join(stageRoot, "validation");
  const cacheRoot = join(stageRoot, "npm-cache");
  try {
    mkdirSync(stagedPackage, { recursive: true, mode: 0o700 });
    for (const rawPath of rootManifest.files) {
      const path = safeRelativePath(rawPath);
      const source = join(root, path);
      if (!existsSync(source)) throw new Error(`declared package file is missing: ${path}`);
      const entry = lstatSync(source);
      if (entry.isSymbolicLink()) throw new Error(`declared package file must not be a link: ${path}`);
      const canonicalSource = realpathSync(source);
      if (!pathContained(root, canonicalSource)) throw new Error(`declared package file escapes root: ${path}`);
      const subtree = entry.isDirectory() ? canonicalSource : dirname(canonicalSource);
      copyContainedEntry(source, join(stagedPackage, path), subtree);
    }
    const sourceModules = join(root, "node_modules");
    if (!existsSync(sourceModules)) throw new Error("installed node_modules is required for local bundling");
    copyContainedEntry(sourceModules, join(stagedPackage, "node_modules"), sourceModules);

    const requiredBundledDependencies = bundledDependenciesForLocalPackage(
      rootManifest.dependencies,
      presentRootOptionalDependencies(root, rootManifest),
    );
    const stagedManifest: PackageManifest = {
      ...rootManifest,
      bundleDependencies: requiredBundledDependencies,
    };
    writeFileSync(join(stagedPackage, "package.json"), JSON.stringify(stagedManifest, null, 2) + "\n", { mode: 0o600 });
    const allowedDependencyRoots = collectDependencyPackageRoots(
      stagedPackage,
      stagedPackage,
      stagedPackage,
    );
    const pack = options.run(["npm", "pack", "--json", "--ignore-scripts"], stagedPackage, { ...process.env });
    if (pack.exitCode !== 0) throw new Error(`npm pack failed (${pack.exitCode})`);
    const tarball = parsePackTarball(pack.stdout, stagedManifest, stagedPackage, allowedDependencyRoots);
    assertRootManifestUnchanged(root, rootManifestBytes, "local package pack");

    mkdirSync(validationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    const install = options.run([
      "npm", "install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
      "--package-lock=false", "--cache", cacheRoot, "--prefix", validationRoot, tarball,
    ], stagedPackage, { ...process.env });
    if (install.exitCode !== 0) throw new Error(`offline package validation failed (${install.exitCode})`);
    assertRootManifestUnchanged(root, rootManifestBytes, "offline package validation");
    verifyInstalledPackage(validationRoot, rootManifest, options.run, requiredBundledDependencies);
    assertRootManifestUnchanged(root, rootManifestBytes, "local package preparation");

    return {
      tarball,
      npmCache: cacheRoot,
      rootManifestBytes,
      cleanup: () => {
        let changed: Error | undefined;
        try {
          assertRootManifestUnchanged(root, rootManifestBytes, "local package cleanup");
        } catch (error) {
          changed = error as Error;
        }
        try {
          options.removeTree(stageRoot);
        } catch (cleanupError) {
          if (changed) throwAggregate(changed, cleanupError, "local package cleanup failed after root metadata changed");
          throw cleanupError;
        }
        if (changed) throw changed;
      },
    };
  } catch (primaryError) {
    try {
      options.removeTree(stageRoot);
    } catch (cleanupError) {
      throwAggregate(primaryError, cleanupError, "local package preparation failed and its staging directory could not be removed");
    }
    throw primaryError;
  }
}
