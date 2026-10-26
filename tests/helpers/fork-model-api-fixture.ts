import type { Server } from "bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import type { StartServerDeps } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome } from "./isolated-codex-home";
import { removeTreeWithRetry } from "./remove-tree";

export async function startForkModelApiFixture(config: OcxConfig) {
  return startForkModelApiFixtureWithDeps(config);
}

export async function startForkModelApiFixtureWithDeps(config: OcxConfig, deps: StartServerDeps = {}, primaryPortMatchesConfig = false) {
  if (primaryPortMatchesConfig && (!config.port || [10100, 10101].includes(config.port))) throw new Error("Expected a temporary primary port");
  const previousHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-fork-api-"));
  process.env.OPENCODEX_HOME = home;
  const codex = installIsolatedCodexHome();
  const bound: Server<unknown>[] = [];
  const logicalBinds: Array<{ hostname: string; port: number }> = [];
  const cleanup = async () => {
    await flushNativeMainStartupReleases();
    await flushConfigDirHardeningForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    codex.restore();
    removeTreeWithRetry(home);
  };
  try {
    saveConfig(config);
    const server = startServer(undefined, {
      ...deps,
      bindListener(options) {
        logicalBinds.push({ hostname: options.hostname as string, port: options.port as number });
        const port = primaryPortMatchesConfig && options.port === config.port ? config.port : 0;
        const listener = deps.bindListener
          ? deps.bindListener({ ...options, port })
          : Bun.serve({ ...options, port });
        bound.push(listener as Server<unknown>);
        return listener;
      },
    });
    const api = logicalBinds.findIndex(bind => bind.hostname === "0.0.0.0" && bind.port === 10100);
    return {
      primaryUrl: `http://127.0.0.1:${server.port}`,
      apiUrl: api === -1 ? null : `http://127.0.0.1:${bound[api]!.port}`,
      logicalBinds, bound, server, adminToken: process.env.OPENCODEX_ADMIN_AUTH_TOKEN ?? readFileSync(join(home, "admin-api-token"), "utf8").trim(),
      async close() { try { await server.stop(true); } finally { await cleanup(); } },
    };
  } catch (error) {
    await waitForFailedStartRollback(error);
    await cleanup();
    throw error;
  }
}
