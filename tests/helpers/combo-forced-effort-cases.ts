import { expect, test } from "bun:test";
import { managementFetch as fetch } from "./management-auth";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

interface Harness<Server> {
  serve(handler: (request: Request) => Response | Promise<Response>): Server;
  baseUrl(server: Server): string;
  chatSuccess(text: string, model?: string): Response;
  chatStream(text: string): Response;
  provider(adapter: string, url: string, apiKey: string, extra?: Partial<OcxProviderConfig>): OcxProviderConfig;
  comboConfig(providers: OcxConfig["providers"], targets?: Array<{ provider: string; model: string }>,
    extra?: Partial<NonNullable<OcxConfig["combos"]>[string]>): OcxConfig;
  post(config: OcxConfig, raw?: Record<string, unknown>): Promise<Response>;
  postLogged(config: OcxConfig, raw?: Record<string, unknown>, options?: { clientInitialResponses?: boolean }): Promise<Response>;
  latestAttemptReceipts(config: OcxConfig): Promise<{ log: unknown; usage: unknown }>;
}

/** Register inside the parent describe: its isolated homes, mocks and cleanup still apply. */
export function registerComboForcedEffortCases<Server>({
  serve, baseUrl, chatSuccess, chatStream, provider, comboConfig, post, postLogged, latestAttemptReceipts,
}: Harness<Server>): void {
  test("Responses ingress keeps the initial observation across forced combo effort and cap", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const upstream = serve(async request => { bodies.push(await request.json() as Record<string, unknown>); return chatSuccess("ok", "m1"); });
    const config = comboConfig({ a: provider("openai-chat", baseUrl(upstream), "key-a", { reasoningEfforts: ["low", "medium", "high", "max"] }) }, undefined,
      { defaultEffort: "high", defaultEffortMode: "force" });
    config.effortCap = "medium";
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn" }, body: JSON.stringify({
        model: "combo/free", stream: false, reasoning: { effort: "high" }, input: [{ type: "configuration_update", reasoning: { effort: "max" } }, { role: "user", content: "hello" }],
      }) });
      expect(response.status).toBe(200);
      await response.text();
      expect(bodies[0]?.reasoning_effort).toBe("medium");
      const { log, usage } = await latestAttemptReceipts(config);
      for (const row of [log, usage]) expect(row).toMatchObject({
        sessionEffortObservation: { clientEffort: "high", sessionEffort: "max", status: "visible" },
        requestedEffort: "high->medium", effectiveEffort: "medium", reasoningWireField: "reasoning_effort", reasoningWireValue: "medium",
      });
    } finally { await server.stop(true); }
  });

  test("Responses combo force changes the wire effort while preserving the initial observation", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const upstream = serve(async request => { bodies.push(await request.json() as Record<string, unknown>); return chatSuccess("ok", "m1"); });
    const config = comboConfig({ a: provider("openai-chat", baseUrl(upstream), "key-a", { reasoningEfforts: ["low", "medium", "high", "max"] }) }, undefined,
      { defaultEffort: "max", defaultEffortMode: "force" });
    saveConfig(config);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "combo/free", stream: false, reasoning: { effort: "high" }, input: [{ type: "configuration_update", reasoning: { effort: "max" } }, { role: "user", content: "hello" }],
      }) });
      expect(response.status).toBe(200);
      await response.text();
      expect(bodies[0]?.reasoning_effort).toBe("max");
      const { log, usage } = await latestAttemptReceipts(config);
      for (const row of [log, usage]) expect(row).toMatchObject({
        sessionEffortObservation: { clientEffort: "high", sessionEffort: "max", status: "visible" },
        requestedEffort: "high", effectiveEffort: "max", reasoningWireField: "reasoning_effort", reasoningWireValue: "max",
      });
    } finally { await server.stop(true); }
  });

  test("combo child failures retain the parent observation and synthetic inputs do not create one", async () => {
    const a = serve(() => Response.json({ error: { code: "insufficient_quota", message: "quota" } }, { status: 429 }));
    const b = serve(() => Response.json({ error: { message: "invalid key" } }, { status: 401 }));
    const config = comboConfig({ a: provider("openai-chat", baseUrl(a), "key-a"), b: provider("openai-chat", baseUrl(b), "key-b") }, undefined,
      { defaultEffort: "low", defaultEffortMode: "force" });
    const body = { reasoning: { effort: "high" }, input: [{ type: "configuration_update", reasoning: { effort: "max" } }, { role: "user", content: "hello" }] };
    const response = await postLogged(config, body, { clientInitialResponses: true });
    await response.text();
    expect(response.status).toBe(429);
    let receipts = await latestAttemptReceipts(config);
    for (const row of [receipts.log, receipts.usage]) expect(row).toMatchObject({ sessionEffortObservation: { clientEffort: "high", sessionEffort: "max", status: "visible" } });
    clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
    const healthy = serve(() => chatSuccess("synthetic", "m1"));
    const syntheticConfig = comboConfig({ a: provider("openai-chat", baseUrl(healthy), "key-new", { reasoningEfforts: ["low", "high", "max"] }) }, undefined,
      { defaultEffort: "low", defaultEffortMode: "force" });
    const synthetic = await postLogged(syntheticConfig, body);
    await synthetic.text();
    expect(synthetic.status).toBe(200);
    receipts = await latestAttemptReceipts(syntheticConfig);
    for (const row of [receipts.log, receipts.usage]) expect(row).not.toHaveProperty("sessionEffortObservation");
  });

  test("force-default raises Hermes-like medium to max while fallback keeps medium", async () => {
    const efforts: unknown[] = [];
    const upstream = serve(async request => {
      const body = await request.json() as Record<string, unknown>;
      efforts.push(body.reasoning_effort);
      return chatSuccess("forced", "m1");
    });
    const providers = {
      a: provider("openai-chat", baseUrl(upstream), "key-a", {
        reasoningEfforts: ["low", "medium", "high", "max"],
      }),
    };
    const forced = comboConfig(providers, undefined, {
      defaultEffort: "max",
      defaultEffortMode: "force",
    });
    expect((await post(forced, { reasoning: { effort: "medium" } })).status).toBe(200);
    const fallback = comboConfig(providers, undefined, { defaultEffort: "max" });
    expect((await post(fallback, { reasoning: { effort: "medium" } })).status).toBe(200);
    expect(efforts).toEqual(["max", "medium"]);
  });

  for (const chatEffort of [
    { name: "reasoning_effort", body: { reasoning_effort: "medium" } },
    { name: "reasoning.effort", body: { reasoning: { effort: "medium" } } },
  ] as const) {
    test(`Chat ${chatEffort.name} force-default routes through the combo and records normalized wire telemetry`, async () => {
      const upstreamBodies: Array<{ provider: string; body: Record<string, unknown> }> = [];
      const a = serve(async request => {
        upstreamBodies.push({ provider: "a", body: await request.json() as Record<string, unknown> });
        return chatStream("forced chat");
      });
      const config = comboConfig({
        a: provider("openai-chat", baseUrl(a), "key-a", {
          reasoningEfforts: ["low", "medium", "high", "max"],
        }),
      }, undefined, {
        defaultEffort: "max",
        defaultEffortMode: "force",
      });
      saveConfig(config);
      const server = startServer(0);
      try {
        const response = await fetch(new URL("/v1/chat/completions", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "combo/free",
            messages: [{ role: "user", content: "hello" }],
            stream: false,
            ...chatEffort.body,
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("forced chat");
        expect(upstreamBodies).toEqual([
          { provider: "a", body: expect.objectContaining({ model: "m1", reasoning_effort: "max" }) },
        ]);

        const { log, usage } = await latestAttemptReceipts(config);
        for (const receipt of [log, usage]) {
          expect(receipt).not.toHaveProperty("sessionEffortObservation");
          expect(receipt).toMatchObject({
            provider: "combo",
            model: "combo/free",
            requestedEffort: "medium",
            effectiveEffort: "max",
            reasoningWireField: "reasoning_effort",
            reasoningWireValue: "max",
            routeDecision: { routeKind: "combo" },
            attempts: [{
              provider: "a",
              model: "m1",
              requestedEffort: "medium",
              effectiveEffort: "max",
              reasoningWireField: "reasoning_effort",
              reasoningWireValue: "max",
            }],
          });
        }
      } finally {
        await server.stop(true);
      }
    });
  }

  test("backup noReasoningModels removes the fresh combo default", async () => {
    const a = serve(() => Response.json({ error: { message: "retry" } }, { status: 503 }));
    let backupBody: Record<string, unknown> | undefined;
    const b = serve(async request => {
      backupBody = await request.json() as Record<string, unknown>;
      return chatSuccess("no reasoning", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b", { noReasoningModels: ["m2"] }),
    }, undefined, { defaultEffort: "high" });
    expect((await post(config)).status).toBe(200);
    expect(backupBody).not.toHaveProperty("reasoning_effort");
  });

}
