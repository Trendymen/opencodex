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
  execute: (batch: BunTestLane) => Promise<LaneResult>,
): Promise<LaneResult> {
  const deadlineAt = lane.deadlineAt ?? Date.now() + lane.timeoutMs;
  const count = Math.max(1, Math.ceil(files.length / BATCH_SIZE));
  let exitCode = 0;
  let output = "";
  for (let index = 0; index < count; index++) {
    if (Date.now() >= deadlineAt) return { exitCode: 124, output };
    const result = await execute({
      ...lane, deadlineAt,
      label: `parallel suite batch ${index + 1}/${count}`,
      args: [...lane.args, ...files.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)],
    });
    output += result.output;
    if ([124, 130, 143].includes(result.exitCode)) return { exitCode: result.exitCode, output };
    if (Date.now() >= deadlineAt) return { exitCode: 124, output };
    if (exitCode === 0 && result.exitCode !== 0) exitCode = result.exitCode;
  }
  return { exitCode, output };
}
