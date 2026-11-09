import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "./repo-root";
import { removeTreeWithRetry } from "./remove-tree";

export async function runForkModelApiCliFixture(args: readonly string[], config: OcxConfig,
  scenario: "preflight-busy" | "bind-race" | "primary-busy" | "owner-unknown",
): Promise<{
  exitCode: number; stdout: string; stderr: string;
  logicalBinds: Array<{ kind: "node" | "bun"; hostname: string; port: number }>;
  ownerProbes: Array<{ hostname: string; port: number; result: "ECONNREFUSED" | "fixture" }>;
  fixtureResponses: number;
  ownerState?: { before: { pid: string; journal: string; config: string }; after: { pid: string | null; journal: string | null; config: string | null } };
}> {
  const home = mkdtempSync(join(tmpdir(), "ocx-fork-cli-"));
  let fixtureResponses = 0;
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { fixtureResponses++; return new Response("fixture"); } });
  const log = join(home, "binds.jsonl");
  const networkLog = join(home, "network.jsonl");
  const probeLog = join(home, "owner-probes.jsonl");
  const mapping = join(home, "mapping.json");
  for (const dir of [".codex", ".claude", ".opencodex", "tmp", ".config", ".cache", ".data"]) mkdirSync(join(home, dir));
  writeFileSync(join(home, ".opencodex", "config.json"), JSON.stringify(config));
  const pidPath = join(home, ".opencodex", "ocx.pid");
  const journalPath = join(home, ".codex", "opencodex-journal.json");
  const codexConfigPath = join(home, ".codex", "config.toml");
  const injected = '# injected\nmodel_provider = "opencodex"\n';
  const before = scenario === "owner-unknown" ? {
    pid: String(process.pid),
    journal: JSON.stringify({ version: 1, originalConfig: Buffer.from('# original\nmodel_provider = "openai"\n').toString("base64"),
      originalProfile: null, injectedConfigHash: createHash("sha256").update(injected).digest("hex"),
      injectedProfileHash: null, pid: 999_999, timestamp: new Date().toISOString() }),
    config: injected,
  } : undefined;
  writeFileSync(codexConfigPath, before?.config ?? "");
  if (before) { writeFileSync(pidPath, before.pid); writeFileSync(journalPath, before.journal); }
  writeFileSync(log, "");
  writeFileSync(networkLog, "");
  writeFileSync(probeLog, "");
  writeFileSync(mapping, JSON.stringify({ scenario, primaryPort: config.port, busyPort: busy.port, log, networkLog, probeLog }));
  const child = Bun.spawn([process.execPath, "--preload", repoPath("tests/helpers/fork-model-api-cli-preload.ts"), repoPath("src/cli/index.ts"), ...args], {
    cwd: repoPath(), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME: join(home, ".opencodex"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      TMPDIR: join(home, "tmp"), XDG_RUNTIME_DIR: join(home, "tmp"), OCX_OWNER_REGISTRY_DIR: join(home, "registry"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".data"),
      OCX_FORK_CLI_MAPPING: mapping, OPENCODEX_API_AUTH_TOKEN: "fixture-cli-data-key", OPENCODEX_ADMIN_AUTH_TOKEN: "fixture-cli-admin-key", OCX_DISABLE_UPDATE_CHECK: "1" },
  });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut) throw new Error(`CLI fixture timeout: ${stdout}\n${stderr}`);
    if (!readFileSync(log, "utf8") && scenario !== "owner-unknown") throw new Error(`CLI exited before binding: ${stdout} ${stderr}`);
    if (/Unmapped|Unexpected net.listen/.test(stderr)) throw new Error(stderr);
    const network = readFileSync(networkLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (network.some(call => call.actualHostname !== "127.0.0.1" || ![0, busy.port].includes(call.actualPort) || [10100, 10101].includes(call.actualPort))) throw new Error("CLI network mapping escaped fixture");
    const readOptional = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
    return { exitCode, stdout, stderr, fixtureResponses,
      logicalBinds: readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
      ownerProbes: readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
      ...(before ? { ownerState: { before, after: { pid: readOptional(pidPath), journal: readOptional(journalPath), config: readOptional(codexConfigPath) } } } : {}),
    };
  } finally {
    clearTimeout(watchdog);
    child.kill();
    await child.exited;
    await busy.stop(true);
    removeTreeWithRetry(home);
  }
}
