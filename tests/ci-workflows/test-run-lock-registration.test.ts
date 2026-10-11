import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test.each(["members-directory", "member-file", "inherited"] as const)(
  "same-run registration rejects persistent %s failure without blocking the event loop",
  fault => {
    const root = mkdtempSync(join(tmpdir(), "ocx-lock-registration-"));
    const driver = join(root, "driver.ts");
    const lockPath = join(root, "isolated.lock");
    writeFileSync(driver, `import { acquireTestRunLock } from ${JSON.stringify(repoPath("scripts", "test-run-lock.ts"))};
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path";
const lockPath = ${JSON.stringify(lockPath)};
const options = { runId: "registration-fixture", lockPath, env: {}, pollMs: 5, maxWaitMs: 50 };
const owner = await acquireTestRunLock(options);
${fault === "member-file"
  ? 'mkdirSync(join(lockPath, "members", process.pid + "-" + owner.owner!.token), { recursive: true });'
  : 'writeFileSync(join(lockPath, "members"), "not a directory");'}
const startedAt = Date.now();
try {
  await acquireTestRunLock({ ...options, ${fault === "inherited" ? "joinExistingOwnerToken: owner.owner!.token" : ""} });
  console.log(JSON.stringify({ joined: true }));
} catch (error) {
  console.log(JSON.stringify({ message: error.message, code: error.cause?.code, elapsed: Date.now() - startedAt,
    intact: JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).token === owner.owner!.token }));
} finally { owner.release(); }
`);
    try {
      const child = spawnSync(process.execPath, [driver], {
        cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        encoding: "utf8", timeout: 1_500, killSignal: "SIGKILL",
      });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.message).toContain("Cannot register a member of the live Bun test lock");
      expect(["EEXIST", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]).toContain(result.code);
      expect(result.elapsed).toBeLessThan(1_000);
      expect(result.intact).toBe(true);
    } finally { removeTreeWithRetry(root); }
  }, { timeout: 4_000 },
);

test("an owner CAS during member registration yields and retries the current owner", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-lock-registration-cas-"));
  const driver = join(root, "driver.ts");
  const lockPath = join(root, "isolated.lock");
  writeFileSync(driver, `import { mock } from "bun:test"; import * as fs from "node:fs"; import { join, sep } from "node:path";
const write = fs.writeFileSync; const read = fs.readFileSync;
const lockPath = ${JSON.stringify(lockPath)}; let changes = 0;
mock.module("node:fs", () => ({ ...fs, writeFileSync(path, ...args) {
  if (String(path).startsWith(join(lockPath, "members") + sep) && changes > 0) {
    const owner = JSON.parse(read(join(lockPath, "owner.json"), "utf8")); owner.token += "-cas"; changes--;
    write(join(lockPath, "owner.json"), JSON.stringify(owner));
  }
  return write(path, ...args);
} }));
const { acquireTestRunLock } = await import(${JSON.stringify(repoPath("scripts", "test-run-lock.ts"))});
const options = { runId: "cas-fixture", lockPath, env: {}, pollMs: 10, maxWaitMs: 200 };
await acquireTestRunLock(options); changes = 3;
let timerFired = false; let waits = 0; setTimeout(() => { timerFired = true; }, 0);
const joined = await acquireTestRunLock({ ...options, onWait: () => { waits++; } });
const current = JSON.parse(read(join(lockPath, "owner.json"), "utf8"));
console.log(JSON.stringify({ timerFired, waits, acquired: joined.acquired, token: joined.owner?.token,
  current: current.token, member: fs.existsSync(join(lockPath, "members", process.pid + "-" + current.token)) }));
`);
  try {
    const child = spawnSync(process.execPath, [driver], {
      cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
      encoding: "utf8", timeout: 1_500, killSignal: "SIGKILL",
    });
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.timerFired).toBe(true);
    expect(result.waits).toBe(1);
    expect(result.acquired).toBe(false);
    expect(result.token).toBe(result.current);
    expect(result.member).toBe(true);
  } finally { removeTreeWithRetry(root); }
}, { timeout: 4_000 });

test.each(["member-file", "unknown-code"] as const)(
  "uncaught registration %s errors omit private paths and owner tokens",
  fault => {
    const root = mkdtempSync(join(tmpdir(), "ocx-lock-safe-error-"));
    const driver = join(root, "driver.ts");
    const identifiers = join(root, "identifiers.json");
    writeFileSync(driver, `import { mock } from "bun:test"; import * as fs from "node:fs"; import { join } from "node:path";
const lockPath = join(process.env.OCX_FIXTURE_ROOT!, "private-lock");
const identifiers = process.env.OCX_FIXTURE_IDENTIFIERS!; const write = fs.writeFileSync;
let fault = false;
${fault === "unknown-code" ? `mock.module("node:fs", () => ({ ...fs, writeFileSync(path, ...args) {
  if (fault) throw Object.assign(new Error("PRIVATE_RAW_MESSAGE " + lockPath), { code: "PRIVATE_UNKNOWN_CODE" });
  return write(path, ...args);
} }));` : ""}
const { acquireTestRunLock } = await import(${JSON.stringify(repoPath("scripts", "test-run-lock.ts"))});
const options = { runId: "safe-error-fixture", lockPath, env: {}, pollMs: 5, maxWaitMs: 50 };
const owner = await acquireTestRunLock(options);
write(identifiers, JSON.stringify({ token: owner.owner!.token, lockPath }));
${fault === "member-file" ? 'fs.mkdirSync(join(lockPath, "members", process.pid + "-" + owner.owner!.token), { recursive: true });' : "fault = true;"}
await acquireTestRunLock(options);
`);
    try {
      const child = spawnSync(process.execPath, [driver], {
        cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1", OCX_FIXTURE_ROOT: root, OCX_FIXTURE_IDENTIFIERS: identifiers },
        encoding: "utf8", timeout: 1_500, killSignal: "SIGKILL",
      });
      expect(child.status).toBe(1);
      const privateData = JSON.parse(readFileSync(identifiers, "utf8"));
      const output = child.stdout + child.stderr;
      expect(output).toContain("Cannot register a member of the live Bun test lock");
      expect(output).not.toContain(privateData.lockPath);
      expect(output).not.toContain(privateData.token);
      expect(output).not.toContain("PRIVATE_RAW_MESSAGE");
      expect(output).not.toContain("PRIVATE_UNKNOWN_CODE");
      if (fault === "unknown-code") expect(output).toContain("filesystem-error");
    } finally { removeTreeWithRetry(root); }
  }, { timeout: 4_000 },
);

test("registration CAS preserves a live replacement after the old owner exits", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-lock-live-replacement-"));
  const driver = join(root, "driver.ts");
  writeFileSync(driver, `import { mock } from "bun:test"; import * as fs from "node:fs"; import { join, sep } from "node:path";
const lockPath = join(process.env.OCX_FIXTURE_ROOT!, "isolated.lock"); const write = fs.writeFileSync; const read = fs.readFileSync;
const old = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
let swap = false; let replacement; let oldDead = false;
mock.module("node:fs", () => ({ ...fs, writeFileSync(path, ...args) {
  const result = write(path, ...args);
  if (swap && String(path).startsWith(join(lockPath, "members") + sep)) {
    swap = false; const previous = JSON.parse(read(join(lockPath, "owner.json"), "utf8"));
    replacement = { ...previous, runId: "replacement-live", token: previous.token + "-replacement", pid: process.pid };
    write(join(lockPath, "owner.json"), JSON.stringify(replacement)); fs.rmSync(String(path), { force: true });
  }
  return result;
} }));
const { acquireTestRunLock } = await import(${JSON.stringify(repoPath("scripts", "test-run-lock.ts"))});
const options = { runId: "old-run", ownerPid: old.pid, lockPath, env: {}, pollMs: 5, maxWaitMs: 50 };
const owner = await acquireTestRunLock(options);
fs.mkdirSync(join(lockPath, "members"));
write(join(lockPath, "members", process.pid + "-" + owner.owner!.token), "");
old.kill("SIGKILL"); await old.exited;
try { process.kill(old.pid, 0); } catch { oldDead = true; }
swap = true;
let acquired = false; let message = "";
try { acquired = (await acquireTestRunLock(options)).acquired; } catch (error) { message = error.message; }
const current = JSON.parse(read(join(lockPath, "owner.json"), "utf8"));
console.log(JSON.stringify({ oldDead, acquired, message, preserved: current.token === replacement.token && current.pid === process.pid }));
`);
  try {
    const child = spawnSync(process.execPath, [driver], {
      cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1", OCX_FIXTURE_ROOT: root },
      encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL",
    });
    expect(child.status).toBe(0);
    const result = JSON.parse(child.stdout);
    expect(result.oldDead).toBe(true);
    expect(result.acquired).toBe(false);
    expect(result.preserved).toBe(true);
    expect(result.message).toContain("timed out");
  } finally { removeTreeWithRetry(root); }
}, { timeout: 4_000 });
