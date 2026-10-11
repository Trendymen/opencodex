import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createIsolatedTestEnvironment } from "../../scripts/test";
import { pinTestNodePath } from "../../scripts/lib/test-runner-node";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test.skipIf(process.platform === "win32").each(["delay", "ignore-term", "overflow"] as const)(
  "a real %s Node probe keeps the parent timer running and cleans its child",
  outcome => {
    const root = mkdtempSync(join(tmpdir(), "ocx-node-async-probe-"));
    const bin = join(root, "bin");
    const pidFile = join(root, "pid.json");
    const driver = join(root, "driver.ts");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));
${outcome === "delay" ? "" : 'process.on("SIGTERM", () => {});'}
${outcome === "overflow" ? 'process.stdout.write("PRIVATE_OVERFLOW_PAYLOAD".repeat(10000));' : ""}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    writeFileSync(driver, `import { getTestRunnerNodeDirectory } from ${JSON.stringify(repoPath("scripts", "lib", "test-runner-node.ts"))};
let ticks = 0; const timer = setInterval(() => { ticks++; }, 10); const started = Date.now(); let message = "";
try { await getTestRunnerNodeDirectory({ ...process.env, PATH: ${JSON.stringify(bin)} }, ${JSON.stringify(join(root, "sandbox"))}); }
catch (error) { message = error.message; }
clearInterval(timer); console.log(JSON.stringify({ ticks, elapsed: Date.now() - started, message }));
`);
    let pid: number | undefined;
    try {
      const child = spawnSync(process.execPath, [driver], {
        cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        encoding: "utf8", timeout: 3_500, killSignal: "SIGKILL",
      });
      if (existsSync(pidFile)) pid = JSON.parse(readFileSync(pidFile, "utf8"));
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.ticks).toBeGreaterThan(0);
      expect(result.elapsed).toBeLessThan(outcome === "overflow" ? 1_000 : 2_600);
      expect(result.message).toContain(outcome === "overflow" ? "source:ENOBUFS=1" : "source:ETIMEDOUT=1");
      expect(result.message).not.toContain("PRIVATE_OVERFLOW_PAYLOAD");
      let alive = false;
      try { process.kill(pid!, 0); alive = true; } catch {}
      expect(alive).toBe(false);
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      removeTreeWithRetry(root);
    }
  }, { timeout: 5_000 },
);

test.each(["pending", "rejected", "unreaped"] as const)(
  "an exited probe with an open pipe bounds %s reader cancellation",
  cancellation => {
    const root = mkdtempSync(join(tmpdir(), "ocx-node-open-pipe-"));
    const driver = join(root, "driver.ts");
    writeFileSync(driver, `import { spyOn } from "bun:test";
const { getTestRunnerNodeDirectory } = await import(${JSON.stringify(repoPath("scripts", "lib", "test-runner-node.ts"))});
let cancelled = false; let killed = false; let unreferenced = false;
const stdout = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("/private/fixture/node\\n22.0.0\\n")); },
  cancel() { cancelled = true; ${cancellation === "pending" ? "return new Promise(() => {});" : 'return Promise.reject(new Error("PRIVATE_CANCEL_MESSAGE"));'} } });
spyOn(Bun, "spawn").mockReturnValue({ pid: 0, stdout, exited: ${cancellation === "unreaped" ? "new Promise(() => {})" : "Promise.resolve(0)"}, exitCode: ${cancellation === "unreaped" ? "null" : "0"}, kill() { killed = true; }, unref() { unreferenced = true; } });
let message = ""; const started = Date.now();
try { await getTestRunnerNodeDirectory({ PATH: "/private/fixture" }, "/private/sandbox"); } catch (error) { message = error.message; }
console.log(JSON.stringify({ cancelled, killed, unreferenced, elapsed: Date.now() - started, message }));
`);
    try {
      const child = spawnSync(process.execPath, [driver], {
        cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL",
      });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.cancelled).toBe(true);
      expect(result.killed).toBe(true);
      if (cancellation === "unreaped") expect(result.unreferenced).toBe(true);
      expect(result.elapsed).toBeLessThan(2_600);
      expect(result.message).toContain("source:ETIMEDOUT=1");
      expect(result.message).not.toMatch(/PRIVATE_CANCEL_MESSAGE|\/private\//);
    } finally { removeTreeWithRetry(root); }
  }, { timeout: 4_000 },
);

test.skipIf(process.platform === "win32")("a sandbox deadline cleans the probe and advances to the next genuine Node", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-node-sandbox-deadline-"));
  const driver = join(root, "driver.ts");
  const pidFile = join(root, "pid.json");
  const sandbox = join(root, "sandbox");
  const directories = [join(root, "first"), join(root, "second")];
  for (const [index, directory] of directories.entries()) {
    mkdirSync(directory);
    const binary = join(directory, "node");
    writeFileSync(binary, `#!${process.execPath}
${index === 0 ? `import {writeFileSync} from "node:fs";
if (process.env.HOME === ${JSON.stringify(sandbox)}) { writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, at: Date.now() })); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else` : ""} console.log(${JSON.stringify(binary)} + "\\n22.0.0");`, { mode: 0o755 });
  }
  writeFileSync(driver, `import {getTestRunnerNodeDirectory} from ${JSON.stringify(repoPath("scripts", "lib", "test-runner-node.ts"))}; import {readFileSync, existsSync} from "node:fs";
let ticks = 0; let deadAt; const timer = setInterval(() => { ticks++; if (!deadAt && existsSync(${JSON.stringify(pidFile)})) {
  try { const info = JSON.parse(readFileSync(${JSON.stringify(pidFile)}, "utf8")); try { process.kill(info.pid, 0); } catch { deadAt = Date.now(); } } catch {}
} }, 10); const started = Date.now();
const directory = await getTestRunnerNodeDirectory({ ...process.env, PATH: ${JSON.stringify(directories.join(delimiter))} }, ${JSON.stringify(sandbox)});
clearInterval(timer); const info = JSON.parse(readFileSync(${JSON.stringify(pidFile)}, "utf8"));
console.log(JSON.stringify({ directory, ticks, elapsed: Date.now() - started, childLifetime: (deadAt ?? Date.now()) - info.at }));`);
  let pid: number | undefined;
  try {
    const child = spawnSync(process.execPath, [driver], { cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, encoding: "utf8", timeout: 3_500, killSignal: "SIGKILL" });
    if (existsSync(pidFile)) pid = JSON.parse(readFileSync(pidFile, "utf8")).pid;
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.directory).toBe(directories[1]);
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.elapsed).toBeLessThan(5_300);
    expect(result.childLifetime).toBeLessThan(2_300);
    let alive = false; try { process.kill(pid!, 0); alive = true; } catch {}
    expect(alive).toBe(false);
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    removeTreeWithRetry(root);
  }
}, { timeout: 5_000 });

test.skipIf(process.platform === "win32")("successive unresponsive candidates share one five-second budget", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-node-total-deadline-"));
  const directories = [0, 1, 2].map(index => join(root, String(index)));
  const pids = join(root, "pids.jsonl");
  const driver = join(root, "driver.ts");
  for (const directory of directories) {
    mkdirSync(directory);
    writeFileSync(join(directory, "node"), `#!${process.execPath}
import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(pids)}, JSON.stringify(process.pid) + "\\n");
process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`, { mode: 0o755 });
  }
  writeFileSync(driver, `import {getTestRunnerNodeDirectory} from ${JSON.stringify(repoPath("scripts", "lib", "test-runner-node.ts"))};
const started = Date.now(); let message = "";
try { await getTestRunnerNodeDirectory({ ...process.env, PATH: ${JSON.stringify(directories.join(delimiter))} }, ${JSON.stringify(join(root, "sandbox"))}); } catch(error) { message = error.message; }
console.log(JSON.stringify({message, elapsed: Date.now() - started}));`);
  let owned: number[] = [];
  try {
    const child = spawnSync(process.execPath, [driver], { cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, encoding: "utf8", timeout: 6_500, killSignal: "SIGKILL" });
    if (existsSync(pids)) owned = readFileSync(pids, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.message).toContain("source:ETIMEDOUT=3");
    expect(result.message).toContain("budgetExhausted=true");
    expect(result.elapsed).toBeGreaterThan(4_800);
    expect(result.elapsed).toBeLessThan(5_300);
    expect(owned).toHaveLength(3);
    for (const pid of owned) { let alive = false; try { process.kill(pid, 0); alive = true; } catch {} expect(alive).toBe(false); }
  } finally {
    for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch {} }
    removeTreeWithRetry(root);
  }
}, { timeout: 7_000 });

function createHomeDependentNodeShimFixture(): {
  fixture: string;
  shimDir: string;
  nodeDir: string;
  hostHome: string;
} {
  const fixture = mkdtempSync(join(tmpdir(), "ocx-test-node-entry-"));
  const shimDir = join(fixture, "shim");
  const nodeDir = join(fixture, "direct");
  const hostHome = join(fixture, "host-home");
  mkdirSync(shimDir);
  mkdirSync(nodeDir);
  mkdirSync(hostHome);
  writeFileSync(join(nodeDir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then printf '%s\\n22.0.0\\n' "$0"; exit 0; fi
printf 'direct-node\\n'
`, { mode: 0o755 });
  writeFileSync(join(shimDir, "node"), `#!/bin/sh
if [ "$HOME" != "$NODE_FIXTURE_HOME" ]; then exit 87; fi
exec "$NODE_DIRECT_BIN" "$@"
`, { mode: 0o755 });
  return { fixture, shimDir, nodeDir, hostHome };
}

describe("test runner isolation", () => {
  test.skipIf(process.platform === "win32").each(["bare", "wrapped"] as const)(
    "%s test entry keeps Node callable after HOME isolation",
    entry => {
      const { fixture, shimDir, nodeDir, hostHome } = createHomeDependentNodeShimFixture();
      const testFile = join(fixture, "node-entry.test.ts");
      writeFileSync(testFile, `import { expect, test } from "bun:test";
test("Node child", () => {
  const child = Bun.spawnSync(["node", "-e", "ignored"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("direct-node\\n");
});
`);
      const driver = join(fixture, "wrapper.ts");
      writeFileSync(driver, `import { runTestLane } from ${JSON.stringify(repoPath("scripts", "test.ts"))};
const result = await runTestLane(
  { label: "node fixture", args: ["--parallel=1", process.env.NODE_FIXTURE_TEST!], timeoutMs: 15_000 },
  "node-fixture-" + process.pid, undefined, false, undefined, process.execPath,
);
process.exitCode = result.exitCode;
`);
      try {
        const command = entry === "bare"
          ? [process.execPath, "test", "--parallel=1", testFile]
          : [process.execPath, driver];
        const result = Bun.spawnSync(command, {
          cwd: repoRoot(),
          env: {
            ...process.env,
            HOME: hostHome,
            USERPROFILE: hostHome,
            OCX_REAL_HOME: hostHome,
            OCX_TEST_NO_QUEUE: "1",
            PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
            NODE_FIXTURE_HOME: hostHome,
            NODE_DIRECT_BIN: join(nodeDir, "node"),
            NODE_FIXTURE_TEST: testFile,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr.toString()).toContain("1 pass");
      } finally {
        removeTreeWithRetry(fixture);
      }
    },
    { timeout: 25_000 },
  );

  test.skipIf(process.platform === "win32")("resolves a HOME-dependent Node shim to a cwd-independent binary", async () => {
    const { fixture, shimDir, nodeDir, hostHome } = createHomeDependentNodeShimFixture();
    const sourceEnv = {
      ...process.env,
      HOME: hostHome,
      USERPROFILE: hostHome,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      NODE_FIXTURE_HOME: hostHome,
      NODE_DIRECT_BIN: join(nodeDir, "node"),
    };
    const isolated = createIsolatedTestEnvironment(sourceEnv);
    try {
      await pinTestNodePath(isolated.env, sourceEnv, isolated.root);
      expect(isolated.env.PATH?.split(delimiter)[0]).toBe(nodeDir);
      const result = Bun.spawnSync(["node", "-e", "ignored"], {
        cwd: fixture,
        env: isolated.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("direct-node\n");
    } finally {
      isolated.cleanup();
      removeTreeWithRetry(fixture);
    }
  });

  test.skipIf(process.platform === "win32")("Node selection follows the native OS when a test simulates win32", async () => {
    const { fixture, shimDir, nodeDir, hostHome } = createHomeDependentNodeShimFixture();
    const sourceEnv = {
      ...process.env,
      HOME: hostHome,
      USERPROFILE: hostHome,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      NODE_FIXTURE_HOME: hostHome,
      NODE_DIRECT_BIN: join(nodeDir, "node"),
    };
    const isolated = createIsolatedTestEnvironment(sourceEnv);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
      await pinTestNodePath(isolated.env, sourceEnv, isolated.root);
      expect(isolated.env.PATH?.split(delimiter)[0]).toBe(nodeDir);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      isolated.cleanup();
      removeTreeWithRetry(fixture);
    }
  });

  test.skipIf(process.platform === "win32")("repeated preload selection does not grow an already pinned PATH", async () => {
    const { fixture, shimDir, nodeDir, hostHome } = createHomeDependentNodeShimFixture();
    const sourceEnv = {
      ...process.env,
      HOME: hostHome,
      USERPROFILE: hostHome,
      PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      NODE_FIXTURE_HOME: hostHome,
      NODE_DIRECT_BIN: join(nodeDir, "node"),
    };
    const first = createIsolatedTestEnvironment(sourceEnv);
    let second: ReturnType<typeof createIsolatedTestEnvironment> | undefined;
    try {
      await pinTestNodePath(first.env, sourceEnv, first.root);
      second = createIsolatedTestEnvironment(first.env);
      await pinTestNodePath(second.env, first.env, second.root);
      expect(second.env.PATH).toBe(first.env.PATH);
    } finally {
      second?.cleanup();
      first.cleanup();
      removeTreeWithRetry(fixture);
    }
  });

  test.skipIf(process.platform === "win32")("a quoted PATH entry is not treated as a callable Node directory", async () => {
    const { fixture, shimDir, nodeDir, hostHome } = createHomeDependentNodeShimFixture();
    const sourceEnv = {
      ...process.env,
      HOME: hostHome,
      USERPROFILE: hostHome,
      PATH: `"${nodeDir}"${delimiter}${shimDir}`,
      NODE_FIXTURE_HOME: hostHome,
      NODE_DIRECT_BIN: join(nodeDir, "node"),
    };
    const isolated = createIsolatedTestEnvironment(sourceEnv);
    try {
      await pinTestNodePath(isolated.env, sourceEnv, isolated.root);
      const child = Bun.spawnSync(["node", "-e", "ignored"], {
        env: isolated.env,
        cwd: fixture,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2_000,
      });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toBe("direct-node\n");
    } finally {
      isolated.cleanup();
      removeTreeWithRetry(fixture);
    }
  });

  test.skipIf(process.platform === "win32")("refuses missing, failed, and malformed Node probes", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-test-node-failure-"));
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    try {
      for (const body of [
        null,
        "exit 9",
        "printf 'relative/node\\n'",
        "printf '%s\\nnot-a-version\\n' \"$0\"",
        "exec /bin/sleep 30",
      ]) {
        const node = join(bin, "node");
        if (body === null) {
          if (existsSync(node)) unlinkSync(node);
        } else {
          writeFileSync(node, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        }
        const sourceEnv = { PATH: bin, HOME: fixture };
        const isolated = createIsolatedTestEnvironment(sourceEnv);
        try {
          const startedAt = Date.now();
          await expect(pinTestNodePath(isolated.env, sourceEnv, isolated.root)).rejects.toThrow("usable Node");
          expect(Date.now() - startedAt).toBeLessThan(4_000);
        } finally {
          isolated.cleanup();
        }
      }
    } finally {
      removeTreeWithRetry(fixture);
    }
  }, { timeout: 8_000 });

  test.skipIf(process.platform === "win32").each([
    [null, "source:ENOENT=1"],
    ["exit 9", "source:exit-nonzero=1"],
    ["printf 'PRIVATE_PROBE_OUTPUT\\n'", "source:invalid-output=1"],
    ["if [ \"$HOME\" != \"$NODE_FIXTURE_SOURCE_HOME\" ]; then printf 'PRIVATE_SANDBOX_OUTPUT\\n'; else printf '%s\\n22.0.0\\n' \"$0\"; fi", "sandbox:invalid-output=1"],
    ["if [ \"$HOME\" != \"$NODE_FIXTURE_SOURCE_HOME\" ]; then printf '/nonexistent-private-fixture/node\\n22.0.0\\n'; else printf '%s\\n22.0.0\\n' \"$0\"; fi", "realpath:ENOENT=1"],
    ["exec /bin/sleep 30", "source:ETIMEDOUT=1"],
  ])("a failing Node fixture reports safe bounded categories: %s", async (body, category) => {
    const root = mkdtempSync(join(tmpdir(), "ocx-node-diagnostic-"));
    const isolated = createIsolatedTestEnvironment();
    try {
      isolated.env.NODE_FIXTURE_SOURCE_HOME = root;
      if (body !== null) writeFileSync(join(root, "node"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      let failure: unknown;
      try { await pinTestNodePath(isolated.env, { PATH: root, HOME: root, NODE_FIXTURE_SOURCE_HOME: root }, isolated.root); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("No usable Node executable on PATH for isolated tests.");
      expect(message).toContain(category!);
      expect(message).toContain("spawn=function");
      expect(message).toContain("realpathSync=function");
      expect(message).not.toContain(root);
      expect(message).not.toContain(isolated.root);
      expect(message).not.toMatch(/PRIVATE_|nonexistent-private-fixture/);
      expect(message.length).toBeLessThan(1_000);
    } finally { isolated.cleanup(); removeTreeWithRetry(root); }
  });

  test("a Node probe TypeError reports its category without disclosing its error text", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-node-probe-mock-"));
    const driver = join(root, "driver.ts");
    const mockedPlatform = process.platform === "win32" ? "darwin" : "win32";
    writeFileSync(driver, `
Object.defineProperty(process, "platform", { value: ${JSON.stringify(mockedPlatform)}, configurable: true });
const { getTestRunnerNodeDirectory } = await import(${JSON.stringify(repoPath("scripts", "lib", "test-runner-node.ts"))});
try { await getTestRunnerNodeDirectory({ PATH: "/private/fixture/probe", INVALID_PROBE_ENV: Symbol("PRIVATE_TYPEERROR_MESSAGE") } as any, "/private/fixture/home"); }
catch (error) { console.log(error.message); }`);
    try {
      const child = Bun.spawnSync([process.execPath, driver], {
        env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 2_000,
      });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toContain("source:TypeError=1");
      expect(child.stdout.toString()).toContain("spawn=function");
      expect(child.stdout.toString()).toContain(`platform=${mockedPlatform}`);
      expect(child.stdout.toString()).not.toContain("/private/fixture");
      expect(child.stdout.toString()).not.toContain("PRIVATE_TYPEERROR_MESSAGE");
    } finally { removeTreeWithRetry(root); }
  });
});
