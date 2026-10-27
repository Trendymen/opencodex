import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const DIAGNOSTIC_BUDGET_MS = 4_000;
const MAX_OUTPUT_BYTES = 262_144;
const MAX_PROCESSES = 128;

interface ProcessEntry {
  pid: number;
  ppid: number;
  cpuPercent?: number;
  rssKb?: number;
  executable?: string;
}

function observe(command: string, args: string[], timeout: number): string | null {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    return result.status === 0 && !result.error ? result.stdout : null;
  } catch {
    return null;
  }
}

function safeStackFrame(line: string): string {
  const path = /(^|[\s(])(\/[^\s]+)/.exec(line);
  if (!path) return line;
  const slash = path.index + path[1]!.length;
  const parentheses: number[] = [];
  for (let index = 0; index < slash; index++) {
    if (line[index] === "(") parentheses.push(index);
    else if (line[index] === ")") parentheses.pop();
  }
  const start = parentheses.at(-1) ?? slash;
  const addresses = line.slice(start).match(/\[0x[\da-f]+\]/gi) ?? [];
  return `${line.slice(0, start).trimEnd()} ${start < slash ? "([path])" : "[path]"}`
    + (addresses.length ? " " + addresses.join(" ") : "");
}

/** Save only PID relationships and stack frames; process arguments and sample headers are omitted. */
export function saveTestLaneDiagnostics(childPid: number): string {
  const deadline = Date.now() + DIAGNOSTIC_BUDGET_MS;
  // This root belongs to the observer, outside the lane's disposable HOME/TEMP.
  const root = mkdtempSync(join(tmpdir(), "ocx-test-deadline-"));
  const inventory = process.platform === "win32"
    ? observe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"], 1_000)
    : observe("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="], 1_000);
  const entries: ProcessEntry[] = [];
  for (const line of inventory?.split(/\r?\n/) ?? []) {
    const match = process.platform === "win32"
      ? line.match(/^\s*(\d+)\s+(\d+)\s*$/)
      : line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]),
      ...(match[3] ? { cpuPercent: Number(match[3]), rssKb: Number(match[4]), executable: basename(match[5]!.trim()) } : {}),
    });
  }
  const child = entries.find(entry => entry.pid === childPid && entry.ppid === process.pid);
  const owned = new Set(child ? [childPid] : []);
  for (let pass = 0; pass < 16 && owned.size < MAX_PROCESSES; pass++) {
    const before = owned.size;
    for (const entry of entries) {
      if (owned.size >= MAX_PROCESSES) break;
      if (owned.has(entry.ppid)) owned.add(entry.pid);
    }
    if (before === owned.size) break;
  }
  const processes = entries.filter(entry => owned.has(entry.pid));
  writeFileSync(join(root, "processes.json"), JSON.stringify({
    runnerPid: process.pid, childPid, processes,
    status: !child ? "process inventory unavailable" : "captured",
    truncated: owned.size >= MAX_PROCESSES,
  }, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "darwin") return root;

  // Share the bounded budget between the busiest owned descendant and the child.
  const busiest = processes.filter(entry => entry.pid !== childPid)
    .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)).slice(0, 1);
  for (const entry of [...busiest, ...(child ? [child] : [])]) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) break;
    const output = observe("sample", [String(entry.pid), "1", "-file", "/dev/stdout"], Math.min(1_500, remaining));
    const graph = output?.match(/Call graph:\s*\n([\s\S]*?)(?:\nTotal number|\nBinary Images:|$)/)?.[1];
    if (!graph) continue;
    const frames = graph.split("\n").filter(line => /^\s*[+!| :]*\d+\s/.test(line))
      .map(safeStackFrame).join("\n");
    if (frames) writeFileSync(join(root, `sample-${entry.pid}.txt`), frames + "\n", { mode: 0o600 });
  }
  return root;
}
