import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canBatchChangedMain, changedSelectionFailure, resolveBunTestPlan, runTestLane, SERIAL_FULL_SUITE_FILES, type BunTestLane } from "../../scripts/test";
import { discoverTestBatchFiles, runChangedTestBatches } from "../../scripts/lib/test-runner-batches";
import * as nodePin from "../../scripts/lib/test-runner-node";
import * as diagnostics from "../../scripts/lib/test-runner-diagnostics";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function changedFixture(count = 13, unrelatedOrdinary = false) {
  const root = mkdtempSync(join(tmpdir(), "ocx-changed-batches-"));
  const records = join(root, "executions.jsonl");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "bunfig.toml"), '[test]\nroot="tests"\npreload=[]\n');
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "shared.ts"), "export const value = 1;\n");
  for (const file of SERIAL_FULL_SUITE_FILES) {
    const path = join(root, "tests", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, 'import {test} from "bun:test"; test("unrelated serial",()=>{});\n');
  }
  const names = Array.from({ length: count }, (_, index) => `selected-${String(index).padStart(2, "0")}.test.ts`);
  if (count) names[count - 1] = "selected (space).test.ts";
  for (const [index, name] of names.entries()) {
    writeFileSync(join(root, "tests", name), `import {test,expect} from "bun:test"; import {appendFileSync} from "node:fs"; import {value} from "../src/shared.ts";
test("selected ${index}",()=>{expect(value).toBeGreaterThan(0);appendFileSync(${JSON.stringify(records)},JSON.stringify({id:${index},home:process.env.HOME,pid:process.pid})+"\\n");});\n`);
  }
  if (count || unrelatedOrdinary) writeFileSync(join(root, "tests", "aaa-unrelated.test.ts"), 'import {test} from "bun:test"; test("unrelated must stay unselected",()=>{throw new Error("unrelated executed");});\n');
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=Batch Fixture", "-c", "user.email=batch-fixture@example.test", "commit", "--quiet", "-m", "baseline"]);
  const sha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(root, "src", "shared.ts"), "export const value = 2;\n");
  if (count) writeFileSync(join(root, "tests", "untracked (new).test.ts"), `import {test} from "bun:test"; import {appendFileSync} from "node:fs";
test("untracked independent",()=>{appendFileSync(${JSON.stringify(records)},JSON.stringify({id:${count},home:process.env.HOME,pid:process.pid})+"\\n");});\n`);
  return { root, records, sha, names };
}

const desktopLifecycleFiles = [
  "claude-integration/claude-desktop-picker-routes.test.ts",
  "claude-integration/claude-desktop-picker-profile.test.ts",
  "claude-integration/claude-desktop-first-party.test.ts",
  "claude-integration/claude-desktop-first-party-guards.test.ts",
];

test.each([false, true])("default desktop lifecycle lanes exclude the main pool and pin changed selection, changed=%s", changed => {
  const sha = "a".repeat(40);
  const plan = resolveBunTestPlan(changed ? ["--changed=mutable-ref"] : [], changed ? sha : undefined, {});
  expect(SERIAL_FULL_SUITE_FILES).toEqual(expect.arrayContaining(desktopLifecycleFiles));
  expect(plan[0]!.args).toContain("--parallel=4");
  for (const file of desktopLifecycleFiles) {
    const name = file.split("/").at(-1)!;
    const ignore = plan[0]!.args.indexOf(`**/${name}`);
    expect(ignore).toBeGreaterThan(0);
    expect(plan[0]!.args[ignore - 1]).toBe("--path-ignore-patterns");
    const lanes = plan.filter(lane => lane.args.includes(`./tests/${file}`));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.args).toEqual(["--isolate", "--parallel=1", ...(changed ? [`--changed=${sha}`] : []), `./tests/${file}`]);
    expect(lanes[0]!.timeoutMs).toBe(180_000);
  }
  if (changed) for (const lane of plan) expect(lane.args.filter(arg => arg.startsWith("--changed="))).toEqual([`--changed=${sha}`]);
});

test.each([false, true])("default desktop lifecycle files execute once without sharing a process, HOME or critical section, changed=%s", changed => {
  const fixture = changedFixture(1);
  const held = join(fixture.root, "shared-lifecycle-held");
  writeFileSync(join(fixture.root, "tests", "aaa-unrelated.test.ts"), 'import {test} from "bun:test"; test("unrelated",()=>{});\n');
  for (const file of desktopLifecycleFiles) {
    const path = join(fixture.root, "tests", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `import {test,expect} from "bun:test"; import {appendFileSync,mkdirSync,rmSync} from "node:fs"; import {value} from "../../src/shared.ts";
test("shared lifecycle",async()=>{expect(value).toBe(2);mkdirSync(${JSON.stringify(held)});const start=Date.now();try{await Bun.sleep(50);appendFileSync(${JSON.stringify(fixture.records)},JSON.stringify({file:${JSON.stringify(file)},home:process.env.HOME,pid:process.pid,start,end:Date.now()})+"\\n");}finally{rmSync(${JSON.stringify(held)},{recursive:true});}});\n`);
  }
  try {
    const result = Bun.spawnSync([process.execPath, repoPath("scripts", "test.ts"), ...(changed ? [`--changed=${fixture.sha}`] : [])], {
      cwd: fixture.root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const rows = readFileSync(fixture.records, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const desktop = rows.filter(row => typeof row.file === "string").sort((a, b) => a.start - b.start);
    expect(desktop.map(row => row.file).sort()).toEqual([...desktopLifecycleFiles].sort());
    expect(new Set(desktop.map(row => row.pid)).size).toBe(4);
    expect(new Set(desktop.map(row => row.home)).size).toBe(4);
    const main = rows.find(row => row.id === 0)!;
    expect(main).toBeDefined();
    for (const [index, row] of desktop.entries()) {
      expect(row.pid).not.toBe(main.pid);
      expect(row.home).not.toBe(main.home);
      expect(existsSync(row.home)).toBe(false);
      if (index) expect(row.start).toBeGreaterThanOrEqual(desktop[index - 1]!.end);
    }
  } finally { removeTreeWithRetry(fixture.root); }
}, 65_000);

test("default changed executes affected files once across fresh main batch homes", () => {
  const fixture = changedFixture();
  try {
    const result = Bun.spawnSync([process.execPath, repoPath("scripts", "test.ts"), `--changed=${fixture.sha}`], {
      cwd: fixture.root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const rows = readFileSync(fixture.records, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, index) => index));
    const homes = [...new Set<string>(rows.map(row => row.home))];
    expect(homes.length).toBeGreaterThanOrEqual(2);
    for (const home of homes) expect(rows.filter(row => row.home === home).length).toBeLessThanOrEqual(12);
    expect(new Set(rows.map(row => row.pid)).size).toBeGreaterThanOrEqual(2);
    for (const home of homes) expect(existsSync(home)).toBe(false);
  } finally {
    removeTreeWithRetry(fixture.root);
  }
}, 65_000);

test("discovery includes every CI suffix and dedicated families without dependencies or serial duplicates", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-batch-inventory-"));
  const files = ["new (draft).test.ts", "nested/file with space.test.ts", "api-storage-policy-run.test.ts", "api-storage.test.ts", "api-usage.test.ts"];
  for (const separator of [".", "_"]) for (const kind of ["test", "spec"]) for (const ext of ["js", "jsx", "ts", "tsx"]) files.push(`suffix${separator}${kind}.${ext}`);
  const excluded = ["serial.test.ts", "node_modules/pkg/leak.test.ts", ".pnpm/pkg/leak.test.ts", "other.txt"];
  try {
    for (const file of [...files, ...excluded]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    if (process.platform !== "win32") symlinkSync(join(root, "nested"), join(root, "linked"), "dir");
    const discovered = discoverTestBatchFiles(root, ["serial.test.ts"]);
    expect(discovered).toEqual(files.map(file => "./tests/" + file).sort());
    expect(discovered.length).toBe(new Set(discovered).size);
  } finally { removeTreeWithRetry(root); }
});

test.each(["-c", "--config", "--cwd", "--no-isolate", "--watch", "--hot", "--coverage", "--coverage-dir", "--coverage-reporter", "--only-failures", "--bail", "--rerun-each", "--retry"])("state option %s keeps the original process while a filter literal does not", flag => {
  const values: Record<string, string> = { "-c": "custom.toml", "--config": "custom.toml", "--cwd": "custom-root", "--coverage-dir": "coverage", "--coverage-reporter": "lcov", "--rerun-each": "2", "--retry": "2" };
  const options = values[flag] === undefined ? [flag] : [flag, values[flag]!];
  const sha = "a".repeat(40);
  for (const args of [options, ...(values[flag] !== undefined && flag.startsWith("--") ? [[`${flag}=${values[flag]}`]] : [])]) {
    expect(canBatchChangedMain(["--changed=abc", ...args])).toBe(false);
    const plan = resolveBunTestPlan(["--changed=abc", ...args], sha, {});
    expect(plan).toHaveLength(1);
    expect(plan[0]!.args).toEqual(["--isolate", "--parallel=4", `--changed=${sha}`, ...args]);
    expect(resolveBunTestPlan(args, undefined, {})).toHaveLength(1 + SERIAL_FULL_SUITE_FILES.length);
  }
  expect(canBatchChangedMain(["--changed=abc", "-t", flag])).toBe(true);
  expect(resolveBunTestPlan(["--changed=abc", "-t", flag], sha, {})).toHaveLength(1 + SERIAL_FULL_SUITE_FILES.length);
});

test("genuine no-isolate preserves one shared module incarnation across ordinary and serial-roster files", () => {
  const fixture = changedFixture();
  writeFileSync(join(fixture.root, "src", "shared.ts"), 'import {randomUUID} from "node:crypto"; export const value=2; export const token=randomUUID();\n');
  for (const name of fixture.names) {
    const file = join(fixture.root, "tests", name);
    writeFileSync(file, readFileSync(file, "utf8").replace("import {value}", "import {value,token}").replace("home:process.env.HOME", "token,home:process.env.HOME"));
  }
  const serial = join(fixture.root, "tests", desktopLifecycleFiles[0]!);
  writeFileSync(serial, `import {test} from "bun:test"; import {appendFileSync} from "node:fs"; import {token} from "../../src/shared.ts";
test("selected serial",()=>{appendFileSync(${JSON.stringify(fixture.records)},JSON.stringify({id:"serial",token,home:process.env.HOME,pid:process.pid})+"\\n");});\n`);
  try {
    const result = Bun.spawnSync([process.execPath, repoPath("scripts", "test.ts"), "--parallel=1", "--no-isolate", `--changed=${fixture.sha}`], {
      cwd: fixture.root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const rows = readFileSync(fixture.records, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.id < 13 || row.id === "serial");
    expect(rows.filter(row => row.id !== "serial").map(row => row.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, index) => index));
    expect(rows.filter(row => row.id === "serial")).toHaveLength(1);
    expect(new Set(rows.map(row => row.token)).size).toBe(1);
    expect(new Set(rows.map(row => row.pid)).size).toBe(1);
    expect(new Set(rows.map(row => row.home)).size).toBe(1);
  } finally { removeTreeWithRetry(fixture.root); }
}, 65_000);

test("explicit scopes and stateful outputs remain caller controlled", () => {
  const sha = "a".repeat(40);
  for (const args of [["./tests/a.test.ts"], ["--", "./tests/"], ["--path-ignore-patterns", "**/a.test.ts"], ["--shard=1/2"], ["--reporter-outfile", "report.xml"], ["--update-timings"]]) {
    expect(canBatchChangedMain(["--changed=abc", ...args])).toBe(false);
    const plan = resolveBunTestPlan(["--changed=abc", ...args], sha, {});
    expect(plan).toHaveLength(1);
    expect(plan[0]!.args).toEqual(["--isolate", "--parallel=4", `--changed=${sha}`, ...args]);
  }
  expect(canBatchChangedMain(["--changed=abc", "-t", "./tests/"])).toBe(true);
  expect(canBatchChangedMain(["--changed=abc", "-t", "--parallel=2"])).toBe(true);
  expect(canBatchChangedMain([])).toBe(false);
});

const batchFiles = Array.from({ length: 25 }, (_, index) => `./tests/file-${index}.test.ts`);
const mainLane = (): BunTestLane => ({ label: "parallel suite", args: ["--isolate", "--parallel=7", "--changed=" + "a".repeat(40), "--path-ignore-patterns", "**/serial.test.ts"], timeoutMs: 5_000 });

async function realExit(code: number, text: string) {
  const child = Bun.spawn([process.execPath, "-e", `console.log(${JSON.stringify(text)});process.exit(${code});`], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  return { exitCode: await child.exited, output };
}

test("ordinary failed batches preserve the first failure and still collect later output", async () => {
  const seen: BunTestLane[] = [];
  const result = await runChangedTestBatches(mainLane(), batchFiles, async lane => {
    seen.push(lane);
    return realExit([7, 9, 0][seen.length - 1]!, `batch-${seen.length}`);
  });
  expect(result.exitCode).toBe(7);
  expect(result.output).toBe("batch-1\nbatch-2\nbatch-3\n");
  expect(seen.flatMap(lane => lane.args.filter(arg => arg.startsWith("./tests/")))).toEqual(batchFiles);
  expect(new Set(seen.map(lane => lane.deadlineAt)).size).toBe(1);
  for (const lane of seen) expect(lane.args.slice(0, 5)).toEqual(mainLane().args);
});

test.each([124, 130, 143])("terminal result %s stops further fresh batches", async code => {
  let calls = 0;
  const result = await runChangedTestBatches(mainLane(), batchFiles, async () => realExit(++calls === 1 ? 9 : code, `call-${calls}`));
  expect(calls).toBe(2);
  expect(result.exitCode).toBe(code);
});

test("setup elapsed time consumes the common main deadline", async () => {
  let calls = 0;
  const result = await runChangedTestBatches({ ...mainLane(), timeoutMs: 40 }, batchFiles, async () => {
    calls++;
    await Bun.sleep(60);
    return { exitCode: 0, output: "first" };
  });
  expect(calls).toBe(1);
  expect(result).toEqual({ exitCode: 124, output: "first" });
});

test("the final batch cannot report success after exhausting the shared deadline", async () => {
  const result = await runChangedTestBatches({ ...mainLane(), timeoutMs: 40 }, batchFiles.slice(0, 1), async () => {
    await Bun.sleep(60);
    return { exitCode: 0, output: "late" };
  });
  expect(result).toEqual({ exitCode: 124, output: "late" });
});

test.each([false, true])("a shared deadline expired during Node pin prevents the test child and cleans HOME, pin rejects=%s", async rejects => {
  const root = mkdtempSync(join(tmpdir(), "ocx-pin-deadline-"));
  const marker = join(root, "ran");
  const fixture = join(root, "child.test.ts");
  writeFileSync(fixture, `import {test} from "bun:test"; import {writeFileSync} from "node:fs"; test("child",()=>writeFileSync(${JSON.stringify(marker)},"ran"));`);
  let home = "";
  const pin = spyOn(nodePin, "pinTestNodePath").mockImplementation(async env => { home = env.HOME!; await Bun.sleep(80); if (rejects) throw new Error("fixture pin failure"); });
  try {
    const result = await runTestLane({ label: "expired setup", args: [fixture], timeoutMs: 2_000, deadlineAt: Date.now() + 40 }, "batch-deadline", undefined, true, undefined, process.execPath);
    expect(result.exitCode).toBe(124);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(home)).toBe(false);
  } finally { pin.mockRestore(); removeTreeWithRetry(root); }
});

test("Node pin leaves only the remaining shared time for a real child", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-pin-remaining-"));
  const fixture = join(root, "hang.test.ts");
  writeFileSync(fixture, 'import {test} from "bun:test"; test("hang",async()=>{await new Promise(()=>{});},10000);');
  const pin = spyOn(nodePin, "pinTestNodePath").mockImplementation(async () => { await Bun.sleep(80); });
  const observe = spyOn(diagnostics, "saveTestLaneDiagnostics").mockImplementation(() => root);
  const start = Date.now();
  try {
    const result = await runTestLane({ label: "remaining setup", args: [fixture], timeoutMs: 2_000, deadlineAt: start + 180 }, "batch-remaining", undefined, true, undefined, process.execPath);
    expect(result.exitCode).toBe(124);
    expect(Date.now() - start).toBeLessThan(1_500);
  } finally { pin.mockRestore(); observe.mockRestore(); removeTreeWithRetry(root); }
});

test("all batch summaries contribute changed coverage including an initially empty batch", async () => {
  let calls = 0;
  const result = await runChangedTestBatches(mainLane(), batchFiles.slice(0, 13), async () => ({ exitCode: 0, output: ++calls === 1 ? "Ran 0 tests across 0 files.\n" : "Ran 1 test across 1 file.\n" }));
  expect(changedSelectionFailure({ comparisonRef: "fixture", comparisonCommit: "a".repeat(40), changedFiles: ["src/shared.ts"] }, result.output)).toBeNull();
});

test.each([false, true])("zero selection keeps Bun failure or the original coverage guard, ordinary present=%s", ordinary => {
  const fixture = changedFixture(0, ordinary);
  try {
    const result = Bun.spawnSync([process.execPath, repoPath("scripts", "test.ts"), `--changed=${fixture.sha}`], {
      cwd: fixture.root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(ordinary ? "selected 0 tests across 0 files" : "No tests found");
  } finally { removeTreeWithRetry(fixture.root); }
}, 65_000);
