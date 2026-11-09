import { spyOn } from "bun:test";
import * as prepareModule from "../../src/server/responses/request-prepare";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import type { SessionEffortObservation } from "../../src/usage/session-effort-observation";

export function probeSessionEffortSource(matches: (options: HandleResponsesOptions) => boolean, forceClientMarker: boolean) {
  const calls: Array<{ marker: boolean | undefined; observation: SessionEffortObservation | undefined }> = [];
  const original = prepareModule.prepareResponsesRequest;
  const spy = spyOn(prepareModule, "prepareResponsesRequest").mockImplementation(async (context, admission, dispatchers) => {
    if (!matches(context.options)) return original(context, admission, dispatchers);
    const body = await context.req.clone().json() as Record<string, unknown>;
    body.reasoning = { effort: "high" };
    body.input = [...(Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }]),
      { type: "configuration_update", reasoning: { effort: "max" } }];
    const req = new Request(context.req.url, { method: context.req.method, headers: context.req.headers, body: JSON.stringify(body), signal: context.req.signal });
    const options = forceClientMarker ? { ...context.options, clientInitialResponses: true, sessionEffortCapture: { captured: false } } : context.options;
    const prepared = await original({ ...context, req, options }, admission, dispatchers);
    calls.push({ marker: context.options.clientInitialResponses, observation: context.logCtx.sessionEffortObservation });
    return prepared;
  });
  return { calls, restore: () => spy.mockRestore() };
}
