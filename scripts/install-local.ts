import { lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandInvocation } from "../src/lib/win-exec";
import {
  diagnoseService,
  probeServiceInstallation,
  probeWindowsSchedulerTask,
  proxyStillLiveAfterStop,
  type ServiceDiagnostic,
  type ServiceInstallationProbe,
} from "../src/service";
import { statusWinswRaw, type WinswStatus } from "../src/lib/winsw";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export function localInstallRestartArgs(serviceWasInstalled: boolean): string[] {
  return serviceWasInstalled ? ["ocx", "service", "repair"] : ["ocx", "start"];
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

function run(command: string[], options?: { allowFailure?: boolean }): void {
  const [executable, ...args] = command;
  const invocation = commandInvocation(executable ?? "", args);
  const result = Bun.spawnSync([invocation.file, ...invocation.args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
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
  const packInvocation = commandInvocation("npm", ["pack", "--json"]);
  const pack = Bun.spawnSync([packInvocation.file, ...packInvocation.args], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
    ...(packInvocation.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (pack.exitCode !== 0) throw new Error(`npm pack failed (${pack.exitCode})`);
  const tarball = validatedPackedTarball(root, new TextDecoder().decode(pack.stdout));

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
        run(["npm", "install", "-g", tarball]);
        run(["ocx", "--version"]);
      },
      restart: () => {
        console.log(serviceWasInstalled
          ? "==> Refreshing background service with packaged proxy..."
          : "==> Starting packaged proxy...");
        run(localInstallRestartArgs(serviceWasInstalled));
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
