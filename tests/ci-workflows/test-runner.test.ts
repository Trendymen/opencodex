import * as nodePin from "../../scripts/lib/test-runner-node";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, posix, win32 } from "node:path";
import {
  changedSelectionFailure,
  captureTestOutput,
  createIsolatedTestEnvironment,
  LIVE_INSTALL_CREDENTIAL_ENV,
  ensureGuiDependencies,
  inspectChangedRun,
  resolveBunTestArgs,
  resolveBunTestPlan,
  runTestLane,
  selectChangedComparisonRef,
  SERIAL_FULL_SUITE_FILES,
} from "../../scripts/test";
import {
  NESTED_LIVE_LOCK_RECEIPT_KEY,
} from "../helpers/nested-test-run-lock-controller";
import { helperPath, repoPath, repoRoot } from "../helpers/repo-root";
import {
  acquireTestRunLock,
  resolveBareTestRunIdentity,
  resolveDefaultTestRunLockPath,
  resolveInheritedTestRunLock,
  resolveWrappedTestRunLockPath,
  TEST_RUN_ID_ENV,
  TEST_RUN_LOCK_PATH_ENV,
  TEST_RUN_LOCK_TOKEN_ENV,
  TEST_RUN_NO_QUEUE_ENV,
  type TestRunRuntimeFileSystem,
} from "../../scripts/test-run-lock";
import {
  recoverStaleTestTempArtifacts,
  removeTestTempTree,
  TEST_TEMP_OWNER_FILE,
  TEST_TEMP_RECOVERY_AGE_MS,
} from "../../scripts/test-temp";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../../src/codex/user-identity";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmColdSpawn } from "../helpers/cold-spawn-warmup";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";


function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function changedFixtureDiagnostic(result: Bun.ReadableSyncSubprocess, args: string[], cwd: string): string {
  const redact = (value: string) => {
    for (const privateValue of [cwd, repoRoot(), process.env.HOME, process.env.USERPROFILE,
      process.env[TEST_RUN_LOCK_TOKEN_ENV], ...LIVE_INSTALL_CREDENTIAL_ENV.map(key => process.env[key])]) {
      if (privateValue) value = value.replaceAll(privateValue, "<redacted>");
    }
    return value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<token>").slice(-12_000);
  };
  return JSON.stringify({
    args: args.map(redact), exitCode: result.exitCode, signal: result.signalCode ?? null,
    timeout: result.exitedDueToTimeout ?? false, maxBuffer: result.exitedDueToMaxBuffer ?? false,
    stdout: redact(result.stdout.toString()), stderr: redact(result.stderr.toString()),
  });
}

// Assembled from fragments so the fixture identity is not an email literal in a tracked
// file: scripts/privacy-scan.ts matches any email-shaped string and `.invalid` is not
// allow-listed, so writing it whole fails the repository's own privacy gate. The bytes
// handed to git are identical either way.
const FIXTURE_COMMIT_EMAIL = ["test", "opencodex.invalid"].join("@");

function pathIsContainedBy(parent: string, candidate: string, platform: "posix" | "win32"): boolean {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function acceptingRuntimeFileSystem(
  uid: number,
  writable = true,
  modes: Readonly<Record<string, number>> = {},
): TestRunRuntimeFileSystem {
  return {
    lstatSync: path => ({
      uid,
      mode: modes[path] ?? 0o700,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    mkdirSync: () => {},
    accessSync: () => {
      if (!writable) throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  };
}

function commitFixture(cwd: string, path: string, contents: string, message: string): string {
  writeFileSync(join(cwd, path), contents);
  runGit(cwd, "add", path);
  runGit(
    cwd,
    "-c",
    "user.name=OpenCodex Test",
    "-c",
    `user.email=${FIXTURE_COMMIT_EMAIL}`,
    "commit",
    "-m",
    message,
  );
  return runGit(cwd, "rev-parse", "HEAD");
}

function initChangedRunFixture(): { cwd: string; base: string } {
  const cwd = mkdtempSync(join(tmpdir(), "opencodex-changed-ref-"));
  runGit(cwd, "init", "--quiet");
  const base = commitFixture(cwd, "base.txt", "base\n", "base");
  return { cwd, base };
}

const desktopLifecycleFiles = [
  "claude-integration/claude-desktop-picker-routes.test.ts",
  "claude-integration/claude-desktop-picker-profile.test.ts",
  "claude-integration/claude-desktop-first-party.test.ts",
  "claude-integration/claude-desktop-first-party-guards.test.ts",
];

test("Node pin failure prevents the child and still removes isolated HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-pin-failure-"));
  const marker = join(root, "ran");
  const fixture = join(root, "child.test.ts");
  writeFileSync(fixture, `import {test} from "bun:test"; import {writeFileSync} from "node:fs"; test("child",()=>writeFileSync(${JSON.stringify(marker)},"ran"));`);
  let home = "";
  const pin = spyOn(nodePin, "pinTestNodePath").mockImplementation(async env => { home = env.HOME!; throw new Error("fixture pin failure"); });
  try {
    await expect(runTestLane({ label: "pin failure", args: [fixture], timeoutMs: 2_000 }, "pin-failure", undefined, true, undefined, process.execPath)).rejects.toThrow("fixture pin failure");
    expect(home).not.toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(home)).toBe(false);
  } finally { pin.mockRestore(); removeTreeWithRetry(root); }
});

test.each([["SIGINT", false], ["SIGTERM", false], ["SIGINT", true], ["SIGTERM", true]] as const)("external %s during Node pin prevents the child and waits for HOME cleanup, pin rejects=%s", async (signal, rejects) => {
  const root = mkdtempSync(join(tmpdir(), "ocx-pin-signal-"));
  const marker = join(root, "ran");
  const fixture = join(root, "child.test.ts");
  writeFileSync(fixture, `import {test} from "bun:test"; import {writeFileSync} from "node:fs"; test("child",()=>writeFileSync(${JSON.stringify(marker)},"ran"));`);
  let home = "";
  const pin = spyOn(nodePin, "pinTestNodePath").mockImplementation(async env => {
    home = env.HOME!;
    process.emit(signal);
    await Bun.sleep(70);
    expect(existsSync(home)).toBe(true);
    if (rejects) throw new Error("cancelled pin fixture");
  });
  try {
    const result = await runTestLane({ label: "signal pin", args: [fixture], timeoutMs: 2_000 }, "signal-pin", undefined, true, undefined, process.execPath);
    expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    expect(home).not.toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(home)).toBe(false);
  } finally { pin.mockRestore(); removeTreeWithRetry(root); }
});

test.each(["-c", "--config", "--cwd", "--no-isolate", "--watch", "--hot", "--coverage", "--coverage-dir", "--coverage-reporter", "--only-failures", "--bail", "--rerun-each", "--retry"])("state option %s stays in one lane for full and changed while a filter literal does not", flag => {
  const values: Record<string, string> = { "-c": "custom.toml", "--config": "custom.toml", "--cwd": "custom-root", "--coverage-dir": "coverage", "--coverage-reporter": "lcov", "--rerun-each": "2", "--retry": "2" };
  const options = values[flag] === undefined ? [flag] : [flag, values[flag]!];
  for (const prefix of [[], ["--changed=fixture"]]) {
    const requested = [...prefix, ...options];
    expect(resolveBunTestPlan(requested, "fixed-sha", {})).toEqual([{ label: "suite", args: resolveBunTestArgs(requested, "fixed-sha"), timeoutMs: 900_000 }]);
    expect(resolveBunTestPlan([...prefix, "-t", flag], "fixed-sha", {})).toHaveLength(26);
  }
});

test.each([false, true])("changed wrapper keeps one main HOME and serializes official and SQLite writers, no-isolate=%s", noIsolate => {
  const { cwd } = initChangedRunFixture();
  const records = join(cwd, "executions.jsonl");
  const held = join(cwd, "sqlite-held");
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "tests", "claude-integration"), { recursive: true });
  writeFileSync(join(cwd, "bunfig.toml"), '[test]\nroot="tests"\npreload=[]\n');
  commitFixture(cwd, "src/shared.ts", 'import {randomUUID} from "node:crypto"; export const value=1; export const token=randomUUID();\n', "shared");
  for (let index = 0; index < 14; index++) {
    commitFixture(cwd, `tests/ordinary-${index}.test.ts`, `import {test,expect} from "bun:test"; import {appendFileSync} from "node:fs"; import {value,token} from "../src/shared";
test("ordinary",()=>{expect(value).toBe(2);appendFileSync(${JSON.stringify(records)},JSON.stringify({id:${index},home:process.env.HOME,token})+"\\n");});`, "ordinary");
  }
  const sensitiveFiles = [...desktopLifecycleFiles, "service/service-claim.test.ts", "codex-integration/native-codex-toggle.test.ts"];
  for (const [index, file] of sensitiveFiles.entries()) {
    mkdirSync(dirname(join(cwd, "tests", file)), { recursive: true });
    commitFixture(cwd, "tests/" + file, index === 3
      ? 'import {test} from "bun:test"; test("unselected",()=>{throw new Error("unrelated SQLite writer executed");});'
      : `import {test,expect} from "bun:test"; import {appendFileSync,mkdirSync,rmSync} from "node:fs"; import {value,token} from "../../src/shared";
test("SQLite writer",async()=>{expect(value).toBe(2);mkdirSync(${JSON.stringify(held)});const start=Date.now();try{await Bun.sleep(20);appendFileSync(${JSON.stringify(records)},JSON.stringify({id:${JSON.stringify(file)},home:process.env.HOME,token,start,end:Date.now()})+"\\n");}finally{rmSync(${JSON.stringify(held)},{recursive:true});}});`, "sqlite");
  }
  const comparison = runGit(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "src/shared.ts"), readFileSync(join(cwd, "src/shared.ts"), "utf8").replace("value=1", "value=2"));
  try {
    const args = [repoPath("scripts", "test.ts"), "--changed=" + comparison, ...(noIsolate ? ["--parallel=1", "--no-isolate"] : [])];
    const result = Bun.spawnSync([process.execPath, ...args], {
      cwd, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    if (result.exitCode !== 0) console.error(changedFixtureDiagnostic(result, args, cwd));
    expect(result.exitCode).toBe(0);
    const rows = readFileSync(records, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.filter(row => typeof row.id === "number").map(row => row.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const mainHomes = new Set<string>(rows.filter(row => typeof row.id === "number").map(row => row.home));
    expect(mainHomes.size).toBe(1);
    const desktop = rows.filter(row => typeof row.id === "string").sort((a, b) => a.start - b.start);
    expect(desktop.map(row => row.id).sort()).toEqual(sensitiveFiles.filter((_, index) => index !== 3).sort());
    for (const [index, row] of desktop.entries()) {
      if (index) expect(row.start).toBeGreaterThanOrEqual(desktop[index - 1].end);
      if (!noIsolate) expect(mainHomes.has(row.home)).toBe(false);
    }
    expect(new Set(rows.map(row => row.home)).size).toBe(noIsolate ? 1 : 6);
    if (noIsolate) expect(new Set(rows.map(row => row.token)).size).toBe(1);
    for (const home of new Set<string>(rows.map(row => row.home))) expect(existsSync(home)).toBe(false);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(changedSelectionFailure({ comparisonRef: "fixture", comparisonCommit: comparison, changedFiles: ["src/shared.ts"] }, output)).toBeNull();
  } finally { removeTreeWithRetry(cwd); }
}, { timeout: 40_000 });

describe("test runner watchdog diagnostics", () => {
  test.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
    "%s still interrupts a real lane without deadline diagnostics",
    signal => {
      const root = mkdtempSync(join(tmpdir(), "ocx-lane-signal-"));
      const homeFile = join(root, "home.txt");
      const resultFile = join(root, "result.json");
      const fixture = join(root, "signal.test.ts");
      const driver = join(root, "driver.ts");
      writeFileSync(fixture, `import { test } from "bun:test"; import { writeFileSync } from "node:fs";
test("signal fixture", async () => { writeFileSync(${JSON.stringify(homeFile)}, process.env.HOME!); await new Promise(() => {}); }, 60_000);`);
      writeFileSync(driver, `import { runTestLane } from ${JSON.stringify(repoPath("scripts", "test.ts"))}; import { existsSync, writeFileSync } from "node:fs";
const timer = setInterval(() => { if (existsSync(${JSON.stringify(homeFile)})) { clearInterval(timer); process.kill(process.pid, ${JSON.stringify(signal)}); } }, 20);
const result = await runTestLane({ label: "signal fixture", args: [${JSON.stringify(fixture)}], timeoutMs: 15_000 }, "signal-fixture", undefined, true, undefined, process.execPath);
clearInterval(timer); writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));`);
      try {
        const child = Bun.spawnSync([process.execPath, driver], {
          cwd: repoRoot(), env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
        });
        expect(child.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(resultFile, "utf8")).exitCode).toBe(signal === "SIGINT" ? 130 : 143);
        expect(existsSync(readFileSync(homeFile, "utf8"))).toBe(false);
        expect(child.stderr.toString()).not.toContain("deadline diagnostics");
      } finally {
        removeTreeWithRetry(root);
      }
    }, { timeout: 15_000 },
  );

  test.skipIf(process.platform === "win32").each(["available", "missing", "blocked"] as const)(
    "a real deadline retains safe diagnostics with %s observer tools and cleans its home",
    mode => {
      const root = mkdtempSync(join(tmpdir(), "ocx-watchdog-fixture-"));
      const infoFile = join(root, "info.json");
      const resultFile = join(root, "result.json");
      const testFile = join(root, "timeout.test.ts");
      const driver = join(root, "driver.ts");
      const tools = join(root, "tools");
      mkdirSync(tools);
      writeFileSync(testFile, `import { test } from "bun:test"; import { writeFileSync } from "node:fs";
test("watchdog fixture", async () => {
  const workers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }));
  writeFileSync(${JSON.stringify(infoFile)}, JSON.stringify({ pid: process.pid, parent: process.ppid, workers: workers.map(worker => worker.pid), home: process.env.HOME }));
  process.on("SIGTERM", () => { for (const worker of workers) worker.kill("SIGKILL"); process.exit(0); });
  await new Promise(() => {});
}, 60_000);`);
      writeFileSync(join(tools, "ps"), `#!${process.execPath}
import { readFileSync } from "node:fs";
${mode === "blocked" ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
  : mode === "missing" ? "process.exit(1);"
  : `const info = JSON.parse(readFileSync(${JSON.stringify(infoFile)}, "utf8")); console.log(info.pid, info.parent, "0.0 4000 /private/fixture/bun"); info.workers.forEach((pid, index) => console.log(pid, info.pid, index === 3 ? "99.0" : "0.0", "2000 /private/fixture/bun"));`}
`, { mode: 0o755 });
      writeFileSync(join(tools, "sample"), `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "sample-args.json"))}, JSON.stringify(process.argv.slice(2)));
if (!process.argv.includes("-file")) writeFileSync(${JSON.stringify(join(root, "raw-sample.txt"))}, "PRIVATE_RAW_HEADER");
console.log("Command line: SECRET_FIXTURE_ARG");
console.log("Call graph:\\n + 1 worker_wait (in bun) [0x123] (/Users/Example Person/Private (Debug) App/bun:42)\\n + 2 normal_symbol (in /Users/Example Person/Private (Debug) App/bun) [0x456]\\n + 3 other_symbol /Users/Example Person/Private (Debug) App/bun [0x789]\\nTotal number in stack: 1");
`, { mode: 0o755 });
      writeFileSync(driver, `import { runTestLane } from ${JSON.stringify(repoPath("scripts", "test.ts"))}; import { writeFileSync } from "node:fs";
const result = await runTestLane({ label: "diagnostic fixture", args: [${JSON.stringify(testFile)}], timeoutMs: 2_000 }, "diagnostic-fixture", undefined, true, undefined, process.execPath);
writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));`);
      let diagnosticRoot: string | undefined;
      try {
        const startedAt = Date.now();
        const result = Bun.spawnSync([process.execPath, driver], {
          cwd: repoRoot(), env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`, OCX_TEST_NO_QUEUE: "1" },
          stdout: "pipe", stderr: "pipe", timeout: 15_000,
        });
        expect(result.exitCode).toBe(0);
        expect(Date.now() - startedAt).toBeLessThan(12_000);
        expect(JSON.parse(readFileSync(resultFile, "utf8")).exitCode).toBe(124);
        const info = JSON.parse(readFileSync(infoFile, "utf8"));
        expect(existsSync(info.home)).toBe(false);
        diagnosticRoot = result.stderr.toString().match(/diagnostics: ([^\r\n]+)/)?.[1];
        expect(diagnosticRoot).toBeDefined();
        const manifest = JSON.parse(readFileSync(join(diagnosticRoot!, "processes.json"), "utf8"));
        expect(manifest.runnerPid).toBe(info.parent);
        expect(manifest.childPid).toBe(info.pid);
        if (mode === "available") {
          expect(manifest.processes).toContainEqual({ pid: info.workers[3], ppid: info.pid, cpuPercent: 99, rssKb: 2000, executable: "bun" });
          if (process.platform === "darwin") expect(readFileSync(join(diagnosticRoot!, `sample-${info.pid}.txt`), "utf8")).toContain("worker_wait");
          if (process.platform === "darwin") expect(readFileSync(join(diagnosticRoot!, `sample-${info.workers[3]}.txt`), "utf8")).toContain("worker_wait");
          if (process.platform === "darwin") {
            expect(JSON.parse(readFileSync(join(root, "sample-args.json"), "utf8")).slice(1)).toEqual(["1", "-file", "/dev/stdout"]);
            expect(existsSync(join(root, "raw-sample.txt"))).toBe(false);
            const stack = readFileSync(join(diagnosticRoot!, `sample-${info.pid}.txt`), "utf8");
            expect(stack).toContain("+ 1 worker_wait (in bun) [0x123] ([path])");
            expect(stack).toContain("+ 2 normal_symbol ([path]) [0x456]");
            expect(stack).toContain("+ 3 other_symbol [path] [0x789]");
          }
        } else expect(manifest.status).toBe("process inventory unavailable");
        for (const file of readdirSync(diagnosticRoot!)) {
          expect(readFileSync(join(diagnosticRoot!, file), "utf8")).not.toContain("SECRET_FIXTURE_ARG");
          expect(readFileSync(join(diagnosticRoot!, file), "utf8")).not.toContain("/private/fixture");
          expect(readFileSync(join(diagnosticRoot!, file), "utf8")).not.toMatch(/Example|Person|Private|Debug|App/);
        }
      } finally {
        if (diagnosticRoot) removeTreeWithRetry(diagnosticRoot);
        removeTreeWithRetry(root);
      }
    }, { timeout: 20_000 },
  );
});

describe("test runner captured output", () => {
  // This describe's first real lane pays Bun's test-runner bootstrap inside its child timeout.
  // Replay one trivial lane in setup because an import scan cannot warm Bun's runner startup.
  beforeAll(async () => {
    await warmColdSpawn("bun-test-lane", async deadlineMs => {
      const root = mkdtempSync(join(tmpdir(), "opencodex-capture-lane-warmup-"));
      const fixture = join(root, "warmup.test.ts");
      writeFileSync(fixture, 'import { test } from "bun:test";\ntest("warm-up fixture", () => {});\n');
      try {
        const runId = process.env[TEST_RUN_ID_ENV]!;
        const result = await runTestLane(
          { label: "warm-up fixture", args: [fixture], timeoutMs: deadlineMs },
          runId,
          resolveInheritedTestRunLock({ wrappedRunId: runId, env: process.env }),
          true,
          { stdout: () => {}, stderr: () => {} },
        );
        expect(result.exitCode).toBe(0);
      } finally {
        removeTreeWithRetry(root);
      }
    });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  test("preserves both streams and UTF-8 characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("before 한글 after\n");
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("diagnostic\n"));
        controller.close();
      },
    });
    expect(await captureTestOutput(stdout, stderr).finish(1_000)).toEqual({
      stdout: "before 한글 after\n", stderr: "diagnostic\n", complete: true,
    });
  });

  test.each(["pending", "rejected"] as const)(
    "bounds an open pipe even when cancellation is %s",
    async cancellation => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const stdout = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(new TextEncoder().encode("retained prefix\n"));
        },
        cancel() {
          cancelled = true;
          return cancellation === "pending"
            ? new Promise<void>(() => {})
            : Promise.reject(new Error("fixture cancellation failure"));
        },
      });
      const stderr = new ReadableStream<Uint8Array>({ start(value) { value.close(); } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          captureTestOutput(stdout, stderr).finish(20),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000); }),
        ]);
        expect(result).toEqual({ stdout: "retained prefix\n", stderr: "", complete: false });
        expect(cancelled).toBe(true);
      } finally {
        clearTimeout(timer);
        try { controller.close(); } catch { /* cancellation already closed it */ }
      }
    },
  );

  test("retains a prefix when reading the pipe fails", async () => {
    let reads = 0;
    const stdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode("before error\n"));
        else controller.error(new Error("fixture read failure"));
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    expect(await captureTestOutput(stdout, stderr).finish(1_000)).toEqual({
      stdout: "before error\n", stderr: "", complete: false,
    });
  });

  test("an exited child with an open pipe reports incomplete capture instead of success", async () => {
    let cancelled = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("partial output\n")); },
      cancel() { cancelled = true; },
    });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const originalSpawn = Bun.spawn;
    let resolveSpawn!: () => void;
    const spawned = new Promise<void>(resolve => { resolveSpawn = resolve; });
    const fixtureChild = {
      pid: 0,
      stdout,
      stderr,
      exited: Promise.resolve(0),
      kill() { throw new Error("the fixture child already exited"); },
    } as unknown as ReturnType<typeof Bun.spawn>;
    const spawn = spyOn(Bun, "spawn").mockImplementation((command, options) => {
      if (Array.isArray(command) && command[1] === "test") {
        resolveSpawn();
        return fixtureChild;
      }
      return originalSpawn(command, options);
    });
    const emitted: string[] = [];
    try {
      const pending = runTestLane(
        { label: "open pipe fixture", args: [], timeoutMs: 2_000 },
        "capture-fixture",
        undefined,
        true,
        { stdout: value => { emitted.push(value); }, stderr: value => { emitted.push(value); } },
      );
      await spawned;
      // Restore after the lane spawn; Node probes keep their real subprocesses.
      spawn.mockRestore();
      expect(await pending).toEqual({ exitCode: 1, output: "partial output\n\n" });
      expect(emitted).toEqual(["partial output\n"]);
      expect(cancelled).toBe(true);
    } finally {
      spawn.mockRestore();
    }
  });

  test.each(["pass", "fail", "timeout"] as const)(
    "returns and prints a %s lane's output exactly once",
    async outcome => {
      const root = mkdtempSync(join(tmpdir(), "opencodex-capture-lane-"));
      const fixture = join(root, "capture.test.ts");
      const stdout: string[] = [];
      const stderr: string[] = [];
      writeFileSync(fixture, `
        import { test } from "bun:test";
        test("capture fixture", async () => {
          process.stdout.write("OCX_CAPTURE_STDOUT_MARKER\\n");
          process.stderr.write("OCX_CAPTURE_STDERR_MARKER\\n");
          ${outcome === "timeout" ? "await new Promise(() => {});" : ""}
          ${outcome === "fail" ? 'throw new Error("fixture assertion failure");' : ""}
        }, 60_000);
      `);
      try {
        const runId = process.env[TEST_RUN_ID_ENV]!;
        const result = await runTestLane(
          { label: "capture fixture", args: [fixture], timeoutMs: INTERNAL_DEADLINE_MS },
          runId,
          resolveInheritedTestRunLock({ wrappedRunId: runId, env: process.env }),
          true,
          { stdout: value => { stdout.push(value); }, stderr: value => { stderr.push(value); } },
        );
        expect(result.exitCode).toBe(outcome === "timeout" ? 124 : outcome === "fail" ? 1 : 0);
        expect(result.output).toContain("OCX_CAPTURE_STDOUT_MARKER\n");
        expect(result.output).toContain("OCX_CAPTURE_STDERR_MARKER\n");
        // A failed Bun assertion may quote the fixture source containing the marker.
        // Count emitted marker lines, not mentions inside the error's code frame.
        expect(stdout.join("").split(/\r?\n/).filter(line => line === "OCX_CAPTURE_STDOUT_MARKER"))
          .toHaveLength(1);
        expect(stderr.join("").split(/\r?\n/).filter(line => line === "OCX_CAPTURE_STDERR_MARKER"))
          .toHaveLength(1);
        expect(result.output).toBe(stdout.join("") + "\n" + stderr.join(""));
      } finally {
        removeTreeWithRetry(root);
      }
    },
    { timeout: SPAWN_BUDGET_MS },
  );
});

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home", OCX_OWNER_REGISTRY_DIR: "/real/registry" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        OCX_OWNER_REGISTRY_DIR: join(isolated.root, ".opencodex", "ocx-homes"),
        CODEX_HOME: join(isolated.root, ".codex"),
        TEMP: join(isolated.root, "tmp"),
        TMP: join(isolated.root, "tmp"),
        TMPDIR: join(isolated.root, "tmp"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.TEMP!)).toBe(true);
      const owner = JSON.parse(readFileSync(join(isolated.root, TEST_TEMP_OWNER_FILE), "utf8"));
      // The marker stores the CANONICAL root, and this assertion has to spell it the same way.
      // Both halves of the ownership check resolve: `writeTestTempOwner` stamps
      // `realpathSync(root)` and recovery compares it against `realpathSync(candidate)`. That
      // agreement is what the reclamation decision rests on, so it is worth pinning rather than
      // assuming -- on macOS `tmpdir()` hands back a /var path that resolves to /private/var,
      // and a marker written with one spelling and read with the other would make a run fail to
      // recognise the root it just created.
      expect(owner.root).toBe(realpathSync(isolated.root));
      expect(owner).toMatchObject({
        schemaVersion: 1,
        kind: "opencodex-test-root",
        root: realpathSync(isolated.root),
        pid: process.pid,
      });
      expect(typeof owner.createdAtMs).toBe("number");
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test("drops the developer's live install credentials and keeps the rest of the environment", () => {
    const isolated = createIsolatedTestEnvironment({
      PATH: "/test/bin",
      FIXTURE: "unchanged",
      OPENCODEX_API_AUTH_TOKEN: "live-data-token",
      OPENCODEX_ADMIN_AUTH_TOKEN: "live-admin-token",
      OCX_API_TOKEN_FILE: "/real/home/.opencodex/service-api-token",
    });
    try {
      for (const name of LIVE_INSTALL_CREDENTIAL_ENV) expect(name in isolated.env).toBe(false);
      expect(isolated.env.FIXTURE).toBe("unchanged");
      expect(isolated.env.PATH).toBe("/test/bin");
    } finally {
      isolated.cleanup();
    }
  });

  test.if(process.platform === "win32")("gives the Windows sandbox a real profile shape", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "C:\\test\\bin" });
    try {
      expect(existsSync(join(isolated.root, "AppData", "Local"))).toBe(true);
      expect(existsSync(join(isolated.root, "AppData", "Roaming"))).toBe(true);
    } finally {
      isolated.cleanup();
    }
  });

  // The bug this pins: .NET's known-folder API resolves against USERPROFILE and returns an
  // EMPTY STRING — not an error — for a folder that does not exist. With the sandbox missing
  // AppData, `resolveWindowsRuntimeRoot` refused every Codex coordinator lookup with "Windows
  // effective-account lookup returned an empty value", and each refusal surfaced as an
  // unrelated assertion in whichever suite touched a Codex home.
  test.if(process.platform === "win32")(
    "keeps the .NET known-folder lookup resolvable inside the sandbox",
    () => {
      const isolated = createIsolatedTestEnvironment();
      try {
        const command = windowsIdentityPowerShellCommandForTests(
          "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
        );
        const result = Bun.spawnSync(command, {
          ...windowsIdentityPowerShellSpawnOptionsForTests(),
          env: { ...process.env, USERPROFILE: isolated.root, HOME: isolated.root },
        });

        expect(result.exitCode).toBe(0);
        const localAppData = decodeWindowsIdentityPowerShellOutputForTests(
          result.stdout ?? new Uint8Array(),
        );
        expect(localAppData).not.toBe("");
        expect(isAbsolute(localAppData)).toBe(true);
        expect(localAppData.toLowerCase()).toStartWith(isolated.root.toLowerCase());
      } finally {
        isolated.cleanup();
      }
    },
  );
});

describe("test runner transpiler cache isolation", () => {
  test("places the default executable cache inside its owned sandbox", () => {
    const isolated = createIsolatedTestEnvironment({});
    try {
      const cache = isolated.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!;
      expect(cache).toBe(join(isolated.root, "bun-transpiler-cache"));
      const entry = lstatSync(cache);
      expect(entry.isDirectory()).toBe(true);
      expect(entry.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") {
        expect(entry.uid).toBe(process.geteuid!());
        expect(entry.mode & 0o777).toBe(0o700);
        expect(lstatSync(isolated.root).mode & 0o777).toBe(0o700);
      }
    } finally { isolated.cleanup(); }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test("independent sandboxes neither reuse nor remove another default cache", () => {
    const first = createIsolatedTestEnvironment({});
    const second = createIsolatedTestEnvironment({});
    try {
      const firstCache = first.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!;
      const secondCache = second.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!;
      expect(firstCache).not.toBe(secondCache);
      writeFileSync(join(firstCache, "fixture"), "first");
      writeFileSync(join(secondCache, "fixture"), "second");
      first.cleanup();
      expect(existsSync(firstCache)).toBe(false);
      expect(readFileSync(join(secondCache, "fixture"), "utf8")).toBe("second");
    } finally { first.cleanup(); second.cleanup(); }
  });

  test("nested home isolation inherits the parent's cache and leaves its lifetime to the owner", () => {
    const parent = createIsolatedTestEnvironment({});
    const child = createIsolatedTestEnvironment(parent.env);
    try {
      const cache = parent.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!;
      expect(child.root).not.toBe(parent.root);
      expect(child.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(cache);
      writeFileSync(join(cache, "fixture"), "parent-owned");
      child.cleanup();
      expect(readFileSync(join(cache, "fixture"), "utf8")).toBe("parent-owned");
    } finally { child.cleanup(); parent.cleanup(); }
  });

  test("keeps an explicit cache path without creating or reclaiming it", () => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-cache-override-"));
    const override = join(fixture, "operator-selected");
    const isolated = createIsolatedTestEnvironment({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: override });
    try {
      expect(isolated.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(override);
      expect(existsSync(override)).toBe(false);
      expect(existsSync(join(isolated.root, "bun-transpiler-cache"))).toBe(false);
      mkdirSync(override);
      writeFileSync(join(override, "fixture"), "operator-owned");
      isolated.cleanup();
      expect(readFileSync(join(override, "fixture"), "utf8")).toBe("operator-owned");
    } finally { isolated.cleanup(); removeTreeWithRetry(fixture); }
  });

  test.each(["", "0"])("preserves cache-disable value %j without allocating a default cache", value => {
    const isolated = createIsolatedTestEnvironment({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: value });
    try {
      expect(isolated.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(value);
      expect(existsSync(join(isolated.root, "bun-transpiler-cache"))).toBe(false);
    } finally { isolated.cleanup(); }
  });

  test.each(["directory", "symlink"])("does not adopt or alter a pre-existing shared cache %s", kind => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-cache-legacy-"));
    const legacy = join(fixture, "ocx-test-bun-transpiler-cache");
    const target = join(fixture, "foreign-cache");
    mkdirSync(target);
    writeFileSync(join(target, "fixture"), "leave-unchanged");
    if (kind === "symlink") symlinkSync(target, legacy, process.platform === "win32" ? "junction" : "dir");
    else { mkdirSync(legacy); writeFileSync(join(legacy, "fixture"), "leave-unchanged"); }
    const before = lstatSync(legacy);
    const oldEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    let isolated: ReturnType<typeof createIsolatedTestEnvironment> | undefined;
    try {
      process.env.TMPDIR = fixture; process.env.TMP = fixture; process.env.TEMP = fixture;
      isolated = createIsolatedTestEnvironment({});
      expect(dirname(isolated.root)).toBe(fixture);
      expect(isolated.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(join(isolated.root, "bun-transpiler-cache"));
      isolated.cleanup();
      expect(readFileSync(join(legacy, "fixture"), "utf8")).toBe("leave-unchanged");
      expect(lstatSync(legacy).ino).toBe(before.ino);
      expect(lstatSync(legacy).mode).toBe(before.mode);
      expect(lstatSync(legacy).isSymbolicLink()).toBe(kind === "symlink");
    } finally {
      isolated?.cleanup();
      for (const [name, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      removeTreeWithRetry(fixture);
    }
  });

  test("Bun children with different homes reuse only the selected private cache", () => {
    const isolated = createIsolatedTestEnvironment({ ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: undefined });
    try {
      const cache = isolated.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!;
      const source = join(isolated.root, "cacheable-fixture.ts");
      // Above the pinned Bun runtime's cache threshold; no production code or credential is loaded.
      writeFileSync(source, `const value: string = ${JSON.stringify("x".repeat(70_000))}; console.log(value.length);`);
      // A hit only reads; a miss for the identical input must add or rewrite an entry. Seal the
      // first home's entries at a sentinel mtime, then the second home proves reuse by adding
      // nothing, rewriting nothing, and leaving no cache anywhere else in the sandbox.
      const sealedAt = new Date("2001-01-01T00:00:00Z");
      const sandboxPiles = () => readdirSync(isolated.root, { recursive: true })
        .map(String)
        .filter(entry => entry.endsWith(".pile"))
        .sort();
      let sealed: string[] | undefined;
      for (const name of ["first-home", "second-home"]) {
        const home = join(isolated.root, name);
        mkdirSync(home);
        const child = Bun.spawnSync([process.execPath, source], {
          cwd: isolated.root,
          env: { ...isolated.env, HOME: home, USERPROFILE: home },
          stdout: "pipe", stderr: "pipe", timeout: SPAWN_BUDGET_MS,
        });
        expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
        expect(new TextDecoder().decode(child.stdout).trim()).toBe("70000");
        expect(readdirSync(home)).toEqual([]);
        const piles = sandboxPiles();
        if (sealed === undefined) {
          expect(piles.length).toBeGreaterThan(0);
          for (const entry of piles) {
            const file = join(isolated.root, entry);
            expect(pathIsContainedBy(cache, file, process.platform === "win32" ? "win32" : "posix"))
              .toBe(true);
            utimesSync(file, sealedAt, sealedAt);
          }
          sealed = piles;
        } else {
          expect(piles).toEqual(sealed);
          for (const entry of sealed) {
            expect(statSync(join(isolated.root, entry)).mtimeMs).toBe(sealedAt.getTime());
          }
        }
      }
      expect(dirname(cache)).toBe(isolated.root);
    } finally { isolated.cleanup(); }
  }, { timeout: SPAWN_BUDGET_MS * 3 });
});

describe("Windows test TEMP recovery", () => {
  const age = (path: string, milliseconds: number) => {
    const date = new Date(milliseconds);
    utimesSync(path, date, date);
  };

  /** Stamp a candidate the way `writeTestTempOwner` does, then age the marker and the directory. */
  const ownRoot = (path: string, createdAtMs: number, pid = 4_294_967_295) => {
    writeFileSync(join(path, TEST_TEMP_OWNER_FILE), JSON.stringify({
      schemaVersion: 1,
      kind: "opencodex-test-root",
      root: realpathSync(path),
      createdAtMs,
      pid,
    }) + "\n");
    age(join(path, TEST_TEMP_OWNER_FILE), createdAtMs);
    age(path, createdAtMs);
  };

  test("removes a root it can prove it owns and leaves an unstamped look-alike alone", () => {
    // The distinction this pins is the whole safety property: reclamation is decided by the
    // ownership marker, never by the name. The thousands of directories already sitting in a
    // user's TEMP were written by versions that stamped nothing, so they are scanned, skipped,
    // and left for the user to clear. This release changes future runs.
    const tempRoot = mkdtempSync(join(tmpdir(), "opencodex-recovery-fixture-"));
    const nowMs = Date.now();
    const stale = nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000;
    const owned = join(tempRoot, "opencodex-test-Ab12Cd");
    const unstamped = join(tempRoot, "opencodex-test-Zx98Yw");
    const young = join(tempRoot, "opencodex-test-Qq11Ww");
    const legacyName = join(tempRoot, "ocx-runtime-Rr22Tt");
    const unrelated = join(tempRoot, "application-cache-Ab12Cd");
    for (const path of [owned, unstamped, young, legacyName, unrelated]) mkdirSync(path);
    ownRoot(owned, stale);
    ownRoot(young, nowMs - TEST_TEMP_RECOVERY_AGE_MS + 60_000);
    age(unstamped, stale);
    age(legacyName, stale);
    age(unrelated, stale);

    try {
      const result = recoverStaleTestTempArtifacts({
        tempRoot,
        platform: "win32",
        nowMs,
        processIsAlive: () => false,
      });
      // Only the three `opencodex-test-*` names are candidates at all; the legacy `ocx-*` shape
      // never carried a marker, so widening the scan to it could only ever produce skips.
      expect(result).toMatchObject({ scanned: 3, removed: 1, skipped: 2, errors: 0 });
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(unstamped)).toBe(true);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(legacyName)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      removeTreeWithRetry(tempRoot);
    }
  });

  test("fails closed for invalid ownership metadata and linked trees", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "opencodex-recovery-fixture-"));
    const nowMs = Date.now();
    const invalidOwner = join(tempRoot, "opencodex-test-Aa11Bb");
    const linked = join(tempRoot, "opencodex-test-Cc22Dd");
    const liveOwner = join(tempRoot, "opencodex-test-Ee33Ff");
    const linkTarget = join(tempRoot, "link-target");
    mkdirSync(invalidOwner);
    mkdirSync(linked);
    mkdirSync(liveOwner);
    mkdirSync(linkTarget);
    writeFileSync(join(invalidOwner, TEST_TEMP_OWNER_FILE), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(join(liveOwner, TEST_TEMP_OWNER_FILE), JSON.stringify({
      schemaVersion: 1,
      kind: "opencodex-test-root",
      root: realpathSync(liveOwner),
      createdAtMs: nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000,
      pid: process.pid,
    }));
    symlinkSync(linkTarget, join(linked, "redirect"), process.platform === "win32" ? "junction" : "dir");
    // Stamped and long dead, so the only thing left to refuse it is the link in its tree.
    ownRoot(linked, nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000);
    age(invalidOwner, nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000);
    age(join(liveOwner, TEST_TEMP_OWNER_FILE), nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000);
    age(liveOwner, nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000);

    try {
      const result = recoverStaleTestTempArtifacts({
        tempRoot,
        platform: "win32",
        nowMs,
        processIsAlive: pid => pid === process.pid,
      });
      expect(result).toMatchObject({ scanned: 3, removed: 0, skipped: 3, errors: 0 });
      expect(existsSync(invalidOwner)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(liveOwner)).toBe(true);
      expect(existsSync(linkTarget)).toBe(true);
    } finally {
      removeTreeWithRetry(tempRoot);
    }
  });

  test("bounds recovery and leaves remaining candidates for a later run", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "opencodex-recovery-fixture-"));
    const nowMs = Date.now();
    for (const name of ["opencodex-test-Aa11Bb", "opencodex-test-Cc22Dd"]) {
      const path = join(tempRoot, name);
      mkdirSync(path);
      ownRoot(path, nowMs - TEST_TEMP_RECOVERY_AGE_MS - 1_000);
    }

    try {
      const result = recoverStaleTestTempArtifacts({
        tempRoot,
        platform: "win32",
        nowMs,
        maxCandidates: 1,
        processIsAlive: () => false,
      });
      expect(result).toMatchObject({ scanned: 1, removed: 1, errors: 0, truncated: true });
      expect(readdirSync(tempRoot)).toHaveLength(1);
    } finally {
      removeTreeWithRetry(tempRoot);
    }
  });

  test("retries transient release races and preserves terminal failures", () => {
    let attempts = 0;
    const sleeps: number[] = [];
    removeTestTempTree("fixture", {
      delays: [7, 7],
      remove: () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      sleep: milliseconds => { sleeps.push(milliseconds); },
    });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([7, 7]);
    expect(() => removeTestTempTree("fixture", {
      remove: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    })).toThrow("denied");
  });
});

/**
 * Without `--parallel`, `--isolate` re-evaluates the module graph once per file on a single
 * core. Past ~900 files that stops reading as slow and starts reading as hung: measured at
 * 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS. Four workers keep the suite inside a
 * few minutes without the deadline-sensitive failures observed when Bun selected all ten cores.
 * These pin the argv so the bound cannot be dropped again silently.
 */
describe("bun test argv", () => {
  test("a filter-less run gets isolate, bounded parallelism and the suite path", () => {
    expect(resolveBunTestArgs([])).toEqual(["--isolate", "--parallel=4", "./tests/"]);
  });

  test("the full suite keeps official isolation and desktop SQLite writers outside the main pool", () => {
    const files = [
      "codex-integration/codex-shim.test.ts",
      "providers/cursor/cursor-native-exec-shell.test.ts",
      "codex-integration/issue-452-empty-503.test.ts",
      "adapters/openai/openai-provider-option-e2e.test.ts",
      "ci-workflows/ci-gui-typecheck-gate.test.ts",
      "ci-workflows/release-helper.test.ts",
      "ci-workflows/structure-ssot.test.ts",
      "codex-integration/codex-inject-write-lock.test.ts",
      "routing/subagent-roster-retention.test.ts",
      "codex-integration/active-registry-admission.test.ts",
      "update/update-stop-first.test.ts",
      "server/server-live.test.ts",
      "service/service-ownership-state.test.ts",
      "service/service-sqlite-home.test.ts",
      "service/service.test.ts",
      "service/service-claim.test.ts",
      "service/service-wsl-home-ownership.test.ts",
      "service/launchd-repair.test.ts",
      "cli/cli-update-restart-home.test.ts",
      "codex-integration/native-codex-toggle.test.ts",
      "codex-integration/native-grok-toggle.test.ts",
      "claude-integration/claude-desktop-picker-routes.test.ts",
      "claude-integration/claude-desktop-picker-profile.test.ts",
      "claude-integration/claude-desktop-first-party.test.ts",
      "claude-integration/claude-desktop-first-party-guards.test.ts",
    ];
    const plan = resolveBunTestPlan([]);
    expect(plan[0]!.args.slice(0, 2)).toEqual(["--isolate", "--parallel=4"]);
    expect(plan[0]!.args.at(-1)).toBe("./tests/");
    expect(plan[0]!.timeoutMs).toBe(900_000);
    expect(plan.slice(1).map(lane => lane.args.at(-1))).toEqual(files.map(file => "./tests/" + file));
    for (const file of files) {
      const index = plan[0]!.args.indexOf("**/" + basename(file));
      expect(plan[0]!.args[index - 1]).toBe("--path-ignore-patterns");
      const lane = plan.find(entry => entry.label === basename(file))!;
      expect(lane.args).toEqual(["--isolate", "--parallel=1", "./tests/" + file]);
      expect(lane.timeoutMs).toBe(basename(file) === "release-helper.test.ts" ? 300_000 : 180_000);
    }
  });

  test("the default full suite schedules each isolated test path once", () => {
    const lanes = resolveBunTestPlan([]).slice(1);
    const paths = lanes.map(lane => lane.args.at(-1));
    expect(paths).toEqual([...new Set(paths)]);
    const referencePath = "./tests/codex-integration/codex-shim.test.ts";
    const referenceLane = lanes.find(lane => lane.args.includes(referencePath));
    expect(referenceLane).toBeDefined();
    for (const path of [
      "./tests/service/service-claim.test.ts",
      "./tests/service/service-wsl-home-ownership.test.ts",
    ]) {
      const lane = lanes.find(entry => entry.args.includes(path));
      expect(lane?.args.slice(0, -1)).toEqual(referenceLane!.args.slice(0, -1));
      expect(lane?.args.at(-1)).toBe(path);
      expect(lane?.timeoutMs).toBe(referenceLane!.timeoutMs);
    }
  });

  test("a control budget is bounded and changes only the main lane", () => {
    const baseline = resolveBunTestPlan([], undefined, {});
    expect(baseline[0]!.timeoutMs).toBe(900_000);
    const control = resolveBunTestPlan([], undefined, { OCX_TEST_MAIN_TIMEOUT_MS: "3600000" });
    expect(control[0]!.timeoutMs).toBe(3_600_000);
    expect(control.slice(1)).toEqual(baseline.slice(1));
    for (const value of ["", "-1", "59999", "3600001", "Infinity", "1e6", "900000.5"]) {
      expect(() => resolveBunTestPlan([], undefined, { OCX_TEST_MAIN_TIMEOUT_MS: value })).toThrow("OCX_TEST_MAIN_TIMEOUT_MS");
    }
  });

  test("server admission fixtures finish in a dedicated process", () => {
    const plan = resolveBunTestPlan([]);
    expect(plan[0]?.args).toContain("**/active-registry-admission.test.ts");
    expect(plan.find(lane => lane.label === "active-registry-admission.test.ts")?.args).toEqual([
      "--isolate", "--parallel=1", "./tests/codex-integration/active-registry-admission.test.ts",
    ]);
  });

  test("serial lanes override caller parallelism without changing the main lane", () => {
    const plan = resolveBunTestPlan(["--parallel=2", "--dots"]);
    expect(plan[0]?.args).toContain("--parallel=2");
    for (const lane of plan.slice(1)) {
      expect(lane.args).toContain("--parallel=1");
      expect(lane.args).not.toContain("--parallel=2");
      expect(lane.args).toContain("--dots");
    }
  });

  test("sharded and reporter-file runs stay a single caller-controlled lane", () => {
    expect(resolveBunTestPlan(["--shard=1/3"])).toHaveLength(1);
    expect(resolveBunTestPlan(["--reporter=junit", "--reporter-outfile", "results.xml"]))
      .toHaveLength(1);
  });

  test("a file filter keeps isolate and bounded parallelism but no suite path", () => {
    expect(resolveBunTestArgs(["tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["-"]))
      .toEqual(["--isolate", "--parallel=4", "-"]);
  });

  test("a caller-supplied concurrency is left alone", () => {
    expect(resolveBunTestArgs(["--parallel=2"]))
      .toEqual(["--isolate", "--parallel=2", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel"]))
      .toEqual(["--isolate", "--parallel", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--parallel=2", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=2", "tests/foo.test.ts"]);
  });

  test("option-only arguments still count as a full suite run", () => {
    expect(resolveBunTestArgs(["--timeout=30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout=30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--timings", ".bun-test-timings/current.json"]))
      .toEqual([
        "--isolate",
        "--parallel=4",
        "--timings",
        ".bun-test-timings/current.json",
        "./tests/",
      ]);
    for (const configFlag of ["-c", "--config"]) {
      expect(resolveBunTestArgs([configFlag, "ci.bunfig.toml"]))
        .toEqual(["--isolate", "--parallel=4", configFlag, "ci.bunfig.toml", "./tests/"]);
    }
    expect(resolveBunTestArgs(["-t", "serial test"])).toEqual([
      "--isolate",
      "--parallel=4",
      "-t",
      "serial test",
      "./tests/",
    ]);
  });

  test("arguments after the delimiter are passed through instead of parsed as wrapper flags", () => {
    expect(resolveBunTestArgs(["--", "--parallel=2"]))
      .toEqual(["--isolate", "--parallel=4", "--", "--parallel=2"]);
    const mergeBase = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveBunTestArgs(["--", "--changed=fixture"], mergeBase))
      .toEqual(["--isolate", "--parallel=4", "--", "--changed=fixture"]);
    expect(inspectChangedRun(["--", "--changed=fixture"])).toBeNull();
  });

  test("changed-mode stays explicitly filtered without redundant arguments", () => {
    expect(resolveBunTestArgs(["--changed=dev"]))
      .toEqual(["--isolate", "--parallel=4", "--changed=dev"]);
    const mergeBase = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveBunTestArgs(["--changed=dev"], mergeBase))
      .toEqual(["--isolate", "--parallel=4", "--changed=" + mergeBase]);
    const plan = resolveBunTestPlan(["--changed=dev"], mergeBase);
    expect(plan).toHaveLength(26);
    expect(plan[0]!.args).toContain("--parallel=4");
    expect(plan[0]!.timeoutMs).toBe(900_000);
    for (const file of SERIAL_FULL_SUITE_FILES) {
      expect(plan[0]!.args).toContain(`**/${basename(file)}`);
      expect(plan.find(lane => lane.label === basename(file))!.args).toEqual([
        "--isolate", "--parallel=1", "--changed=" + mergeBase, `./tests/${file}`,
      ]);
    }
  });

  test("changed lanes preserve explicit filters and unsupported split options", () => {
    for (const args of [
      ["tests/service/"], ["--parallel", "tests/service/service.test.ts"],
      ["--shard=1/3"], ["--reporter=junit", "--reporter-outfile", "results.xml"],
      ["--update-timings"], ["--", "--parallel=2"], ["--"],
      ["--path-ignore-patterns", "**/service-claim.test.ts"], ["--", "--changed=other"],
    ]) {
      const requested = ["--changed=HEAD", ...args];
      expect(resolveBunTestPlan(requested)).toEqual([
        { label: "suite", args: resolveBunTestArgs(requested), timeoutMs: 900_000 },
      ]);
    }
    expect(resolveBunTestPlan(["--changed"])).toHaveLength(1);
    const plan = resolveBunTestPlan(["--changed=HEAD", "--parallel=2", "-t", "chosen case"]);
    expect(plan[0]!.args).toContain("--parallel=2");
    for (const lane of plan.slice(1)) {
      expect(lane.args).toContain("--parallel=1");
      expect(lane.args).not.toContain("--parallel=2");
      expect(lane.args).toContain("chosen case");
    }
  });

  test.each(["--parallel=2", "./tests/", "--no-isolate"])("changed lanes preserve the literal option value %s", value => {
    const requested = ["--changed=HEAD", "-t", value];
    const plan = resolveBunTestPlan(requested, "fixed-sha");
    expect(plan[0]!.args[plan[0]!.args.indexOf("-t") + 1]).toBe(value);
    for (const lane of plan.slice(1)) {
      const index = lane.args.indexOf("-t");
      expect(lane.args[index + 1]).toBe(value);
    }
  });

  test("changed lanes let Bun select only changed sensitive fixtures", () => {
    const { cwd, base } = initChangedRunFixture();
    const isolated = createIsolatedTestEnvironment();
    try {
      mkdirSync(join(cwd, "tests", "claude-integration"), { recursive: true });
      for (const name of ["claude-desktop-picker-routes", "claude-desktop-first-party-guards"]) {
        commitFixture(cwd, `tests/claude-integration/${name}.test.ts`,
          `import { test } from "bun:test"; test("${name}", () => console.log("EXECUTED_${name}"));\n`, name);
      }
      commitFixture(cwd, "tests/ordinary.test.ts",
        'import { test } from "bun:test"; test("ordinary", () => console.log("UNRELATED_ORDINARY"));\n', "ordinary");
      const comparisonCommit = runGit(cwd, "rev-parse", "HEAD");
      writeFileSync(join(cwd, "tests/claude-integration/claude-desktop-picker-routes.test.ts"),
        readFileSync(join(cwd, "tests/claude-integration/claude-desktop-picker-routes.test.ts"), "utf8") + "// changed\n");
      const driver = `import {resolveBunTestPlan} from ${JSON.stringify(repoPath("scripts", "test.ts"))}; console.log(JSON.stringify(resolveBunTestPlan([${JSON.stringify("--changed=" + base)}],${JSON.stringify(comparisonCommit)})));`;
      const planned = Bun.spawnSync([process.execPath, "-e", driver], { cwd, env: isolated.env, stdout: "pipe", stderr: "pipe" });
      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout.toString()) as ReturnType<typeof resolveBunTestPlan>;
      expect(plan.map(lane => lane.label)).toEqual(["parallel suite", "claude-desktop-picker-routes.test.ts", "claude-desktop-first-party-guards.test.ts"]);
      const lanes = plan;
      let output = "";
      const diagnostics: string[] = [];
      for (const lane of lanes) {
        const result = Bun.spawnSync([process.execPath, "test", ...lane.args], {
          cwd, env: { ...isolated.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
        });
        const diagnostic = changedFixtureDiagnostic(result, lane.args, cwd);
        diagnostics.push(diagnostic);
        if (result.exitCode !== 0) console.error(diagnostic);
        expect(result.exitCode).toBe(0);
        const text = result.stdout.toString() + result.stderr.toString();
        if (lane === plan[0]) expect(text).not.toContain("EXECUTED_claude-desktop-picker-routes");
        output += text;
      }
      const executed = output.match(/^EXECUTED_claude-desktop-picker-routes$/gm);
      if (executed?.length !== 1) console.error(diagnostics.join("\n"));
      expect(executed).toHaveLength(1);
      expect(output).not.toContain("EXECUTED_claude-desktop-first-party-guards");
      expect(output).not.toContain("UNRELATED_ORDINARY");
      expect(changedSelectionFailure({ comparisonRef: "fixture", comparisonCommit, changedFiles: ["tests/claude-integration/claude-desktop-picker-routes.test.ts"] }, output)).toBeNull();
    } finally {
      isolated.cleanup();
      removeTreeWithRetry(cwd);
    }
  }, { timeout: 35_000 });

  test("changed-mode prefers the first existing conventional dev ref", () => {
    const selectFrom = (...existing: string[]) => {
      const probed: string[] = [];
      const selected = selectChangedComparisonRef(ref => {
        probed.push(ref);
        return existing.includes(ref);
      });
      return { selected, probed };
    };

    expect(selectFrom("upstream/dev", "origin/dev", "dev")).toEqual({
      selected: "upstream/dev",
      probed: ["upstream/dev"],
    });
    expect(selectFrom("origin/dev", "dev")).toEqual({
      selected: "origin/dev",
      probed: ["upstream/dev", "origin/dev"],
    });
    expect(selectFrom("dev")).toEqual({
      selected: "dev",
      probed: ["upstream/dev", "origin/dev", "dev"],
    });
    expect(selectFrom()).toEqual({
      selected: null,
      probed: ["upstream/dev", "origin/dev", "dev"],
    });
  });

  test("changed-mode requires an explicit, resolvable comparison ref", () => {
    expect(() => inspectChangedRun(["--changed"])).toThrow("requires an explicit comparison ref");
    expect(() => inspectChangedRun(["--changed=refs/heads/definitely-missing-test-ref"]))
      .toThrow("does not resolve to a commit");
    const inspected = inspectChangedRun(["--changed=HEAD"]);
    expect(inspected?.comparisonRef).toBe("HEAD");
    expect(inspected?.comparisonCommit).toBe(runGit(process.cwd(), "rev-parse", "HEAD"));
  });

  test("changed-mode uses the shared merge base for behind, ahead, and diverged refs", () => {
    const fixtures: string[] = [];
    try {
      const behind = initChangedRunFixture();
      fixtures.push(behind.cwd);
      runGit(behind.cwd, "branch", "candidate", behind.base);
      commitFixture(behind.cwd, "head.txt", "head\n", "head ahead of candidate");
      expect(inspectChangedRun(["--changed=candidate"], behind.cwd)).toMatchObject({
        comparisonRef: "candidate",
        comparisonCommit: behind.base,
        changedFiles: ["head.txt"],
      });

      const ahead = initChangedRunFixture();
      fixtures.push(ahead.cwd);
      const candidateTip = commitFixture(ahead.cwd, "candidate.txt", "candidate\n", "candidate ahead");
      runGit(ahead.cwd, "branch", "candidate", candidateTip);
      runGit(ahead.cwd, "checkout", "--quiet", "--detach", ahead.base);
      expect(inspectChangedRun(["--changed=candidate"], ahead.cwd)).toMatchObject({
        comparisonRef: "candidate",
        comparisonCommit: ahead.base,
        changedFiles: [],
      });

      const diverged = initChangedRunFixture();
      fixtures.push(diverged.cwd);
      runGit(diverged.cwd, "checkout", "--quiet", "-b", "candidate");
      commitFixture(diverged.cwd, "candidate.txt", "candidate\n", "candidate side");
      runGit(diverged.cwd, "checkout", "--quiet", "--detach", diverged.base);
      commitFixture(diverged.cwd, "head.txt", "head\n", "head side");
      expect(inspectChangedRun(["--changed=candidate"], diverged.cwd)).toMatchObject({
        comparisonRef: "candidate",
        comparisonCommit: diverged.base,
        changedFiles: ["head.txt"],
      });
    } finally {
      for (const fixture of fixtures) removeTreeWithRetry(fixture);
    }
  });

  test("rejects an empty changed selection when the diff is non-empty", () => {
    expect(changedSelectionFailure(
      { comparisonRef: "upstream/dev", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] },
      "Ran 0 tests across 0 files.",
    )).toContain("--changed=base-sha (upstream/dev merge base) selected 0 tests across 0 files");
    expect(changedSelectionFailure(
      { comparisonRef: "dev", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] },
      "Ran 9 tests across 1 file.",
    )).toBeNull();
    expect(changedSelectionFailure(
      { comparisonRef: "HEAD", comparisonCommit: "head-sha", changedFiles: [] },
      "Ran 0 tests across 0 files.",
    )).toBeNull();
  });

  test("rejects an unrecognized changed-mode summary for a non-empty diff", () => {
    expect(changedSelectionFailure(
      { comparisonRef: "dev", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] },
      "0 pass\n0 fail",
    )).toContain("did not emit a recognizable selection summary");
  });

  test("changed coverage accepts a later nonempty lane and rejects all empty lanes", () => {
    const preflight = { comparisonRef: "fixture", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] };
    expect(changedSelectionFailure(preflight, "Ran 0 tests across 0 files.\nRan 9 tests across 1 file.\nRan 0 tests across 0 files.")).toBeNull();
    expect(changedSelectionFailure(preflight, "Ran 0 tests across 0 files.\nRan 0 tests across 0 files.")).toContain("selected 0 tests");
    expect(changedSelectionFailure(preflight, "lane without summary\nlane without summary")).toContain("recognizable selection summary");
  });

  test("the wrapper passes parallel execution through to bun without leaving TEMP roots", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "opencodex-test-runner-"));
    const sentinelTemp = join(fixtureRoot, "sentinel-temp");
    const fixturePath = join(fixtureRoot, "parallel-smoke.test.ts");
    const markerPath = join(fixtureRoot, "executed.marker");
    mkdirSync(sentinelTemp);
    writeFileSync(
      fixturePath,
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("smoke", () => writeFileSync(${JSON.stringify(markerPath)}, "executed"));\n`,
    );
    try {
      const result = Bun.spawnSync([
        process.execPath,
        repoPath("scripts", "test.ts"),
        fixturePath,
      ], {
        cwd: repoRoot(),
        env: {
          ...process.env,
          TEMP: sentinelTemp,
          TMP: sentinelTemp,
          TMPDIR: sentinelTemp,
          OCX_TEST_NO_QUEUE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = new TextDecoder().decode(result.stdout)
        + new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(output).toContain("PARALLEL");
      expect(existsSync(markerPath)).toBe(true);
      expect(readdirSync(sentinelTemp)).toEqual([]);
    } finally {
      removeTreeWithRetry(fixtureRoot);
    }
  }, { timeout: SPAWN_BUDGET_MS });

  test.each(["pass", "fail"] as const)(
    "a bare %s run removes its preload-owned TEMP root",
    outcome => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "opencodex-bare-test-runner-"));
      const sentinelTemp = join(fixtureRoot, "sentinel-temp");
      const fixturePath = join(fixtureRoot, "bare-smoke.test.ts");
      mkdirSync(sentinelTemp);
      writeFileSync(
        fixturePath,
        `import { test } from "bun:test"; test("smoke", () => { ${outcome === "fail" ? 'throw new Error("expected fixture failure");' : ""} });\n`,
      );
      try {
        const result = Bun.spawnSync([process.execPath, "test", "--parallel=1", fixturePath], {
          cwd: repoRoot(),
          env: {
            ...process.env,
            TEMP: sentinelTemp,
            TMP: sentinelTemp,
            TMPDIR: sentinelTemp,
            OCX_TEST_NO_QUEUE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        expect(result.exitCode).toBe(outcome === "pass" ? 0 : 1);
        expect(readdirSync(sentinelTemp)).toEqual([]);
      } finally {
        removeTreeWithRetry(fixtureRoot);
      }
    },
    { timeout: SPAWN_BUDGET_MS },
  );
});

describe("bun test user lock", () => {
  // Lock behavior must not inherit a workflow-level opt-out. The Windows batch leg
  // intentionally sets OCX_TEST_NO_QUEUE for its outer processes, while these unit
  // cases exercise the queued implementation itself.
  const queuedTestEnv: NodeJS.ProcessEnv = {};

  test("distinct POSIX users receive distinct temp-runtime locks", () => {
    const common = { env: {}, tempDir: "/tmp", hostName: "builder-1", platform: "linux" as const };
    const alice = resolveDefaultTestRunLockPath({
      ...common,
      uid: 1001,
      fileSystem: acceptingRuntimeFileSystem(1001),
    });
    const bob = resolveDefaultTestRunLockPath({
      ...common,
      uid: 1002,
      fileSystem: acceptingRuntimeFileSystem(1002),
    });

    expect(alice).not.toBe(bob);
    expect(pathIsContainedBy("/tmp/opencodex-test-runtime-1001", alice, "posix")).toBe(true);
    expect(pathIsContainedBy("/tmp/opencodex-test-runtime-1002", bob, "posix")).toBe(true);
  });

  test("a shared home cannot couple locks from distinct hosts", () => {
    const common = {
      env: { HOME: "/network/users/alice" },
      uid: 1001,
      tempDir: "/tmp",
      platform: "linux" as const,
      fileSystem: acceptingRuntimeFileSystem(1001),
    };
    const firstHost = resolveDefaultTestRunLockPath({ ...common, hostName: "builder-1" });
    const secondHost = resolveDefaultTestRunLockPath({ ...common, hostName: "builder-2" });

    expect(firstHost).not.toBe(secondHost);
    expect(pathIsContainedBy(common.env.HOME, firstHost, "posix")).toBe(false);
    expect(pathIsContainedBy(common.env.HOME, secondHost, "posix")).toBe(false);
  });

  test("Windows scopes the lock to the effective SID runtime and hardens its directory", () => {
    const hardened: string[] = [];
    const common = {
      platform: "win32" as const,
      tempDir: "C:\\Windows\\Temp",
      hostName: "desktop-1",
      fileSystem: acceptingRuntimeFileSystem(0),
      resolveRuntimeRoot: (identity: { platform: "win32"; sid: string }) =>
        `C:\\Runtime\\${identity.sid}`,
      hardenWindowsDirectory: (path: string) => { hardened.push(path); },
    };
    const alice = resolveDefaultTestRunLockPath({
      ...common,
      env: {},
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
    });
    const aliceWithHostileEnvironment = resolveDefaultTestRunLockPath({
      ...common,
      env: {
        USER: "someone-else",
        USERNAME: "someone-else",
        USERDOMAIN: "hostile",
        TEMP: "C:\\Windows\\Temp",
        TMP: "C:\\Windows\\Temp",
        LOCALAPPDATA: "C:\\Windows\\Temp",
      },
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
    });
    const bob = resolveDefaultTestRunLockPath({
      ...common,
      env: {},
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1002" }),
    });

    expect(aliceWithHostileEnvironment).toBe(alice);
    expect(bob).not.toBe(alice);
    expect(pathIsContainedBy("C:\\Runtime\\S-1-5-21-1001\\bun-test-locks", alice, "win32"))
      .toBe(true);
    expect(pathIsContainedBy(common.tempDir, alice, "win32")).toBe(false);
    expect(hardened).toEqual([
      "C:\\Runtime\\S-1-5-21-1001\\bun-test-locks",
      "C:\\Runtime\\S-1-5-21-1001\\bun-test-locks",
      "C:\\Runtime\\S-1-5-21-1002\\bun-test-locks",
    ]);
  });

  test("rejects a group-writable XDG root in favor of the private UID fallback", () => {
    const xdg = "/run/user/1001";
    const fallback = "/tmp/opencodex-test-runtime-1001";
    const lockPath = resolveDefaultTestRunLockPath({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: xdg },
      uid: 1001,
      tempDir: "/tmp",
      hostName: "builder-1",
      fileSystem: acceptingRuntimeFileSystem(1001, true, {
        [xdg]: 0o733,
        [fallback]: 0o700,
      }),
    });

    expect(dirname(lockPath)).toBe(fallback);
  });

  test("Windows refuses before returning a path when identity or ACL hardening fails", () => {
    const common = {
      platform: "win32" as const,
      tempDir: "C:\\Windows\\Temp",
      hostName: "desktop-1",
      fileSystem: acceptingRuntimeFileSystem(0),
    };
    expect(() => resolveDefaultTestRunLockPath({
      ...common,
      resolveIdentity: () => { throw new Error("identity unavailable"); },
    })).toThrow("the Windows effective identity is unavailable");

    expect(() => resolveDefaultTestRunLockPath({
      ...common,
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
      resolveRuntimeRoot: () => "C:\\Runtime\\S-1-5-21-1001",
      hardenWindowsDirectory: () => { throw new Error("ACL unavailable"); },
    })).toThrow("the Windows lock directory cannot be secured");
  });

  test("Windows rejects a redirected lock directory before ACL hardening", () => {
    let hardenCalls = 0;
    const fileSystem: TestRunRuntimeFileSystem = {
      lstatSync: () => ({
        uid: 0,
        mode: 0o700,
        isDirectory: () => true,
        isSymbolicLink: () => true,
      }),
      mkdirSync() {},
      accessSync() {},
    };

    expect(() => resolveDefaultTestRunLockPath({
      platform: "win32",
      hostName: "desktop-1",
      fileSystem,
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
      resolveRuntimeRoot: () => "C:\\Runtime\\S-1-5-21-1001",
      hardenWindowsDirectory: () => { hardenCalls += 1; },
    })).toThrow("is not a real directory");
    expect(hardenCalls).toBe(0);
  });

  test("Windows creates a missing lock directory before validating and hardening it", () => {
    let created = false;
    let hardenCalls = 0;
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const fileSystem: TestRunRuntimeFileSystem = {
      lstatSync: () => {
        if (!created) throw missing;
        return {
          uid: 0,
          mode: 0o700,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      },
      mkdirSync() { created = true; },
      accessSync() {},
    };

    const lockPath = resolveDefaultTestRunLockPath({
      platform: "win32",
      hostName: "desktop-1",
      fileSystem,
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
      resolveRuntimeRoot: () => "C:\\Runtime\\S-1-5-21-1001",
      hardenWindowsDirectory: () => { hardenCalls += 1; },
    });

    expect(lockPath).toContain("\\bun-test-locks\\opencodex-bun-test-");
    expect(created).toBe(true);
    expect(hardenCalls).toBe(1);
  });

  test("wrapped workers reuse one validated Windows lock path", () => {
    let identityCalls = 0;
    let runtimeRootCalls = 0;
    let hardenCalls = 0;
    const lockPath = resolveDefaultTestRunLockPath({
      platform: "win32",
      hostName: "desktop-1",
      fileSystem: acceptingRuntimeFileSystem(0),
      resolveIdentity: () => {
        identityCalls += 1;
        return { platform: "win32", sid: "S-1-5-21-1001" };
      },
      resolveRuntimeRoot: () => {
        runtimeRootCalls += 1;
        return "C:\\Runtime\\S-1-5-21-1001";
      },
      hardenWindowsDirectory: () => { hardenCalls += 1; },
    });
    const ownerToken = "57f44b0e-b750-4bd2-b23d-4a035e75da18";
    const env = {
      [TEST_RUN_LOCK_PATH_ENV]: lockPath,
      [TEST_RUN_LOCK_TOKEN_ENV]: ownerToken,
    };

    const workers = ["worker-a", "worker-b", "worker-c"].map(wrappedRunId =>
      resolveInheritedTestRunLock({
        wrappedRunId,
        env,
        platform: "win32",
        hostName: "desktop-1",
      }));

    expect(workers).toEqual([
      { lockPath, ownerToken },
      { lockPath, ownerToken },
      { lockPath, ownerToken },
    ]);
    expect(identityCalls).toBe(1);
    expect(runtimeRootCalls).toBe(1);
    expect(hardenCalls).toBe(1);
    expect(() => resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env: {},
      platform: "win32",
      hostName: "desktop-1",
    })).toThrow("capability is incomplete");
    expect(resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      platform: "win32",
      hostName: "desktop-1",
    })).toBeUndefined();
    expect(resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env,
      platform: "linux",
      hostName: "desktop-1",
    })).toBeUndefined();
    expect(() => resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env: {
        [TEST_RUN_LOCK_PATH_ENV]: "C:\\Runtime\\bun-test-locks\\wrong.lock",
        [TEST_RUN_LOCK_TOKEN_ENV]: ownerToken,
      },
      platform: "win32",
      hostName: "desktop-1",
    })).toThrow("inherited lock access");
  });

  test("the no-queue wrapper path performs no identity or runtime mutation", () => {
    let resolveCalls = 0;
    const lockPath = resolveWrappedTestRunLockPath({
      env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      resolve: () => {
        resolveCalls += 1;
        return "C:\\Runtime\\bun-test-locks\\unexpected.lock";
      },
    });

    expect(lockPath).toBeUndefined();
    expect(resolveCalls).toBe(0);
  });

  // Windows-only, and deliberately no longer gated on the no-queue opt-out. The hosted
  // batch leg sets OCX_TEST_NO_QUEUE=1 for its own six-file processes, which skipped this
  // case on the only platform it covers (#4991). The controller below holds a lock in its
  // own right rather than borrowing the lane's, so the regression now runs either way.
  //
  // Two deadlines, not one. The controller is told to finish 10s before the hard kill so
  // it always reaches its own teardown — releasing the lock and confirming its children
  // were reaped — instead of being terminated inside a spawn with the lock still held.
  // The spawnSync timeout stays the backstop for a controller that ignores its deadline.
  //
  // The nominal per-child timeout is declared here rather than inside the helper, so the
  // deadline that bounds four cold Bun starts stays with the case that owns them and
  // tests/ci-workflows/cold-spawn-warmup.test.ts keeps seeing this file. The controller
  // narrows it to whatever its own deadline still allows.
  test.if(process.platform === "win32")(
    "a nested Windows Bun test inherits the live lock its controller holds and refuses an incomplete capability",
    () => {
      const root = mkdtempSync(join(tmpdir(), "opencodex-nested-lock-"));
      const controllerBudgetMs = SPAWN_BUDGET_MS - 10_000;
      const childSpawn = { timeout: INTERNAL_DEADLINE_MS };
      const environmentBefore = JSON.stringify({
        noQueue: process.env[TEST_RUN_NO_QUEUE_ENV],
        runId: process.env[TEST_RUN_ID_ENV],
        lockPath: process.env[TEST_RUN_LOCK_PATH_ENV],
        // Presence only. The token is never rendered, here or by the controller.
        hasToken: process.env[TEST_RUN_LOCK_TOKEN_ENV] !== undefined,
      });
      try {
        // Only the controller's copy loses the opt-out, and its cwd stays outside the
        // repository so Bun loads no bunfig preload into the lock holder itself.
        const controllerEnv = { ...process.env };
        delete controllerEnv[TEST_RUN_NO_QUEUE_ENV];
        const controller = spawnSync(
          process.execPath,
          [
            helperPath("nested-test-run-lock-controller.ts"),
            root,
            String(Date.now() + controllerBudgetMs),
            JSON.stringify(childSpawn),
          ],
          { cwd: root, env: controllerEnv, encoding: "utf8", timeout: SPAWN_BUDGET_MS },
        );
        const prefix = '{"' + NESTED_LIVE_LOCK_RECEIPT_KEY + '":';
        const line = (controller.stdout ?? "").split("\n").find(entry => entry.startsWith(prefix));
        const payload = line
          ? JSON.parse(line) as { nestedLiveLockReceipt: Record<string, boolean>; diagnostics: string[] }
          : null;
        // Booleans and redacted controller notes only; raw child output never surfaces here.
        expect(payload?.diagnostics ?? ["the controller printed no receipt"]).toEqual([]);
        expect(payload?.nestedLiveLockReceipt).toEqual({
          lockHeld: true,
          healthyChildExited: true,
          healthyReceiptComplete: true,
          missingTokenRefused: true,
          wrongTokenRefused: true,
          wrongPathRefused: true,
          foreignOwnerTimedOut: true,
          foreignOwnerUntouched: true,
          ownerContentUnchanged: true,
          childrenReaped: true,
          releasedOnlyOwnLock: true,
          receiptRedacted: true,
        });
        expect(controller.status).toBe(0);
        expect(JSON.stringify({
          noQueue: process.env[TEST_RUN_NO_QUEUE_ENV],
          runId: process.env[TEST_RUN_ID_ENV],
          lockPath: process.env[TEST_RUN_LOCK_PATH_ENV],
          hasToken: process.env[TEST_RUN_LOCK_TOKEN_ENV] !== undefined,
        })).toBe(environmentBefore);
      } finally {
        removeTreeWithRetry(root);
      }
    },
    { timeout: SPAWN_BUDGET_MS },
  );

  test("falls back from an unsafe XDG root to a validated mode-0700 UID directory", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const root = mkdtempSync(join(tmpdir(), "opencodex-runtime-fallback-"));
    const unsafeXdg = join(root, "not-a-directory");
    writeFileSync(unsafeXdg, "unsafe\n");
    try {
      const lockPath = resolveDefaultTestRunLockPath({
        env: { XDG_RUNTIME_DIR: unsafeXdg },
        uid: process.getuid(),
        tempDir: root,
        hostName: "builder-1",
      });
      const runtimeRoot = dirname(lockPath);
      const entry = statSync(runtimeRoot);

      expect(runtimeRoot).toBe(join(root, `opencodex-test-runtime-${process.getuid()}`));
      expect(entry.isDirectory()).toBe(true);
      expect(entry.uid).toBe(process.getuid());
      expect(entry.mode & 0o777).toBe(0o700);
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("fails immediately with actionable guidance when every runtime root is unwritable", () => {
    expect(() => resolveDefaultTestRunLockPath({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1001" },
      uid: 1001,
      tempDir: "/tmp",
      hostName: "builder-1",
      fileSystem: acceptingRuntimeFileSystem(1001, false),
    })).toThrow(
      "Cannot resolve a safe user-scoped Bun test lock. Ensure XDG_RUNTIME_DIR",
    );
  });

  test("containment checks do not confuse path string prefixes on POSIX or Windows", () => {
    const home = "/home/alice";
    const lockPath = resolveDefaultTestRunLockPath({
      platform: "linux",
      env: { HOME: home },
      uid: 1001,
      tempDir: "/home",
      hostName: "builder-1",
      fileSystem: acceptingRuntimeFileSystem(1001),
    });

    expect(home.startsWith("/home")).toBe(true);
    expect(pathIsContainedBy(home, lockPath, "posix")).toBe(false);
    expect(pathIsContainedBy("C:\\Users\\Ann", "C:\\Users\\Anna\\lock", "win32")).toBe(false);
  });

  test("independent bare runners do not inherit a shared long-lived parent identity", () => {
    expect(resolveBareTestRunIdentity({ pid: 101, ppid: 50 })).toEqual({
      ownerPid: 101,
      runId: "bare-101",
    });
    expect(resolveBareTestRunIdentity({ pid: 102, ppid: 50 })).toEqual({
      ownerPid: 102,
      runId: "bare-102",
    });
  });

  test("parallel Bun workers rendezvous on their short-lived controller PID", () => {
    expect(resolveBareTestRunIdentity({ pid: 101, ppid: 90, workerId: "1" })).toEqual({
      ownerPid: 101,
      runId: "bare-90",
    });
    expect(resolveBareTestRunIdentity({ pid: 102, ppid: 90, workerId: "2" })).toEqual({
      ownerPid: 102,
      runId: "bare-90",
    });
  });

  test("one run owns the lock while sibling workers with its run ID join", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const options = { runId: "suite-a", lockPath, pollMs: 5, maxWaitMs: 50, env: queuedTestEnv };
      const owner = await acquireTestRunLock(options);
      const sibling = await acquireTestRunLock(options);
      expect(owner.acquired).toBe(true);
      expect(sibling.acquired).toBe(false);
      sibling.release();
      expect(existsSync(lockPath)).toBe(true);
      owner.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("an inherited worker can only join the exact live wrapper owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({
        runId: "wrapped", lockPath, pollMs: 5, maxWaitMs: 50, env: queuedTestEnv,
      });
      expect(owner.owner).not.toBeNull();
      const sibling = await acquireTestRunLock({
        runId: "wrapped",
        lockPath,
        joinExistingOwnerToken: owner.owner!.token,
        env: queuedTestEnv,
      });
      expect(sibling.acquired).toBe(false);
      const wrongToken = owner.owner!.token === "57f44b0e-b750-4bd2-b23d-4a035e75da18"
        ? "6ab28966-06a7-4ef8-a0d9-23667d5d9ef5"
        : "57f44b0e-b750-4bd2-b23d-4a035e75da18";

      await expect(acquireTestRunLock({
        runId: "wrapped",
        lockPath,
        joinExistingOwnerToken: wrongToken,
        env: queuedTestEnv,
      })).rejects.toThrow("refusing to create or reclaim");

      owner.release();
      expect(existsSync(lockPath)).toBe(false);
      await expect(acquireTestRunLock({
        runId: "wrapped",
        lockPath,
        joinExistingOwnerToken: owner.owner!.token,
        env: queuedTestEnv,
      })).rejects.toThrow("refusing to create or reclaim");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("a dead owner is reclaimed even when the next bare invocation derives the same run ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const stale = await acquireTestRunLock({
        runId: "stale",
        ownerPid: 2_147_483_647,
        lockPath,
        pollMs: 5,
        maxWaitMs: 50,
        env: queuedTestEnv,
      });
      const replacement = await acquireTestRunLock({
        runId: "stale", lockPath, pollMs: 5, maxWaitMs: 50, env: queuedTestEnv,
      });
      expect(replacement.acquired).toBe(true);
      stale.release();
      expect(existsSync(lockPath)).toBe(true);
      replacement.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("a live competing run fails closed after the bounded wait", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({
        runId: "live", lockPath, pollMs: 5, maxWaitMs: 50, env: queuedTestEnv,
      });
      let waits = 0;
      await expect(acquireTestRunLock({
        runId: "blocked",
        lockPath,
        pollMs: 5,
        maxWaitMs: 20,
        env: queuedTestEnv,
        onWait: () => { waits += 1; },
      })).rejects.toThrow("timed out");
      expect(waits).toBe(1);
      owner.release();
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("the explicit no-queue escape hatch does not create a lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const lock = await acquireTestRunLock({
        runId: "opt-out",
        lockPath,
        env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      });
      expect(lock.acquired).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTreeWithRetry(root);
    }
  });
});

describe("ensureGuiDependencies", () => {
  // `gui` is not a workspace, so a root `bun install` leaves gui/node_modules absent and the
  // twenty-five tests importing gui/src die on `Cannot find package 'react'` — an "Unhandled error
  // between tests" that names no test. CI already installs them; this closes the local gap.
  const paths = (present: string[]) => {
    const normalized = present.map(path => path.replaceAll("\\", "/"));
    return (path: string) => normalized.some(entry => path.replaceAll("\\", "/").endsWith(entry));
  };

  test("mocked paths match POSIX and Windows separators", () => {
    const exists = paths(["gui/package.json"]);
    expect(exists("/repo/gui/package.json")).toBe(true);
    expect(exists("C:\\repo\\gui\\package.json")).toBe(true);
  });

  test("installs when gui/package.json exists but node_modules does not", () => {
    const installed: string[] = [];
    const logged: string[] = [];
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json"]),
      install: dir => { installed.push(dir); return { ok: true, detail: "" }; },
      log: message => logged.push(message),
    });

    expect(result).toEqual({ kind: "installed" });
    expect(installed).toEqual([join("/repo", "gui")]);
    expect(logged[0]).toContain("gui dependencies are missing or incomplete");
  });

  test("retries when node_modules exists without the required dependency", () => {
    let installs = 0;
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json", "gui/node_modules"]),
      install: () => { installs += 1; return { ok: true, detail: "" }; },
      log: () => {},
    });

    expect(result).toEqual({ kind: "installed" });
    expect(installs).toBe(1);
  });

  test("does nothing when the required dependency is already there", () => {
    let installs = 0;
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json", "gui/node_modules/react/package.json"]),
      install: () => { installs += 1; return { ok: true, detail: "" }; },
      log: () => {},
    });

    expect(result).toEqual({ kind: "present" });
    expect(installs).toBe(0);
  });

  // A published install tree has no gui/ at all; the runner must not try to install there.
  test("does nothing when there is no gui package", () => {
    let installs = 0;
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: () => false,
      install: () => { installs += 1; return { ok: true, detail: "" }; },
      log: () => {},
    });

    expect(result).toEqual({ kind: "absent" });
    expect(installs).toBe(0);
  });

  // Offline or a lockfile drift has to surface as its own message, not as twenty-five
  // unexplained React failures once the lanes start.
  test("reports the failure detail instead of continuing", () => {
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json"]),
      install: () => ({ ok: false, detail: "lockfile had changes" }),
      log: () => {},
    });

    expect(result).toEqual({ kind: "failed", detail: "lockfile had changes" });
  });
});
