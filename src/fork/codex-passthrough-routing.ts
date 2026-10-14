import type { RouteResult } from "../router";
import type { InboundWire } from "../providers/registry/types";
import { resolveWireProtocolOverride } from "../server/adapter-resolve";
import { resolveCodexPassthroughAttempt, type CodexPassthroughTurn } from "./codex-passthrough-turn";

export function routedCodexPassthroughPermissions(turn: CodexPassthroughTurn | undefined,
  route: Pick<RouteResult, "providerName" | "provider" | "modelId" | "staticPolicy">, inboundWire: InboundWire) {
  return resolveCodexPassthroughAttempt(turn, { providerName: route.providerName, inboundWire,
    provider: resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy) });
}
