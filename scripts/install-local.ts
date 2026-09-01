import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandInvocation, resolveWindowsCommand } from "../src/lib/win-exec";
import {
  diagnoseService,
  probeServiceInstallation,
  probeWindowsSchedulerTask,
  proxyStillLiveAfterStop,
  launchctlLoadFailed,
  runLaunchctl,
  type ServiceDiagnostic,
  type ServiceInstallationProbe,
} from "../src/service";
import { statusWinswRaw, type WinswStatus } from "../src/lib/winsw";
import {
  assertRootManifestUnchanged,
  defaultLocalPackageStageOptions,
  prepareBundledLocalPackage,
  type PreparedLocalPackage,
} from "./install-local-vendor";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const GUI_FONT_STACK = '--font-ui:"OpenAI Sans", "Noto Sans SC", "Microsoft YaHei UI"';
const GUI_FONT_DECLARATION = /--font-ui:"OpenAI Sans"[^;}]*/g;
const ANY_GUI_FONT_DECLARATION = /--font-ui:[^;}]*/g;

export function patchBuiltGuiFontStack(
  assetsDir = join(root, "gui", "dist", "assets"),
): { files: number; replacements: number } {
  if (!existsSync(assetsDir)) {
    throw new Error("built GUI assets directory not found: gui/dist/assets");
  }
  const assetsStat = lstatSync(assetsDir);
  if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) {
    throw new Error("built GUI assets path must be a regular directory: gui/dist/assets");
  }
  let files = 0;
  let replacements = 0;
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".css")) continue;
    const cssPath = join(assetsDir, entry.name);
    const css = readFileSync(cssPath, "utf8");
    const matches = css.match(GUI_FONT_DECLARATION);
    if (!matches?.length) continue;
    const patched = css.replace(GUI_FONT_DECLARATION, GUI_FONT_STACK);
    writeFileSync(cssPath, patched, "utf8");
    files += 1;
    replacements += matches.length;
  }
  if (files === 0) throw new Error("built GUI CSS contains no --font-ui declaration to patch");
  assertGuiFontStack(assetsDir, "built gui/dist/assets");
  return { files, replacements };
}

export function assertGuiFontStack(assetsDir: string, label = "gui/dist/assets"): void {
  if (!existsSync(assetsDir)) throw new Error(`${label} not found`);
  const assetsStat = lstatSync(assetsDir);
  if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
  let declarations = 0;
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".css")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} contains a non-regular CSS entry`);
    }
    const cssPath = join(assetsDir, entry.name);
    const css = readFileSync(cssPath, "utf8");
    const found = css.match(ANY_GUI_FONT_DECLARATION) ?? [];
    declarations += found.length;
    if (found.some(declaration => declaration !== GUI_FONT_STACK)) {
      throw new Error(`${label} contains a non-canonical --font-ui declaration`);
    }
  }
  if (declarations === 0) throw new Error(`${label} contains no --font-ui declaration`);
}

export function localInstallRestartArgs(serviceWasInstalled: boolean): string[] {
  return serviceWasInstalled ? ["ocx", "service", "repair"] : ["ocx", "start"];
}

export function launchdProxyPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", "com.opencodex.proxy.plist");
}

/** Narrow seams for command execution and launchd plist updates. */
type InstallLocalRunOptions = { allowFailure?: boolean; env?: NodeJS.ProcessEnv };
type InstallLocalRun = (command: string[], options?: InstallLocalRunOptions) => void;
type LaunchdPlistWriteDeps = {
  patch?: (path: string) => void;
  validate?: (path: string) => void;
};

type CapturedCommandResult = { status: number; stdout: string; stderr: string; errorCode?: string };

function decodeCommandOutput(value: Uint8Array | string | undefined): string {
  if (typeof value === "string") return value;
  return value ? new TextDecoder().decode(value) : "";
}

function runCaptured(command: string[], env = process.env): CapturedCommandResult {
  const [executable, ...args] = command;
  const invocation = commandInvocation(executable ?? "", args);
  try {
    const result = Bun.spawnSync([invocation.file, ...invocation.args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env,
      ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return {
      status: result.exitCode,
      stdout: decodeCommandOutput(result.stdout),
      stderr: decodeCommandOutput(result.stderr),
    };
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
    return {
      status: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      ...(errorCode ? { errorCode } : {}),
    };
  }
}

function plistHasProviderDebug(plistPath: string): boolean {
  const keyPath = "EnvironmentVariables.OCX_DEBUG";
  const type = runCaptured(["plutil", "-type", keyPath, plistPath]);
  if (type.status !== 0 || type.stdout.trim().toLowerCase() !== "string") return false;
  const result = runCaptured([
    "plutil",
    "-extract",
    keyPath,
    "raw",
    "-o",
    "-",
    plistPath,
  ]);
  return result.status === 0 && (result.stdout === "1" || result.stdout === "1\n");
}

function patchProviderDebugWithPlutil(plistPath: string): void {
  const keyPath = "EnvironmentVariables.OCX_DEBUG";
  const replace = runCaptured(["plutil", "-replace", keyPath, "-string", "1", plistPath]);
  if (replace.status === 0) return;
  const insert = runCaptured(["plutil", "-insert", keyPath, "-string", "1", plistPath]);
  if (insert.status !== 0) {
    const detail = insert.stderr.trim() || replace.stderr.trim() || `exit ${insert.status}`;
    throw new Error(`could not set OCX_DEBUG in launchd plist: ${detail}`);
  }
}

function validateProviderDebugPlist(plistPath: string): void {
  const result = runCaptured(["plutil", "-lint", plistPath]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`launchd plist validation failed: ${detail}`);
  }
}

/** Atomically make the current macOS launchd plist default to provider debug on. */
export function ensureProviderDebugLaunchdDefault(
  plistPath = launchdProxyPlistPath(),
  deps: LaunchdPlistWriteDeps = {},
): boolean {
  if (process.platform !== "darwin") return false;
  if (!existsSync(plistPath)) throw new Error(`launchd plist not found: ${plistPath}`);
  const stat = lstatSync(plistPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("launchd plist must be a regular file");
  if (plistHasProviderDebug(plistPath)) {
    chmodSync(plistPath, 0o600);
    return false;
  }

  const current = readFileSync(plistPath);
  const temporary = `${plistPath}.ocx.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, current, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    (deps.patch ?? patchProviderDebugWithPlutil)(temporary);
    (deps.validate ?? validateProviderDebugPlist)(temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, plistPath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return true;
}

/** Reload launchd only when install-local changed the service definition. */
export function refreshProviderDebugLaunchd(
  plistPath = launchdProxyPlistPath(),
  deps: LaunchdPlistWriteDeps & { launchctl?: typeof runLaunchctl } = {},
): void {
  if (process.platform !== "darwin") return;
  if (!ensureProviderDebugLaunchdDefault(plistPath, deps)) return;
  const launchctl = deps.launchctl ?? runLaunchctl;
  const unloaded = launchctl(["unload", plistPath]);
  if (!unloaded.ok) {
    throw new Error(`launchctl could not unload ${plistPath}: ${unloaded.stderr || "command failed"}`);
  }
  const loaded = launchctl(["load", "-w", plistPath]);
  if (!loaded.ok || launchctlLoadFailed(loaded.stderr)) {
    throw new Error(`launchctl could not load ${plistPath}: ${loaded.stderr || "command failed"}`);
  }
}

export function localInstallRestartEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return platform === "darwin" ? { ...env, OCX_DEBUG: "1" } : { ...env };
}

export function localInstallAfterReplace(
  serviceWasInstalled: boolean,
  restart: boolean,
  ensure: () => void = () => { ensureProviderDebugLaunchdDefault(); },
  platform: NodeJS.Platform = process.platform,
): void {
  if (!restart && serviceWasInstalled && platform === "darwin") ensure();
}

export function restartLocalInstall(
  serviceWasInstalled: boolean,
  deps: { run?: InstallLocalRun; refresh?: () => void } = {},
  platform: NodeJS.Platform = process.platform,
): void {
  const runCommand = deps.run ?? run;
  runCommand(localInstallRestartArgs(serviceWasInstalled), { env: localInstallRestartEnv(process.env, platform) });
  if (serviceWasInstalled && platform === "darwin") (deps.refresh ?? refreshProviderDebugLaunchd)();
}

type LocalServiceInstallationProbe = Pick<ServiceInstallationProbe, "state" | "detail">;

function probeLocalServiceInstallation(): LocalServiceInstallationProbe {
  if (process.platform !== "win32") return probeServiceInstallation();

  let scheduler: ReturnType<typeof probeWindowsSchedulerTask>;
  try {
    scheduler = probeWindowsSchedulerTask();
  } catch (error) {
    return { state: "unknown", detail: `Task Scheduler: ${error instanceof Error ? error.message : String(error)}` };
  }

  let native: WinswStatus;
  try {
    native = statusWinswRaw();
  } catch (error) {
    return { state: "unknown", detail: `WinSW: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (scheduler.status === "unknown" || native === "unknown") {
    const detail = [
      scheduler.status === "unknown" ? `Task Scheduler: ${scheduler.detail}` : null,
      native === "unknown" ? "WinSW status could not be determined" : null,
    ].filter((part): part is string => Boolean(part)).join("; ");
    return { state: "unknown", detail };
  }
  return {
    state: scheduler.status === "present" || native === "started" || native === "stopped"
      ? "installed"
      : "absent",
  };
}

export function requireKnownServiceInstallation(probe: LocalServiceInstallationProbe): boolean {
  if (probe.state === "unknown") {
    throw new Error(
      `Background service state is unknown; refusing to replace the package.${probe.detail ? ` ${probe.detail}` : ""}`,
    );
  }
  return probe.state === "installed";
}

export function assertNoRunningService(
  diagnostic: Pick<ServiceDiagnostic, "running" | "backend">,
): void {
  // Windows Task Scheduler remains enabled after its current task instance stops;
  // that registration is intentionally preserved for the post-install repair.
  const schedulerRegistrationOnly = diagnostic.backend === "scheduler";
  if (diagnostic.running && !schedulerRegistrationOnly) {
    throw new Error("Background service is still loaded after ocx stop; refusing to replace the package.");
  }
}

export interface LocalInstallLifecycleDeps {
  stop: () => void | Promise<void>;
  verifyStopped: () => void | Promise<void>;
  replace: () => void | Promise<void>;
  restart: () => void | Promise<void>;
  ready: () => void | Promise<void>;
}

export async function runLocalInstallLifecycle(
  restart: boolean,
  deps: LocalInstallLifecycleDeps,
): Promise<void> {
  await deps.stop();
  try {
    await deps.verifyStopped();
  } catch (verifyError) {
    throw verifyError;
  }
  try {
    await deps.replace();
  } catch (replaceError) {
    if (restart) {
      try {
        await deps.restart();
        await deps.ready();
      } catch (restartError) {
        throw new AggregateError(
          [replaceError, restartError],
          "local package replacement failed and the previous proxy mode could not be restored",
        );
      }
    }
    throw replaceError;
  }
  if (!restart) return;
  await deps.restart();
  await deps.ready();
}

export async function runLocalInstallLifecycleWithManifestGuard(
  restart: boolean,
  deps: LocalInstallLifecycleDeps,
  assertManifest: (phase: string) => void,
): Promise<void> {
  assertManifest("local install stop admission");
  await runLocalInstallLifecycle(restart, {
    stop: deps.stop,
    verifyStopped: deps.verifyStopped,
    replace: async () => {
      // The service is already confirmed stopped at this point. Classify this guard as a
      // pre-replacement failure so the base lifecycle restores the previous proxy mode.
      assertManifest("local install stop verification");
      assertManifest("global package replacement admission");
      await deps.replace();
    },
    // Once replacement starts, service recovery wins over source-tree diagnostics.
    // A later completion/cleanup check still reports drift without stranding the proxy.
    restart: deps.restart,
    ready: deps.ready,
  });
  assertManifest("local install lifecycle completion");
}

function run(command: string[], options?: InstallLocalRunOptions): void {
  const [executable, ...args] = command;
  const invocation = commandInvocation(executable ?? "", args);
  const result = Bun.spawnSync([invocation.file, ...invocation.args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: options?.env ?? process.env,
    ...(invocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (!options?.allowFailure && result.exitCode !== 0) {
    throw new Error(`command failed (${result.exitCode}): ${command.join(" ")}`);
  }
}

export function validatedPackedTarball(packageRoot: string, packJson: string): string {
  let rows: unknown;
  try {
    rows = JSON.parse(packJson);
  } catch {
    throw new Error("npm pack did not produce JSON output");
  }
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw new Error("npm pack JSON must contain exactly one package");
  }
  const filename = (rows[0] as { filename?: unknown }).filename;
  if (typeof filename !== "string" || !/^[^/\\]+\.tgz$/.test(filename)) {
    throw new Error("npm pack returned an invalid tarball filename");
  }
  const rootPath = resolve(packageRoot);
  const tarball = resolve(rootPath, filename);
  if (relative(rootPath, tarball) !== filename) throw new Error("tarball path escapes package root");
  const stat = lstatSync(tarball);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packed tarball must be a regular file");
  return tarball;
}

const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SAFE_PACKAGE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const MAX_PACKAGE_NAME_CHARS = 214;

function packageIdentitySafe(name: string, version: string): boolean {
  return name.length <= MAX_PACKAGE_NAME_CHARS
    && SAFE_PACKAGE_NAME.test(name)
    && SAFE_PACKAGE_VERSION.test(version);
}

export function parsePackageIdentity(source: string): { name: string; version: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("invalid package.json identity");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid package.json identity");
  }
  const pkg = parsed as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string"
    || !packageIdentitySafe(pkg.name, pkg.version)) {
    throw new Error("invalid package.json identity");
  }
  return { name: pkg.name, version: pkg.version };
}

function pathIsContained(rootPath: string, childPath: string): boolean {
  const child = relative(rootPath, childPath);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

type ValidatedPackageRoot = { root: string; bin: string };

function validatePackageRoot(
  packageRoot: string,
  name: string,
  version: string,
): ValidatedPackageRoot | null {
  try {
    const canonicalRoot = realpathSync(packageRoot);
    const rootStat = lstatSync(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const packageJson = join(canonicalRoot, "package.json");
    const stat = lstatSync(packageJson);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as {
      name?: unknown;
      version?: unknown;
      bin?: unknown;
    };
    if (pkg.name !== name || pkg.version !== version) return null;
    const packageCommandName = name.startsWith("@") ? name.split("/")[1] : name;
    const bin = typeof pkg.bin === "string"
      ? packageCommandName === "ocx" ? pkg.bin : undefined
      : pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin)
        && Object.prototype.hasOwnProperty.call(pkg.bin, "ocx")
        ? (pkg.bin as Record<string, unknown>).ocx
        : undefined;
    if (typeof bin !== "string" || !bin || isAbsolute(bin)) return null;
    const binPath = resolve(canonicalRoot, bin);
    if (!pathIsContained(canonicalRoot, binPath)) return null;
    const canonicalBin = realpathSync(binPath);
    if (!pathIsContained(canonicalRoot, canonicalBin)) return null;
    const binStat = lstatSync(canonicalBin);
    if (!binStat.isFile() || binStat.isSymbolicLink()) return null;
    return { root: canonicalRoot, bin: canonicalBin };
  } catch {
    return null;
  }
}

function packageRootFromExecutable(executable: string, name: string, version: string): string | null {
  const trimmed = executable.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || !isAbsolute(trimmed)) return null;
  try {
    const wrapperName = basename(trimmed).toLowerCase();
    if (wrapperName !== "ocx" && wrapperName !== "ocx.cmd" && wrapperName !== "ocx.exe") return null;
    const realExecutable = realpathSync(trimmed);
    const executableStat = lstatSync(realExecutable);
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) return null;
    const directPackageRoot = resolve(dirname(realExecutable), "..");
    const direct = validatePackageRoot(directPackageRoot, name, version);
    if (direct?.bin === realExecutable) return direct.root;

    const imageRoot = realpathSync(resolve(dirname(trimmed), ".."));
    const imageBinRoot = realpathSync(join(imageRoot, "bin"));
    if (!pathIsContained(imageRoot, imageBinRoot)) return null;
    if (!pathIsContained(imageBinRoot, realExecutable)) return null;
    const imageLibRoot = realpathSync(join(imageRoot, "lib"));
    if (!pathIsContained(imageRoot, imageLibRoot)) return null;
    const nodeModulesRoot = realpathSync(join(imageLibRoot, "node_modules"));
    if (!pathIsContained(imageLibRoot, nodeModulesRoot)
      || !pathIsContained(imageRoot, nodeModulesRoot)) return null;
    const voltaPackageRoot = realpathSync(resolve(nodeModulesRoot, ...name.split("/")));
    if (!pathIsContained(nodeModulesRoot, voltaPackageRoot)
      || !pathIsContained(imageRoot, voltaPackageRoot)) return null;
    return validatePackageRoot(voltaPackageRoot, name, version)?.root ?? null;
  } catch {
    return null;
  }
}

const MAX_WINDOWS_NPM_SHIM_BYTES = 16 * 1024;

function expectedWindowsNpmShim(packageBin: string, npmPrefix: string): string | null {
  if (!pathIsContained(npmPrefix, packageBin)) return null;
  const target = relative(npmPrefix, packageBin).replace(/[\\/]/g, "\\");
  return [
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
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\${target}\" %*`,
    "",
  ].join("\n");
}

function executableSelectsPackage(
  executable: string | null,
  packageBin: string,
  npmGlobalRoot: string,
  platform: NodeJS.Platform,
): boolean {
  if (typeof executable !== "string") return false;
  const trimmed = executable.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || !isAbsolute(trimmed)) return false;
  try {
    const canonicalExecutable = realpathSync(trimmed);
    const stat = lstatSync(canonicalExecutable);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (canonicalExecutable === packageBin) return true;
    if (platform !== "win32") return false;

    const launcherStat = lstatSync(trimmed);
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink()
      || launcherStat.size > MAX_WINDOWS_NPM_SHIM_BYTES
      || basename(canonicalExecutable).toLowerCase() !== "ocx.cmd") return false;
    const npmPrefix = realpathSync(dirname(npmGlobalRoot));
    if (dirname(canonicalExecutable).toLowerCase() !== npmPrefix.toLowerCase()) return false;
    const expected = expectedWindowsNpmShim(packageBin, npmPrefix);
    if (!expected) return false;
    const source = readFileSync(canonicalExecutable, "utf8");
    if (source.includes("\0")) return false;
    return source.replace(/\r\n/g, "\n") === expected;
  } catch {
    return false;
  }
}

function selectedExecutablePath(command: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return Bun.which(command);
  const resolved = resolveWindowsCommand(command);
  return isAbsolute(resolved) ? resolved : null;
}

type InstalledPackageRootOptions = {
  platform?: NodeJS.Platform;
  findExecutable?: (command: string) => string | null;
};

export function resolveInstalledPackageRoot(
  name: string,
  version: string,
  runCommand: (command: string[]) => CapturedCommandResult = runCaptured,
  options: InstalledPackageRootOptions = {},
): string {
  if (!packageIdentitySafe(name, version)) {
    throw new Error("invalid installed package identity");
  }
  const platform = options.platform ?? process.platform;
  const findExecutable = options.findExecutable ?? (command => selectedExecutablePath(command, platform));
  const volta = runCommand(["volta", "which", "ocx"]);
  const npmSelectionProofRequired = volta.status === 0;
  if (volta.status === 0) {
    const packageRoot = packageRootFromExecutable(volta.stdout, name, version);
    if (packageRoot) return packageRoot;
  } else if (volta.status !== -1 || volta.errorCode !== "ENOENT") {
    throw new Error(`could not locate the installed package matching ${name}@${version}`);
  }

  const npmRoot = runCommand(["npm", "root", "-g"]);
  const globalRootOutput = npmRoot.stdout.trim();
  if (npmRoot.status === 0
    && globalRootOutput.length > 0
    && !/[\r\n]/.test(globalRootOutput)
    && isAbsolute(globalRootOutput)) {
    try {
      const globalRoot = realpathSync(globalRootOutput);
      const packageRoot = realpathSync(resolve(globalRoot, ...name.split("/")));
      if (pathIsContained(globalRoot, packageRoot)) {
        const validated = validatePackageRoot(packageRoot, name, version);
        if (validated
          && (!npmSelectionProofRequired
            || executableSelectsPackage(findExecutable("ocx"), validated.bin, globalRoot, platform))) {
          return validated.root;
        }
      }
    } catch {
      // The fixed failure below deliberately omits private paths and command diagnostics.
    }
  }

  throw new Error(`could not locate the installed package matching ${name}@${version}`);
}

export function localGlobalInstallCommand(
  prepared: Pick<PreparedLocalPackage, "tarball" | "npmCache">,
): string[] {
  return [
    "npm", "install", "-g", "--ignore-scripts", "--offline", "--no-audit", "--no-fund",
    "--package-lock=false", "--cache", prepared.npmCache, prepared.tarball,
  ];
}

export type LocalInstallSourcePreparationDeps = Readonly<{
  readManifestBytes(): string;
  build(): void;
  patch(): { files: number; replacements: number };
  prepare(expectedManifestBytes: string): PreparedLocalPackage;
}>;

export function prepareLocalInstallSource(
  deps: LocalInstallSourcePreparationDeps,
): Readonly<{
  rootManifestBytes: string;
  identity: { name: string; version: string };
  fontPatch: { files: number; replacements: number };
  preparedPackage: PreparedLocalPackage;
}> {
  const rootManifestBytes = deps.readManifestBytes();
  const identity = parsePackageIdentity(rootManifestBytes);
  deps.build();
  if (deps.readManifestBytes() !== rootManifestBytes) {
    throw new Error("root package.json changed during source preparation");
  }
  const fontPatch = deps.patch();
  if (deps.readManifestBytes() !== rootManifestBytes) {
    throw new Error("root package.json changed during built GUI patching");
  }
  const preparedPackage = deps.prepare(rootManifestBytes);
  let postPrepareError: unknown;
  try {
    if (preparedPackage.rootManifestBytes !== rootManifestBytes
      || deps.readManifestBytes() !== rootManifestBytes) {
      throw new Error("root package.json changed while preparing the local package");
    }
  } catch (error) {
    postPrepareError = error;
  }
  if (postPrepareError !== undefined) {
    try {
      preparedPackage.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [postPrepareError, cleanupError],
        "local source preparation failed and its staged package could not be removed",
      );
    }
    throw postPrepareError;
  }
  return { rootManifestBytes, identity, fontPatch, preparedPackage };
}

export function finalizeLocalInstallCleanup(
  preparedPackage: Pick<PreparedLocalPackage, "cleanup">,
  lifecycleError?: unknown,
): void {
  let cleanupError: unknown;
  try {
    preparedPackage.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (lifecycleError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [lifecycleError, cleanupError],
      "local install failed and its temporary tarball could not be removed",
    );
  }
  if (lifecycleError !== undefined) throw lifecycleError;
  if (cleanupError !== undefined) throw cleanupError;
}

export async function runLocalInstaller(args = process.argv.slice(2)): Promise<number> {
  const restart = args.length === 0 ? true : args.length === 1 && args[0] === "--no-restart" ? false : null;
  if (restart === null) {
    console.error("usage: bun run install:local [-- --no-restart]");
    return 2;
  }

  console.log("==> Building GUI...");
  const source = prepareLocalInstallSource({
    readManifestBytes: () => readFileSync(join(root, "package.json"), "utf8"),
    build: () => run(["bun", "run", "build:gui"]),
    patch: () => {
      console.log("==> Patching built GUI font stack...");
      return patchBuiltGuiFontStack();
    },
    prepare: expectedManifestBytes => {
      console.log("==> Packing immutable local snapshot...");
      return prepareBundledLocalPackage(
        root,
        defaultLocalPackageStageOptions,
        expectedManifestBytes,
      );
    },
  });
  const { name, version } = source.identity;
  const { fontPatch, preparedPackage, rootManifestBytes } = source;
  console.log(`    patched ${fontPatch.replacements} declaration(s) across ${fontPatch.files} CSS file(s)`);
  const assertSourceManifest = (phase: string): void => {
    assertRootManifestUnchanged(root, rootManifestBytes, phase);
  };

  let lifecycleError: unknown;
  try {
    const serviceProbe = probeLocalServiceInstallation();
    const serviceWasInstalled = requireKnownServiceInstallation(serviceProbe);
    await runLocalInstallLifecycleWithManifestGuard(restart, {
      stop: () => {
        console.log("==> Stopping current proxy...");
        run(["ocx", "stop"]);
      },
      verifyStopped: async () => {
        const afterStopProbe = probeLocalServiceInstallation();
        const serviceStillInstalled = requireKnownServiceInstallation(afterStopProbe);
        if (serviceStillInstalled !== serviceWasInstalled) {
          throw new Error("Background service installation state changed during ocx stop; refusing to replace the package.");
        }
        if (serviceWasInstalled) {
          const survivor = await proxyStillLiveAfterStop();
          if (survivor) {
            throw new Error(`Proxy is still running on port ${survivor.port} after ocx stop; refusing to replace the package.`);
          }
        }
        const serviceDiagnostic = diagnoseService();
        assertNoRunningService(serviceDiagnostic);
      },
      replace: () => {
        console.log("==> Replacing global package...");
        run(["npm", "uninstall", "-g", name], { allowFailure: true });
        // Every dependency ships inside the tarball (bundleDependencies), so
        // lifecycle scripts can only repeat work the pack step already did —
        // the bun postinstall download in particular. Skip them; the launcher
        // keeps its install.js fallback for a genuinely missing binary.
        run(localGlobalInstallCommand(preparedPackage));
        run(["ocx", "--version"]);
        assertGuiFontStack(
          join(resolveInstalledPackageRoot(name, version), "gui", "dist", "assets"),
          "installed gui/dist/assets",
        );
        console.log("    installed GUI font stack verified");
        localInstallAfterReplace(serviceWasInstalled, restart);
      },
      restart: () => {
        console.log(serviceWasInstalled
          ? "==> Refreshing background service with packaged proxy..."
          : "==> Starting packaged proxy...");
        restartLocalInstall(serviceWasInstalled);
      },
      ready: () => {
        run(["ocx", "ready", "--json", "--wait", "--timeout", "30"]);
      },
    }, assertSourceManifest);
  } catch (error) {
    lifecycleError = error;
  }
  finalizeLocalInstallCleanup(preparedPackage, lifecycleError);

  console.log("Done. Source edits will not affect this packaged runtime until you run this installer again.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runLocalInstaller(process.argv.slice(2));
}
