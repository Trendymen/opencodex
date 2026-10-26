import type { Server } from "bun";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import type { StartServerDeps } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { installIsolatedCodexHome } from "./isolated-codex-home";
import { removeTreeWithRetry } from "./remove-tree";
import { currentServerFixtureConfig, settleServerAuthFixture } from "./server-auth-fixture";

interface ForkModelApiFixtureOptions {
  upstreamUrl?: string;
  prepare?: (homes: { home: string; codexHome: string }) => void;
}

export async function waitForForkModelApi(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

export async function connectForkModelApiSocket(apiUrl: string, path: string, options?: ConstructorParameters<typeof WebSocket>[1]) {
  const socket = new WebSocket(apiUrl.replace("http:", "ws:") + path, options);
  const frames: string[] = [];
  socket.addEventListener("message", event => frames.push(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket open deadline exceeded")); }, 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket upgrade failed")); }, { once: true });
  });
  return { socket, frames };
}

export async function startForkModelApiFixture(config: OcxConfig, options: ForkModelApiFixtureOptions = {}) {
  return startForkModelApiFixtureWithDeps(config, {}, false, options);
}

export async function startForkModelApiFixtureWithDeps(config: OcxConfig, deps: StartServerDeps = {}, primaryPortMatchesConfig = false, options: ForkModelApiFixtureOptions = {}) {
  if (primaryPortMatchesConfig && (!config.port || [10100, 10101].includes(config.port))) throw new Error("Expected a temporary primary port");
  const previousHome = process.env.OPENCODEX_HOME;
  const inherited = Object.entries(process.env).filter(([name]) => /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BEARER_TOKEN|SECRET|CREDENTIAL)|^(?:https?_proxy|all_proxy|no_proxy)$/i.test(name));
  for (const [name] of inherited) delete process.env[name];
  const home = mkdtempSync(join(tmpdir(), "ocx-fork-api-"));
  process.env.OPENCODEX_HOME = home;
  const codex = installIsolatedCodexHome();
  clearRequestLogsForTests();
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const redirect = (url: URL): URL => {
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url;
    if (!options.upstreamUrl || !["api.openai.com", "chatgpt.com", "api.anthropic.com"].includes(url.hostname)) {
      throw new Error(`Unexpected non-local fixture destination: ${url.origin}${url.pathname}`);
    }
    const target = new URL(url.pathname + url.search, options.upstreamUrl);
    if (url.protocol === "wss:" || url.protocol === "ws:") target.protocol = "ws:";
    return target;
  };
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const target = redirect(new URL(input instanceof Request ? input.url : String(input)));
    return originalFetch(input instanceof Request ? new Request(target, input) : target, init);
  }, { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
      super(redirect(new URL(String(url))), protocols);
    }
  } as typeof WebSocket;
  const bound: Server<unknown>[] = [];
  const logicalBinds: Array<{ hostname: string; port: number }> = [];
  const cleanup = async () => {
    try { await settleServerAuthFixture(home, codex.path); }
    finally {
      clearRequestLogsForTests();
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = OriginalWebSocket;
      for (const name of Object.keys(process.env)) {
        if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BEARER_TOKEN|SECRET|CREDENTIAL)|^(?:https?_proxy|all_proxy|no_proxy)$/i.test(name)) delete process.env[name];
      }
      for (const [name, value] of inherited) process.env[name] = value;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      codex.restoreEnvironment();
    }
    codex.removeAfterDrain();
    removeTreeWithRetry(home);
  };
  try {
    options.prepare?.({ home, codexHome: codex.path });
    saveConfig(currentServerFixtureConfig({ ...config, clientIntegrations: { codex: false } }));
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
      home, codexHome: codex.path,
      async close() { try { await server.stop(true); } finally { await cleanup(); } },
    };
  } catch (error) {
    await waitForFailedStartRollback(error);
    await cleanup();
    throw error;
  }
}
