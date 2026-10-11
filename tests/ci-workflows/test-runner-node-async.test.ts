import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
