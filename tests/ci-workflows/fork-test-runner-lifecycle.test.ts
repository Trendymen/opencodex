import * as nodePin from "../../scripts/lib/test-runner-node";
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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

test("Fork upstream baseline preserves the fixed official CI graph", () => {
  const path = repoPath(".github", "workflows", "fork-upstream-baseline.yml");
  expect(existsSync(path)).toBe(true);
  if (!existsSync(path)) return;

  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  type Job = { steps?: Step[] };
  type Workflow = {
    name: string;
    "run-name": string;
    on: unknown;
    permissions: unknown;
    concurrency: { group: string; "cancel-in-progress": string };
    jobs: Record<string, Job>;
  };
  const sha = "61147ec681bc8374d350e0eae08b71c117c6df30";
  const workflow = Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;
  expect(workflow.name).toBe(`Fork upstream baseline ${sha} (diagnostic, not release evidence)`);
  expect(workflow["run-name"]).toBe(`Fork upstream baseline ${sha} (diagnostic, not release evidence)`);
  expect(workflow.on).toEqual({ workflow_dispatch: {} });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency.group).toStartWith("fork-upstream-baseline-");
  const checkouts = Object.entries(workflow.jobs).flatMap(([id, job]) =>
    (job.steps ?? []).filter(step => step.uses?.startsWith("actions/checkout@"))
      .map(step => ({ id, step })));
  expect(checkouts).toHaveLength(20);
  for (const { id, step } of checkouts) {
    expect(step.with?.repository).toBe("lidge-jun/opencodex");
    expect(step.with?.ref).toBe(sha);
    expect(step.with?.["persist-credentials"]).toBe(false);
    delete step.with!.repository;
    if (id === "changes") delete step.with!.ref;
    else step.with!.ref = id === "windows-native-claim" ? "${{ github.sha }}" : "${{ needs.changes.outputs.checkout_ref }}";
  }
  for (const id of ["changes", "select-windows-runner"]) {
    const guard = workflow.jobs[id]?.steps?.find(step => step.name === "Validate dispatch source");
    expect(guard?.run).toContain('[ "$REF" != refs/heads/dev ]');
  }

  const { validateRun } = require(repoPath(".github", "scripts", "release-evidence.cjs")) as {
    validateRun: (run: unknown, ci: unknown, kind: string, sourceSha: string) => void;
  };
  const diagnostic = { id: 7, workflow_id: 43, repository: { id: 1273824907 }, head_repository: { id: 1273824907 },
    event: "workflow_dispatch", head_branch: "dev", status: "completed", conclusion: "success", run_attempt: 1,
    head_sha: sha, display_title: workflow["run-name"] };
  expect(() => validateRun(diagnostic, { id: 42 }, "ci", sha)).toThrow("unqualified run metadata");
  expect(() => validateRun({ ...diagnostic, workflow_id: 42 }, { id: 42 }, "ci", sha)).toThrow("CI lane or source mismatch");

  workflow.name = "Cross-platform CI";
  workflow["run-name"] = "ocx-ci-v1 lane=${{ github.event.inputs.lane || 'all' }} sha=${{ github.sha }}";
  workflow.on = { pull_request: {}, workflow_dispatch: { inputs: { lane: {
    description: "all (default), release-gates, macos-control, or windows-native-claim",
    type: "choice", default: "all", options: ["all", "release-gates", "macos-control", "windows-native-claim"],
  } } } };
  workflow.concurrency.group = workflow.concurrency.group.replace(/^fork-upstream-baseline-/, "cross-platform-ci-");
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
      : value;
  const digest = createHash("sha256").update(JSON.stringify(canonical(workflow))).digest("hex");
  expect(digest).toBe("6b2eb9e85e5d23d0fec44368a9e6a394d5112ab2aafbe48846dfb841ca485686");
});

test("Fork Windows update diagnostics keep their fixed partial scope", () => {
  const path = repoPath(".github", "workflows", "fork-ci-update-diagnostics.yml");
  expect(existsSync(path)).toBe(true);
  if (!existsSync(path)) return;

  const workflow = Bun.YAML.parse(readFileSync(path, "utf8")) as {
    name: string;
    "run-name": string;
    on: unknown;
    permissions: unknown;
    jobs: Record<string, { name: string; if: string; "runs-on": string; "timeout-minutes": number; steps: Record<string, unknown>[] }>;
  };
  expect(Object.keys(workflow).sort()).toEqual(["jobs", "name", "on", "permissions", "run-name"]);
  expect(workflow.name).toMatch(/partial.*not release evidence/i);
  expect(workflow["run-name"]).toMatch(/partial.*not release evidence/i);
  expect(workflow.on).toEqual({ workflow_dispatch: null });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(workflow.jobs)).toEqual(["windows-update-diagnostics"]);
  const job = workflow.jobs["windows-update-diagnostics"]!;
  expect(Object.keys(job).sort()).toEqual(["if", "name", "runs-on", "steps", "timeout-minutes"]);
  expect(job.if).toBe("github.ref == 'refs/heads/dev'");
  expect(job["runs-on"]).toBe("windows-latest");
  expect(job["timeout-minutes"]).toBeGreaterThan(0);
  expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
  expect(job.steps).toHaveLength(6);
  expect(job.steps[0]).toEqual({
    name: "Checkout workflow commit",
    uses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    with: { ref: "${{ github.sha }}", "persist-credentials": false },
  });
  expect(job.steps[1]).toEqual({ name: "Setup project Bun", uses: "./.github/actions/setup-project-bun", with: { role: "test-runner" } });
  expect(job.steps[2]).toEqual({ name: "Install dependencies", run: "bun install --frozen-lockfile" });
  expect(job.steps[3]).toEqual({
    name: "Isolate homes", id: "isolate", shell: "pwsh",
    run: [
      '$root = Join-Path $env:RUNNER_TEMP "ocx-update-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"',
      "$ocxHome = Join-Path $root 'opencodex'",
      "$codexHome = Join-Path $root 'codex'",
      "New-Item -ItemType Directory -Path $ocxHome, $codexHome -ErrorAction Stop | Out-Null",
      '"OPENCODEX_HOME=$ocxHome" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
      '"CODEX_HOME=$codexHome" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append',
      "",
    ].join("\n"),
  });
  const condition = "${{ always() && steps.isolate.outcome == 'success' }}";
  const env = { OCX_TEST_NO_QUEUE: "1" };
  expect(job.steps[4]).toEqual({
    name: "Run offline Windows apply Worker cases", if: condition, env,
    run: "bun test --isolate --timeout 60000 tests/codex-integration/codex-cli-update-windows-apply-install.test.ts --test-name-pattern 'a fresh Worker closes after offline Windows apply'",
  });
  expect(job.steps[5]).toEqual({
    name: "Run isolated npm HOME case", if: condition, env,
    run: "bun test --isolate --timeout 60000 tests/codex-integration/codex-cli-update-plan.test.ts --test-name-pattern 'a real npm call under the isolated argv leaves the operator HOME untouched'",
  });

  const { validateRun } = require(repoPath(".github", "scripts", "release-evidence.cjs")) as {
    validateRun: (run: unknown, ci: unknown, kind: string, sourceSha: string) => void;
  };
  const sha = "a".repeat(40);
  const diagnostic = { id: 7, workflow_id: 43, repository: { id: 1273824907 }, head_repository: { id: 1273824907 },
    event: "workflow_dispatch", head_branch: "dev", status: "completed", conclusion: "success", run_attempt: 1,
    head_sha: sha, display_title: workflow["run-name"] };
  expect(() => validateRun(diagnostic, { id: 42 }, "ci", sha)).toThrow("unqualified run metadata");
  expect(() => validateRun({ ...diagnostic, workflow_id: 42 }, { id: 42 }, "ci", sha)).toThrow("CI lane or source mismatch");
});

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
