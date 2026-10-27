import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "./repo-root";
import { removeTreeWithRetry } from "./remove-tree";

export async function runForkModelApiCliFixture(args: readonly string[], config: OcxConfig,
  scenario: "preflight-busy" | "bind-race" | "primary-busy",
): Promise<{ exitCode: number; stdout: string; stderr: string; logicalBinds: Array<{ kind: "node" | "bun"; hostname: string; port: number }> }> {
  const home = mkdtempSync(join(tmpdir(), "ocx-fork-cli-"));
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
  const log = join(home, "binds.jsonl");
  const networkLog = join(home, "network.jsonl");
  const mapping = join(home, "mapping.json");
  for (const dir of [".codex", ".claude", ".opencodex", "tmp", ".config", ".cache", ".data"]) mkdirSync(join(home, dir));
  writeFileSync(join(home, ".opencodex", "config.json"), JSON.stringify(config));
  writeFileSync(join(home, ".codex", "config.toml"), "");
  writeFileSync(log, "");
  writeFileSync(networkLog, "");
  writeFileSync(mapping, JSON.stringify({ scenario, primaryPort: config.port, busyPort: busy.port, log, networkLog }));
  const child = Bun.spawn([process.execPath, "--preload", repoPath("tests/helpers/fork-model-api-cli-preload.ts"), repoPath("src/cli/index.ts"), ...args], {
    cwd: repoPath(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".data"),
      OCX_FORK_CLI_MAPPING: mapping, OPENCODEX_API_AUTH_TOKEN: "fixture-cli-data-key", OPENCODEX_ADMIN_AUTH_TOKEN: "fixture-cli-admin-key", OCX_DISABLE_UPDATE_CHECK: "1" },
  });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut) throw new Error(`CLI fixture timeout: ${stdout}\n${stderr}`);
    if (!readFileSync(log, "utf8")) throw new Error(`CLI exited before binding: ${stdout} ${stderr}`);
    if (/Unmapped|Unexpected net.listen/.test(stderr)) throw new Error(stderr);
    const network = readFileSync(networkLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (network.some(call => call.actualHostname !== "127.0.0.1" || ![0, busy.port].includes(call.actualPort) || [10100, 10101].includes(call.actualPort))) throw new Error("CLI network mapping escaped fixture");
    return { exitCode, stdout, stderr, logicalBinds: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
  } finally {
    clearTimeout(watchdog);
    child.kill();
    await child.exited;
    await busy.stop(true);
    removeTreeWithRetry(home);
  }
}
