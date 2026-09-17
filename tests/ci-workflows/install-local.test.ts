import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  localInstallRestartEnv,
  restartLocalInstall,
  verifyLocalInstallReadiness,
} from "../../scripts/install-local";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local installer debug opt-in handling", () => {
  test("restart environments preserve explicit debug settings on every platform", () => {
    const env = { PATH: "/usr/bin", OCX_DEBUG: "0", OCX_PROVIDER_TEXT_DEBUG: "0" };
    expect(localInstallRestartEnv(env, "darwin")).toEqual(env);
    expect(localInstallRestartEnv({ PATH: "/usr/bin" }, "linux")).toEqual({ PATH: "/usr/bin" });
  });
});

describe("local installer runtime handling", () => {
  test("repairs with the verified package CLI and places its launcher before Volta's PATH injection", () => {
    const events: string[] = [];
    const packageRoot = join(tmpdir(), "ocx-new-package");
    const launcherPath = join(tmpdir(), "ocx-new-image", "bin", "ocx");
    restartLocalInstall(true, {
      run: (command, options) => {
        events.push(`run:${command.join(" ")}:${options?.env?.PATH}`);
      },
    }, {
      command: [join(packageRoot, "bun"), join(packageRoot, "src", "cli", "index.ts")],
      launcherPath,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toStartWith(
      `run:${join(packageRoot, "bun")} ${join(packageRoot, "src", "cli", "index.ts")} service repair:${dirname(launcherPath)}${delimiter}`,
    );
  });

  test("starts the verified package CLI without refreshing launchd when no service was installed", () => {
    const events: string[] = [];
    const packageRoot = join(tmpdir(), "ocx-new-package");
    restartLocalInstall(false, {
      run: command => { events.push(command.join(" ")); },
    }, {
      command: [join(packageRoot, "bun"), join(packageRoot, "src", "cli", "index.ts")],
      launcherPath: join(tmpdir(), "ocx-new-image", "bin", "ocx"),
    });
    expect(events).toEqual([`${join(packageRoot, "bun")} ${join(packageRoot, "src", "cli", "index.ts")} start`]);
  });

  test("rejects a ready old service when its health identity reports a different package version", async () => {
    const packageRoot = join(tmpdir(), "ocx-new-package");
    const runtimeCommand: [string, string] = [join(packageRoot, "bun"), join(packageRoot, "src", "cli", "index.ts")];
    await expect(verifyLocalInstallReadiness({
      command: runtimeCommand,
      launcherPath: join(tmpdir(), "ocx-new-image", "bin", "ocx"),
    }, "2.46.0-ben.1", {
      run: invocation => {
        expect(invocation).toEqual([
          ...runtimeCommand, "ready", "--json", "--wait", "--timeout", "30",
        ]);
        return { status: 0, stdout: JSON.stringify({ status: "ready", pid: 89807, port: 10100 }), stderr: "" };
      },
      probe: async () => {
        return { pid: 89807, port: 10100, hostname: "127.0.0.1", source: "config", version: "2.40.0-ben.2" };
      },
    })).rejects.toThrow("expected 2.46.0-ben.1");
  });

  test("requires health identity to echo the ready PID before accepting the expected version", async () => {
    const packageRoot = join(tmpdir(), "ocx-new-package");
    await expect(verifyLocalInstallReadiness({
      command: [join(packageRoot, "bun"), join(packageRoot, "src", "cli", "index.ts")],
      launcherPath: join(tmpdir(), "ocx-new-image", "bin", "ocx"),
    }, "2.46.0-ben.1", {
      run: () => ({ status: 0, stdout: JSON.stringify({ status: "ready", pid: 89807, port: 10100 }), stderr: "" }),
      probe: async () => ({ pid: 89808, port: 10100, hostname: "127.0.0.1", source: "config", version: "2.46.0-ben.1" }),
    })).rejects.toThrow("expected 2.46.0-ben.1");
  });

  test("accepts the expected version only when the discovered live proxy matches ready PID and port", async () => {
    const packageRoot = join(tmpdir(), "ocx-new-package");
    await expect(verifyLocalInstallReadiness({
      command: [join(packageRoot, "bun"), join(packageRoot, "src", "cli", "index.ts")],
      launcherPath: join(tmpdir(), "ocx-new-image", "bin", "ocx"),
    }, "2.46.0-ben.1", {
      run: () => ({ status: 0, stdout: JSON.stringify({ status: "ready", pid: 89807, port: 10100 }), stderr: "" }),
      probe: async () => ({ pid: 89807, port: 10100, hostname: "127.0.0.1", source: "config", version: "2.46.0-ben.1" }),
    })).resolves.toBeUndefined();
  });


});
