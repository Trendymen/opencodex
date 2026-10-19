import type { OcxConfig } from "../../src/types";
import type { CodexPassthroughConfig } from "../../src/fork/codex-passthrough-contract";
import { CODEX_PASSTHROUGH_CATALOG } from "../../src/fork/codex-passthrough-contract";
import { reserveIngressFixture, ACCESS, PROXY_KEY } from "./reserve-ingress-fixture";

export function disabledCodexPassthrough(): CodexPassthroughConfig {
  return { ...Object.fromEntries(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group !== "localErrors").map(row => [row.key, false])),
    localErrorPolicies: Object.fromEntries(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group === "localErrors").map(row => [row.key, false])) };
}

export async function createCodexPassthroughFixture(options: {
  mode: "direct" | "pool";
  configure?: (config: OcxConfig) => void;
  upstream: (request: Request) => Promise<Response>;
}) {
  const localFetch = globalThis.fetch;
  const fixture = await reserveIngressFixture({ primaryLoopback: true, configure(config) {
    config.providers.openai!.codexAccountMode = options.mode;
    config.streamMode = "legacy-tee";
    if (options.mode === "pool") config.activeCodexAccountId = "__main__";
    options.configure?.(config);
  } });
  const fixtureFetch = globalThis.fetch;
  const seen: { body: unknown; headers: Headers }[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://chatgpt.com/backend-api/codex/responses") {
      seen.push({ body: await request.clone().json(), headers: new Headers(request.headers) });
      return options.upstream(request);
    }
    return fixtureFetch(input, init);
  }, { preconnect() {} });
  return {
    publicBase: fixture.publicBase,
    seen: seen as readonly { body: unknown; headers: Headers }[],
    request(body: unknown, headers?: HeadersInit): Promise<Response> {
      const incoming = new Headers(headers);
      if (!incoming.has("authorization")) incoming.set("authorization", `Bearer ${options.mode === "direct" ? ACCESS : PROXY_KEY}`);
      incoming.set("content-type", "application/json");
      return localFetch(`${fixture.publicBase}/v1/responses`, { method: "POST", headers: incoming, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    },
    close: fixture.close,
  };
}
