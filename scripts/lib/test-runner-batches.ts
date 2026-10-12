import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { BunTestLane } from "../test";

const TEST_FILE = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;
const DEPENDENCY_DIRECTORIES = new Set(["node_modules", ".pnpm", ".yarn", ".bun", ".git"]);
const BATCH_SIZE = 12;

/** Discover the default tests root, including untracked files and dedicated CI families. */
export function discoverTestBatchFiles(testRoot: string, serialFiles: readonly string[]): string[] {
  const excluded = new Set(serialFiles);
  const files: string[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory() && !DEPENDENCY_DIRECTORIES.has(entry.name)) {
        visit(join(directory, entry.name), relative + "/");
      } else if (entry.isFile() && TEST_FILE.test(entry.name) && !excluded.has(relative)) {
        files.push("./tests/" + relative);
      }
    }
  };
  visit(testRoot, "");
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

type LaneResult = { exitCode: number; output: string };

/** All fresh batches share the main lane's deadline, including setup before each child starts. */
export async function runChangedTestBatches(
  lane: BunTestLane,
  files: readonly string[],
  execute: (batch: BunTestLane, cancellation: AbortSignal) => Promise<LaneResult>,
  options: { concurrency?: 1 | 2; onResult?: (result: LaneResult, index: number) => void } = {},
): Promise<LaneResult> {
  const deadlineAt = lane.deadlineAt ?? Date.now() + lane.timeoutMs;
  const count = Math.max(1, Math.ceil(files.length / BATCH_SIZE));
  const cancellation = new AbortController();
  const results: LaneResult[] = [];
  let next = 0;
  let reported = 0;
  let failure: { error: unknown } | undefined;
  const stop = (code: number) => { if (!cancellation.signal.aborted) cancellation.abort(code); };
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const timer = setTimeout(() => stop(124), Math.max(0, deadlineAt - Date.now()));
  const worker = async () => {
    while (!cancellation.signal.aborted && next < count) {
      if (Date.now() >= deadlineAt) { stop(124); break; }
      const index = next++;
      try {
        const result = await execute({
          ...lane, deadlineAt,
          label: `parallel suite batch ${index + 1}/${count}`,
          args: [...lane.args, ...files.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)],
        }, cancellation.signal);
        results[index] = result;
        while (results[reported] !== undefined) {
          const ready = reported++;
          options.onResult?.(results[ready]!, ready);
        }
        if ([124, 130, 143].includes(result.exitCode)) stop(result.exitCode);
        if (Date.now() >= deadlineAt) stop(124);
      } catch (error) {
        failure ??= { error };
        stop(143);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: options.concurrency === 2 ? 2 : 1 }, worker));
    results.forEach((result, index) => { if (index >= reported) options.onResult?.(result, index); });
    if (failure) throw failure.error;
    return {
      exitCode: cancellation.signal.aborted ? cancellation.signal.reason : results.find(result => result.exitCode !== 0)?.exitCode ?? 0,
      output: results.map(result => result.output).join(""),
    };
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
