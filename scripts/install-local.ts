import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandInvocation } from "../src/lib/win-exec";
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
import { runWithBundledDependencies } from "./install-local-vendor";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

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

type CapturedCommandResult = { status: number; stdout: string; stderr: string };

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
    return {
      status: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
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
  await deps.verifyStopped();
  await deps.replace();
  if (!restart) return;
  await deps.restart();
  await deps.ready();
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

function packageIdentity(): { name: string } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown };
  if (typeof pkg.name !== "string" || pkg.name.length === 0) throw new Error("package.json name is required");
  return { name: pkg.name };
}

export async function runLocalInstaller(args = process.argv.slice(2)): Promise<number> {
  const restart = args.length === 0 ? true : args.length === 1 && args[0] === "--no-restart" ? false : null;
  if (restart === null) {
    console.error("usage: bun run install:local [-- --no-restart]");
    return 2;
  }

  const { name } = packageIdentity();
  console.log("==> Building GUI...");
  run(["bun", "run", "build:gui"]);

  console.log("==> Packing immutable local snapshot...");
  const tarball = runWithBundledDependencies(join(root, "package.json"), () => {
    const packInvocation = commandInvocation("npm", ["pack", "--json"]);
    const pack = Bun.spawnSync([packInvocation.file, ...packInvocation.args], {
      cwd: root,
      stdout: "pipe",
      stderr: "inherit",
      ...(packInvocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    if (pack.exitCode !== 0) throw new Error(`npm pack failed (${pack.exitCode})`);
    return validatedPackedTarball(root, new TextDecoder().decode(pack.stdout));
  });

  try {
    const serviceProbe = probeLocalServiceInstallation();
    const serviceWasInstalled = requireKnownServiceInstallation(serviceProbe);
    await runLocalInstallLifecycle(restart, {
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
        run(["npm", "install", "-g", "--ignore-scripts", tarball]);
        run(["ocx", "--version"]);
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
    });
  } finally {
    rmSync(tarball, { force: true });
  }

  console.log("Done. Source edits will not affect this packaged runtime until you run this installer again.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runLocalInstaller(process.argv.slice(2));
}
