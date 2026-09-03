import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePackageModes } from "../scripts/prepare-package";
import { validatedPackedTarball } from "../scripts/install-local";

// Windows CI runners spawn Node/Bun child processes slowly ("Slow filesystem detected");
// the package-main import test measured 9.4s there vs bun's 5s default. Same remedy as
// codex-history-provider / cursor-mcp-stdio.
setDefaultTimeout(30_000);

const root = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(root);

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function removeModeFixture(path: string): void {
  try { chmodSync(path, 0o700); } catch { /* best-effort cleanup */ }
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

function systemCommandPath(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`required test command is unavailable: ${command}`);
  }
  return result.stdout.trim();
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, { encoding: "utf8", mode: 0o755 });
}

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("fork install-local lifecycle", () => {
test("local installer preserves an installed service and refuses a loaded manager after stop", async () => {
  const installer = await readText("scripts/install-local.ts");
  expect(installer).toContain("const serviceProbe = probeLocalServiceInstallation();");
  expect(installer).toContain("requireKnownServiceInstallation(serviceProbe);");
  expect(installer).toContain("const serviceDiagnostic = diagnoseService();");
  expect(installer).toContain("assertNoRunningService(serviceDiagnostic);");
  expect(installer).toContain("[\"ocx\", \"service\", \"repair\"]");
  expect(installer).toContain("Background service is still loaded after ocx stop");
});

test("local installer chooses foreground start only when no service was installed", async () => {
  const module = await import("../scripts/install-local");
  const choose = (module as unknown as {
    localInstallRestartArgs?: (serviceWasInstalled: boolean) => string[];
  }).localInstallRestartArgs;
  expect(typeof choose).toBe("function");
  if (!choose) return;
  expect(choose(false)).toEqual(["ocx", "start"]);
  expect(choose(true)).toEqual(["ocx", "service", "repair"]);
});

test("local installer refuses to replace the package while a service manager is loaded", async () => {
  const module = await import("../scripts/install-local");
  const assertStopped = (module as unknown as {
    assertNoRunningService?: (diagnostic: { running: boolean; backend: string | null }) => void;
  }).assertNoRunningService;
  expect(typeof assertStopped).toBe("function");
  if (!assertStopped) return;
  expect(() => assertStopped({ running: true, backend: "launchd" })).toThrow(/Background service is still loaded after ocx stop/);
  expect(() => assertStopped({ running: false, backend: "launchd" })).not.toThrow();
  expect(() => assertStopped({ running: true, backend: "scheduler" })).not.toThrow();
  expect(() => assertStopped({ running: true, backend: "native" })).toThrow(/Background service is still loaded after ocx stop/);
});

test("local installer fails closed when service installation state is unknown", async () => {
  const module = await import("../scripts/install-local");
  const requireKnown = (module as unknown as {
    requireKnownServiceInstallation?: (probe: { state: "installed" | "absent" | "unknown"; detail?: string }) => boolean;
  }).requireKnownServiceInstallation;
  expect(typeof requireKnown).toBe("function");
  if (!requireKnown) return;
  expect(requireKnown({ state: "installed" })).toBe(true);
  expect(requireKnown({ state: "absent" })).toBe(false);
  expect(() => requireKnown({ state: "unknown", detail: "scheduler query failed" }))
    .toThrow(/Background service state is unknown/);
});

test("local installer stops and verifies before replacement, and aborts replacement on stop failure", async () => {
  const module = await import("../scripts/install-local");
  const runLifecycle = (module as unknown as {
    runLocalInstallLifecycle?: (restart: boolean, deps: {
      stop: () => void | Promise<void>;
      verifyStopped: () => void | Promise<void>;
      replace: () => void | Promise<void>;
      restart?: () => void | Promise<void>;
      ready?: () => void | Promise<void>;
    }) => Promise<void>;
  }).runLocalInstallLifecycle;
  expect(typeof runLifecycle).toBe("function");
  if (!runLifecycle) return;

  const events: string[] = [];
  await runLifecycle(true, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  });
  expect(events).toEqual(["stop", "verify", "replace", "restart", "ready"]);

  events.length = 0;
  await expect(runLifecycle(true, {
    stop: () => { events.push("stop"); throw new Error("stop failed"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  })).rejects.toThrow("stop failed");
  expect(events).toEqual(["stop"]);

  events.length = 0;
  await expect(runLifecycle(true, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); throw new Error("service still loaded"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  })).rejects.toThrow("service still loaded");
  expect(events).toEqual(["stop", "verify"]);

  events.length = 0;
  await runLifecycle(false, {
    stop: () => { events.push("stop"); },
    verifyStopped: () => { events.push("verify"); },
    replace: () => { events.push("replace"); },
    restart: () => { events.push("restart"); },
    ready: () => { events.push("ready"); },
  });
  expect(events).toEqual(["stop", "verify", "replace"]);
});


  test("local installer accepts only a root-local regular tgz from npm JSON", () => {
      const fixture = mkdtempSync(join(tmpdir(), "ocx-local-pack-"));
      const tarball = join(fixture, "fork.tgz");
      try {
        writeFileSync(tarball, "fixture");
        expect(validatedPackedTarball(fixture, JSON.stringify([{ filename: "fork.tgz" }]))).toBe(tarball);
        expect(() => validatedPackedTarball(fixture, JSON.stringify([{ filename: "../outside.tgz" }]))).toThrow();
        expect(() => validatedPackedTarball(fixture, JSON.stringify([{ filename: "not-a-tarball.txt" }]))).toThrow();
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
  });

});
