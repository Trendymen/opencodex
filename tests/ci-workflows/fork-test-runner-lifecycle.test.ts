import * as nodePin from "../../scripts/lib/test-runner-node";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { changedSelectionFailure, resolveBunTestArgs, resolveBunTestPlan, runTestLane } from "../../scripts/test";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { changedFixtureDiagnostic, changedFixturePathFacts } from "../helpers/fork-changed-fixture-diagnostic";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { initChangedRunFixture, runGit, commitFixture } from "../helpers/fork-changed-run-fixture";

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
  const { cwd, allocated } = initChangedRunFixture();
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
    if (result.exitCode !== 0) console.error(changedFixtureDiagnostic(result, args, cwd), changedFixturePathFacts(cwd));
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
  } finally { removeTreeWithRetry(allocated); }
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
