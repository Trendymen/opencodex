import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canBatchChangedMain, changedSelectionFailure, resolveBunTestPlan, runTestLane, SERIAL_FULL_SUITE_FILES, type BunTestLane } from "../../scripts/test";
import { discoverTestBatchFiles, runChangedTestBatches } from "../../scripts/lib/test-runner-batches";
import * as nodePin from "../../scripts/lib/test-runner-node";
import * as diagnostics from "../../scripts/lib/test-runner-diagnostics";
import * as runner from "../../scripts/test";
import * as testTemp from "../../scripts/test-temp";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function changedFixture(count = 13, unrelatedOrdinary = false, serialFiles: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "ocx-changed-batches-"));
  const records = join(root, "executions.jsonl");
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "bunfig.toml"), '[test]\nroot="tests"\npreload=[]\n');
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "src", "shared.ts"), "export const value = 1;\n");
  for (const file of serialFiles) {
    const path = join(root, "tests", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `import {test} from "bun:test"; import {appendFileSync} from "node:fs";
test("unrelated serial",()=>{appendFileSync(${JSON.stringify(records)},JSON.stringify({id:"unrelated-serial"})+"\\n");});\n`);
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
const unrelatedSerialFile = "codex-integration/codex-shim.test.ts";

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
  const fixture = changedFixture(1, false, changed ? [unrelatedSerialFile, ...desktopLifecycleFiles] : SERIAL_FULL_SUITE_FILES);
  const held = join(fixture.root, "shared-lifecycle-held");
  writeFileSync(join(fixture.root, "tests", "aaa-unrelated.test.ts"), 'import {test} from "bun:test"; test("unrelated",()=>{});\n');
  for (const file of desktopLifecycleFiles) {
    const path = join(fixture.root, "tests", file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `import {test,expect} from "bun:test"; import {appendFileSync,mkdirSync,rmSync} from "node:fs"; import {value} from "../../src/shared.ts";
test("shared lifecycle",async()=>{expect(value).toBe(2);mkdirSync(${JSON.stringify(held)});const start=Date.now();try{await Bun.sleep(50);appendFileSync(${JSON.stringify(fixture.records)},JSON.stringify({file:${JSON.stringify(file)},home:process.env.HOME,pid:process.pid,start,end:Date.now()})+"\\n");}finally{rmSync(${JSON.stringify(held)},{recursive:true});}});\n`);
  }
  try {
    if (changed) {
      const driver = join(fixture.root, "plan.ts");
      writeFileSync(driver, `import {resolveBunTestPlan} from ${JSON.stringify(repoPath("scripts", "test.ts"))};
console.log(JSON.stringify({changed:resolveBunTestPlan(["--changed=mutable-ref"],${JSON.stringify(fixture.sha)},{}),full:resolveBunTestPlan([],undefined,{})}));\n`);
      const result = Bun.spawnSync([process.execPath, driver], { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      const plan = JSON.parse(result.stdout.toString());
      expect(plan.changed).toHaveLength(6);
      expect(plan.changed.slice(1).map((lane: BunTestLane) => lane.args.at(-1))).toEqual([unrelatedSerialFile, ...desktopLifecycleFiles].map(file => `./tests/${file}`));
      expect(plan.changed[0].args).toContain("--parallel=4");
      expect(plan.changed[0].args.filter((arg: string) => arg === "--path-ignore-patterns")).toHaveLength(SERIAL_FULL_SUITE_FILES.length);
      for (const lane of plan.changed) expect(lane.args.filter((arg: string) => arg.startsWith("--changed="))).toEqual([`--changed=${fixture.sha}`]);
      expect(plan.full).toHaveLength(1 + SERIAL_FULL_SUITE_FILES.length);
    }
    const result = Bun.spawnSync([process.execPath, repoPath("scripts", "test.ts"), ...(changed ? [`--changed=${fixture.sha}`] : [])], {
      cwd: fixture.root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const rows = readFileSync(fixture.records, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (changed) expect(rows.filter(row => row.id === "unrelated-serial")).toHaveLength(0);
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
  const fixture = changedFixture(13, false, [unrelatedSerialFile]);
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
  const fixture = changedFixture(13, false, [desktopLifecycleFiles[0]!]);
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

test("shared deadline observes an active real child before sending TERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-deadline-order-"));
  const fixture = join(root, "active.test.ts");
  const marker = join(root, "active");
  writeFileSync(fixture, `import {test} from "bun:test";import {writeFileSync} from "node:fs";test("active",async()=>{writeFileSync(${JSON.stringify(marker)},"active");await new Promise(()=>{});},10000);`);
  const events: string[] = [];
  const originalSpawn = Bun.spawn;
  let childKill: ReturnType<typeof spyOn> | undefined;
  const spawn = spyOn(Bun, "spawn").mockImplementation((command, options) => {
    const child = originalSpawn(command, options);
    if (Array.isArray(command) && command[1] === "test") {
      const kill = child.kill.bind(child);
      childKill = spyOn(child, "kill").mockImplementation(signal => { events.push(`kill:${signal}`); return kill(signal); });
    }
    return child;
  });
  let activeAtDiagnostic = false;
  const diagnose = spyOn(diagnostics, "saveTestLaneDiagnostics").mockImplementation(pid => {
    events.push("diagnostic");
    try { process.kill(pid, 0); activeAtDiagnostic = existsSync(marker); } catch { activeAtDiagnostic = false; }
    return root;
  });
  try {
    const result = await runChangedTestBatches({ ...mainLane(), deadlineAt: Date.now() + 600 }, batchFiles.slice(0, 1),
      (lane, cancellation) => runTestLane({ ...lane, args: [fixture] }, "diagnostic-order", undefined, true,
        { stdout: () => {}, stderr: () => {} }, process.execPath, cancellation));
    expect(result.exitCode).toBe(124);
    expect(activeAtDiagnostic).toBe(true);
    expect(events[0]).toBe("diagnostic");
    expect(events[1]).toBe("kill:SIGTERM");
  } finally { childKill?.mockRestore(); spawn.mockRestore(); diagnose.mockRestore(); removeTreeWithRetry(root); }
});

test("later batch quarantine diagnostics stay labelled and buffered until the earlier batch completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-cleanup-report-"));
  const fixtures = [join(root, "slow.test.ts"), join(root, "fast.test.ts")];
  const marker = join(root, "slow-started");
  writeFileSync(fixtures[0]!, `import {test} from "bun:test";import {writeFileSync} from "node:fs";test("child",async()=>{writeFileSync(${JSON.stringify(marker)},"started");await Bun.sleep(200);});`);
  writeFileSync(fixtures[1]!, `import {test} from "bun:test";import {existsSync} from "node:fs";test("child",async()=>{const until=Date.now()+2000;while(!existsSync(${JSON.stringify(marker)})&&Date.now()<until)await Bun.sleep(10);});`);
  const originalSpawn = Bun.spawn;
  const originalRemove = testTemp.removeTestTempTree;
  const homes: string[] = [];
  const logs: string[][] = [[], []];
  const printed: string[] = [];
  let calls = 0;
  let laterCleanedFirst = false;
  const spawn = spyOn(Bun, "spawn").mockImplementation((command, options) => {
    if (Array.isArray(command) && command[1] === "test") homes[fixtures.findIndex(path => command.includes(path))] = options!.env!.HOME!;
    return originalSpawn(command, options);
  });
  const remove = spyOn(testTemp, "removeTestTempTree").mockImplementation((path, options) => {
    if (path === homes[1]) {
      laterCleanedFirst = existsSync(homes[0]!);
      mkdirSync(join(path, ".trash-locked"));
      throw new Error("fixture quarantine handle");
    }
    return originalRemove(path, options);
  });
  const error = spyOn(console, "error").mockImplementation(message => { printed.push(`unbuffered:${message}`); });
  try {
    const result = await runChangedTestBatches(mainLane(), batchFiles.slice(0, 13), (lane, cancellation) => {
      const index = calls++;
      return runTestLane({ ...lane, args: [fixtures[index]!] }, "cleanup-report", undefined, true,
        { stdout: () => {}, stderr: () => {} }, process.execPath, cancellation, message => { logs[index]!.push(message); });
    }, { concurrency: 2, onResult: (_result, index) => { printed.push(...logs[index]!); } });
    expect(result.exitCode).toBe(1);
    expect(laterCleanedFirst).toBe(true);
    expect(printed.some(line => line.startsWith("unbuffered:"))).toBe(false);
    const first = printed.findIndex(line => line.includes("batch 1/2 finished"));
    const quarantine = printed.findIndex(line => line.includes("quarantined temp still"));
    expect(quarantine).toBeGreaterThan(first);
    expect(printed[quarantine]).toContain("parallel suite batch 2/2");
    expect(printed.join("\n")).toContain("fixture quarantine handle");
  } finally {
    spawn.mockRestore(); remove.mockRestore(); error.mockRestore();
    for (const home of homes) if (existsSync(home)) removeTreeWithRetry(home);
    removeTreeWithRetry(root);
  }
});

test.each([false, true])("lane metadata stays outside child writers, dedicated reporter=%s", async dedicated => {
  const root = mkdtempSync(join(tmpdir(), "ocx-lane-metadata-"));
  const fixture = join(root, "child.test.ts");
  writeFileSync(fixture, 'import {test} from "bun:test";test("child",()=>{process.stdout.write("child stdout\\n");process.stderr.write("child stderr\\n");});');
  const stdout: string[] = [], stderr: string[] = [], metadata: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await runTestLane({ label: "metadata fixture", args: [fixture], timeoutMs: 2_000 }, "metadata-fixture", undefined, true,
      { stdout: value => { stdout.push(value); }, stderr: value => { stderr.push(value); } }, process.execPath, undefined,
      dedicated ? message => { metadata.push(message); } : undefined);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(stdout.join("") + "\n" + stderr.join(""));
    expect(stdout.join("")).toContain("child stdout\n");
    expect(stderr.join("")).toContain("child stderr\n");
    if (dedicated) {
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toMatch(/\[test\] metadata fixture finished in .* \(exit 0\)\./);
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[test\] metadata fixture finished in .* \(exit 0\)\./));
    }
  } finally { warn.mockRestore(); removeTreeWithRetry(root); }
});

test("changed concurrency respects CPU capacity and real parallel overrides, including filter literals", () => {
  const concurrency = (args: string[], cpus: number) => runner.resolveChangedBatchConcurrency?.(args, cpus) ?? 1;
  expect(concurrency(["--changed=abc"], 8)).toBe(2);
  expect(concurrency(["--changed=abc"], 7)).toBe(1);
  for (const flag of ["--parallel", "--parallel=7", "--no-isolate"]) expect(concurrency(["--changed=abc", flag], 14)).toBe(1);
  expect(concurrency(["--changed=abc", "-t", "--parallel=2"], 14)).toBe(2);
  expect(concurrency(["--changed=abc", "--", "--parallel=2"], 14)).toBe(1);
  expect(concurrency(["--changed=abc", "./tests/"], 14)).toBe(1);
});

test.each([[8, [], 2, "--parallel=2"], [7, [], 1, "--parallel=4"], [8, ["--parallel=3"], 1, "--parallel=3"]] as const)(
  "CLI allocates child workers with CPU=%s and requested=%s", async (cpus, requested, concurrency, workerFlag) => {
    const fixture = changedFixture(13);
    const spawns = join(fixture.root, "spawns.jsonl");
    const preload = join(fixture.root, "observe.ts");
    writeFileSync(preload, `import {spyOn} from "bun:test"; import * as os from "node:os"; import {appendFileSync} from "node:fs";
spyOn(os,"availableParallelism").mockReturnValue(${cpus});const spawn=Bun.spawn;Bun.spawn=function(args,options){if(args[1]==="test")appendFileSync(${JSON.stringify(spawns)},JSON.stringify({args,home:options.env.HOME,start:Date.now()})+"\\n");return spawn(args,options);};`);
    for (const name of fixture.names) {
      const path = join(fixture.root, "tests", name);
      writeFileSync(path, readFileSync(path, "utf8").replace('()=>{expect(value)', 'async()=>{await Bun.sleep(120);expect(value)').replace('pid:process.pid', 'pid:process.pid,end:Date.now()'));
    }
    try {
      const child = Bun.spawn([process.execPath, "--preload", preload, repoPath("scripts", "test.ts"), `--changed=${fixture.sha}`, ...requested], {
        cwd: fixture.root, env: { ...process.env, OCX_TEST_NO_QUEUE: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      const [, stderr] = await Promise.all([out, err]);
      expect([...stderr.matchAll(/\[test\] parallel suite batch (\d+)\/2 finished/g)].map(match => Number(match[1]))).toEqual([1, 2]);
      const rows = readFileSync(spawns, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.args).toContain(workerFlag);
        expect(row.args.filter((arg: string) => arg.startsWith("--changed="))).toEqual([`--changed=${fixture.sha}`]);
        expect(row.args.filter((arg: string) => arg.startsWith("./tests/")).length).toBeLessThanOrEqual(12);
        expect(existsSync(row.home)).toBe(false);
      }
      const executions = readFileSync(fixture.records, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(executions).toHaveLength(14);
      const firstEnd = Math.max(...executions.filter(row => row.home === rows[0].home).map(row => row.end ?? 0));
      expect(concurrency === 2 ? rows[1].start < firstEnd : rows[1].start >= firstEnd).toBe(true);
    } finally { removeTreeWithRetry(fixture.root); }
  }, 10_000,
);

test("an already cancelled lane creates no sandbox or child", async () => {
  const controller = new AbortController();
  controller.abort(130);
  const result = await runTestLane(mainLane(), "already-cancelled", undefined, true, undefined, "/missing/bun", controller.signal);
  expect(result).toEqual({ exitCode: 130, output: "" });
});

test("two batches overlap without exceeding the cap and aggregate failures in logical order", async () => {
  let active = 0, peak = 0;
  const seen: BunTestLane[] = [];
  const completed: number[] = [];
  const reported: number[] = [];
  const result = await runChangedTestBatches(mainLane(), batchFiles, async lane => {
    const index = seen.push(lane) - 1;
    peak = Math.max(peak, ++active);
    await Bun.sleep(index === 0 ? 100 : 15);
    active--;
    completed.push(index);
    return realExit([7, 9, 0][index]!, `batch-${index + 1}`);
  }, { concurrency: 2, onResult: (_result, index) => { reported.push(index); } });
  expect(peak).toBe(2);
  expect(completed[0]).toBe(1);
  expect(reported).toEqual([0, 1, 2]);
  expect(result).toEqual({ exitCode: 7, output: "batch-1\nbatch-2\nbatch-3\n" });
  expect(seen).toHaveLength(3);
  expect(new Set(seen.map(lane => lane.deadlineAt)).size).toBe(1);
  expect(seen.flatMap(lane => lane.args.filter(arg => arg.startsWith("./tests/")))).toEqual(batchFiles);
});

test("completed contiguous batch logs flush while a later batch is still running", async () => {
  const reported: number[] = [];
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = runChangedTestBatches(mainLane(), batchFiles, async () => {
    const index = calls++;
    if (index) await gate;
    return { exitCode: 0, output: `batch-${index}\n` };
  }, { concurrency: 2, onResult: (_result, index) => { reported.push(index); } });
  try {
    await Bun.sleep(20);
    expect(reported).toEqual([0]);
  } finally { release(); await pending; }
  expect(reported).toEqual([0, 1, 2]);
});

test.each([124, 130, 143, "throw"] as const)("terminal %s cancels and drains the started sibling before returning", async code => {
  const homes: string[] = [];
  let calls = 0, drained = false;
  const failure = new Error("execute fixture failure");
  const pending = runChangedTestBatches(mainLane(), batchFiles, async (_lane, signal) => {
    const index = calls++;
    const home = mkdtempSync(join(tmpdir(), "ocx-batch-cancel-"));
    homes.push(home);
    try {
      if (index === 0) {
        await Bun.sleep(30);
        if (code === "throw") throw failure;
        return { exitCode: code, output: "terminal\n" };
      }
      await Promise.race([Bun.sleep(200), new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      expect(signal?.aborted).toBe(true);
      await Bun.sleep(20);
      drained = true;
      return { exitCode: 143, output: "sibling drained\n" };
    } finally { removeTreeWithRetry(home); }
  }, { concurrency: 2 });
  if (code === "throw") {
    let caught: unknown;
    try { await pending; } catch (error) { caught = error; }
    expect(caught).toBe(failure);
  } else {
    expect(await pending).toEqual({ exitCode: code, output: "terminal\nsibling drained\n" });
  }
  expect(calls).toBe(2);
  expect(drained).toBe(true);
  for (const home of homes) expect(existsSync(home)).toBe(false);
});

test.each([["SIGINT", false], ["SIGTERM", false], ["SIGINT", true], ["SIGTERM", true]] as const)("external %s during both Node pins prevents children and waits for HOME cleanup, pin rejects=%s", async (signal, rejects) => {
  const root = mkdtempSync(join(tmpdir(), "ocx-pin-signal-"));
  const marker = join(root, "ran");
  const fixture = join(root, "child.test.ts");
  writeFileSync(fixture, `import {test} from "bun:test"; import {writeFileSync} from "node:fs"; test("child",()=>writeFileSync(${JSON.stringify(marker)},"ran"));`);
  const homes: string[] = [];
  const pin = spyOn(nodePin, "pinTestNodePath").mockImplementation(async env => {
    homes.push(env.HOME!);
    if (homes.length === 2) setTimeout(() => process.emit(signal), 10);
    await Bun.sleep(70);
    expect(existsSync(env.HOME!)).toBe(true);
    if (rejects) throw new Error("cancelled pin fixture");
  });
  try {
    const result = await runChangedTestBatches(mainLane(), batchFiles, (lane, cancellation) => runTestLane(
      { ...lane, args: [fixture] }, "signal-pin", undefined, true, undefined, process.execPath, cancellation,
    ), { concurrency: 2 });
    expect(result.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    expect(homes).toHaveLength(2);
    expect(existsSync(marker)).toBe(false);
    for (const home of homes) expect(existsSync(home)).toBe(false);
  } finally { pin.mockRestore(); removeTreeWithRetry(root); }
});

test("execute throws only after a real sibling child has exited, drained its pipe and removed HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-real-sibling-"));
  const marker = join(root, "started.json");
  const fixture = join(root, "waiting.test.ts");
  writeFileSync(fixture, `import {test} from "bun:test"; import {writeFileSync} from "node:fs";
test("waiting",async()=>{writeFileSync(${JSON.stringify(marker)},JSON.stringify({home:process.env.HOME,pid:process.pid}));console.log("sibling pipe marker");await new Promise(()=>{});},10000);`);
  let calls = 0;
  const failure = new Error("real sibling fixture failure");
  const outputs: string[] = [];
  try {
    let caught: unknown;
    try {
      await runChangedTestBatches(mainLane(), batchFiles, async (lane, cancellation) => {
        if (calls++ === 0) {
          const until = Date.now() + 2_000;
          while (!existsSync(marker) && Date.now() < until) await Bun.sleep(10);
          if (!existsSync(marker)) throw new Error("sibling never started");
          throw failure;
        }
        return runTestLane({ ...lane, args: [fixture] }, "real-sibling", undefined, true,
          { stdout: () => {}, stderr: () => {} }, process.execPath, cancellation);
      }, { concurrency: 2, onResult: result => { outputs.push(result.output); } });
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(calls).toBe(2);
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(existsSync(child.home)).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(outputs.join("")).toContain("sibling pipe marker");
  } finally { removeTreeWithRetry(root); }
});

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
