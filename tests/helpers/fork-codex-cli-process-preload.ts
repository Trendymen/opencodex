import * as childProcess from "node:child_process";
import { mock } from "bun:test";

const mode = process.env.OCX_FIXTURE_CODEX_PROCESS_MODE;
if (mode !== "empty" && mode !== "active" && mode !== "failure") throw new Error("invalid Codex process fixture mode");

if (Bun.isMainThread) {
  const workerUrl = new URL("../../src/codex/cli-update-worker.ts", import.meta.url).href;
  globalThis.Worker = new Proxy(globalThis.Worker, {
    construct(target, args, newTarget) {
      if (String(args[0]) === workerUrl) {
        if (args[1]?.preload) throw new Error("unexpected Codex update worker preload");
        args[1] = { ...args[1], preload: import.meta.path };
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
} else {
  const original = { ...childProcess };
  const originalExecFile = childProcess.execFile;
  const commandArgs = ["-axo", "pid=,uid=,command="];
  const executableArgs = ["-axo", "pid=,comm="];
  mock.module("node:child_process", () => ({
    ...original,
    execFile(file: string, args: string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) {
      const command = file === "/bin/ps" && JSON.stringify(args) === JSON.stringify(commandArgs);
      const executable = file === "/bin/ps" && JSON.stringify(args) === JSON.stringify(executableArgs);
      if (!command && !executable) return Reflect.apply(originalExecFile, childProcess, [file, args, options, callback]);
      const error = mode === "failure" ? Object.assign(new Error("fixture process table unavailable"), { code: "EACCES" }) : null;
      const output = mode !== "active" ? "" : command ? "4242 501 /fixture/bin/codex app-server\n" : "4242 /fixture/bin/codex\n";
      queueMicrotask(() => callback(error, output, ""));
    },
  }));
}
