# Hosted-Search Continuation Binding

The opt-in key-auth Responses hosted-search bridge in `src/server/responses/passthrough-delivery.ts` captures the
request binding that served the first leg, after any permitted initial reselection. Before every
continuation dispatch, after provider pacing, that binding must remain an API-key selection matching
the configured entry, reference, revision, resolved key, authentication mode, and base URL; a
disabled or removed provider fails the same check. Drift produces the bridge's failed terminal
without another provider request, and an unchanged binding resends the built request with its
executed search result appended, never re-entering the initial reselection/rebuild path. Initial
dispatch keeps its normal reselection policy. When the route's registry policy carries a
terminal-repair grace (`modelResponsesTerminalRepair`), the response body of every successful
continuation is wrapped by the same repair that saw the raw first leg, so a complete leg the
destination leaves open still ends that leg on schedule instead of stalling the turn. `tests/web-search/web-search-passthrough-bridge.test.ts`
covers drift during search, while pacing, and before first-leg headers return, plus successful
first-dispatch reselection and result preservation.

`providers.<name>.webSearchBridge.backend` is explicit-only. `ollama` spends that provider's API key
on the planned search endpoint. `openai`, `anthropic`, `xai`, `gemini`, and `exa` reuse the matching
sidecar executor and that executor's own credential; a missing credential leaves the bridge
disarmed rather than falling through to another paid search. A leg that mixes an intercepted
`web_search` call with another client-executed tool ends the turn on that leg: the intercepted
searches run, their hosted cells complete, the held client calls are released for the caller to
execute, and the leg's own terminal closes the turn with no continuation sent upstream. The
destination therefore does not receive that search result during the turn. It gets it on the next
one: every search the bridge executes is recorded in `src/responses/bridge-search-replay-cache.ts`
under the hosted cell's proxy-minted id, scoped to the admitted caller principal, client
conversation, and exact provider, adapter, model, destination, and physical credential binding, and bounded by entry count, total
bytes, and a one-hour TTL. An unavailable scope fails closed. The caller principal comes from
`resolveContextPrincipal`; a caller that presents no opencodex API key (a keyless loopback
client) has none and is never given a shared one, so nothing is recorded or restored for it and
its hosted cells reach the destination unchanged. When the caller replays that cell,
`restoreBridgedWebSearchCalls` in `src/adapters/openai-responses/tool-output-recovery.ts` puts the
destination's own `function_call` and the executed `function_call_output` back in the cell's
position before the next turn's first leg is dispatched, recording exactly the text
`appendBridgeSearchTurn` would have sent on a continuation leg so a replayed turn and a continued
turn show the destination one consistent conversation. The rewrite runs only for a provider with
`webSearchBridge.enabled`, and a miss — unknown id, expired entry, a different conversation or
serving binding, or a `call_id` the body already carries — leaves the replayed item untouched.
Re-running the search or synthesizing result text is not a permitted recovery. The bridge finalizes
request-scoped OpenAI sidecar authority on completion, failure, and client cancellation —
cancellation releases immediately rather than waiting on an abandoned upstream read — so a
recovery probe lease no search consumed is always returned.
`tests/web-search/web-search-bridge-replay.test.ts` pins the restore and each of those refusals.
A forward OpenAI search sidecar retries a 429 only when the requested delay fits both its retry ceiling and the remaining overall sidecar deadline. A delay that cannot fit returns and records the original 429 so pool routing retains quota evidence.
One search makes at most three physical sends in total: connection-reset recovery and 429 replays draw from the same budget, and a budget spent with a 429 in hand ends with that 429 as the recorded outcome.
A leg whose
upstream terminal is `response.failed` or `response.incomplete` runs no search at all and closes
any cell it opened rather than leaving it in progress. Assistant text is not treated as a search
instruction.

`src/web-search/passthrough-bridge.ts` withholds at most 8,388,608 UTF-16 code units of
SSE data payloads per leg; this is not a byte or total-heap measurement. A companion cap of
65,536 events is derived from that budget at a realistic 128-code-unit serialized delta, so it
only bounds per-event object overhead the character budget cannot see rather than refusing a
large client-executed tool call streamed as fine-grained argument deltas. The first over-budget
event fails the leg before releasing any held tool call, and reports that refusal as the
bridge's own bound rather than as an upstream read failure.
Read failures and exhausted continuation budgets use the same cleanup: discard held calls and
close every search cell opened by the current leg as failed before one failed terminal and DONE.
Successful release serializes held events lazily rather than building another full frame array;
release, discard, and the next leg reset the held payload counter and identity sets.
`tests/web-search/web-search-progress-stream.test.ts` covers both bounds, identity-only deltas,
upstream cancellation, cell closure, the exact event boundary, and mixed terminal controls.

The bridge backend and the global `webSearchSidecar` block are configured independently, so the
sidecar's `model` applies to a bridge search only when `resolveSidecarBackend(webSearchSidecar.backend)`
equals that bridge backend; otherwise the bridge runs the backend's own default. An unset global
backend resolves to `openai`, so an unset-backend model reaches an `openai` bridge and no other.
There is no per-provider `webSearchBridge.model`, so a mismatched backend gets the default rather
than a vendor-specific override. This is a model and settings rule, not a credential one:
`resolvePassthroughWebSearchBridgeAuth` switches on the bridge backend and consults only that
backend's credential locator, so no key crosses backends. `reasoning` and `xSearch` are not gated —
`reasoning` is a generic effort level and `xSearch` is xai-only with no per-backend default and no
`webSearchBridge` equivalent. `resolveSidecarBackend` lives in `src/web-search/sidecar-providers.ts`
rather than the `src/web-search/index.ts` barrel so the bridge can answer this question without a
value import of the barrel; the barrel re-exports it.
`tests/web-search/web-search-passthrough-bridge.test.ts` covers the mismatch and matching cases for
anthropic, xai, and gemini, plus the unset-backend default.

`providers.<name>.webSearchBridge.endpoint` names the destination that receives that provider's own
API key, so it carries the same literal destination assessment as `baseUrl`:
`providerDestinationConfigError` runs both at management write time, inside
`providerWebSearchBridgeConfigError`, and at plan time inside `resolveOllamaWebSearchEndpoint`.
Metadata destinations are refused unconditionally; loopback, localhost, and private space need the
provider's `allowPrivateNetwork` opt-in or a registry entry that is local by default, which is what
keeps a self-hosted Ollama on `127.0.0.1` working. Both checks are synchronous and literal-only and
resolve no DNS, so a hostname that resolves into metadata or private space is a disclosed residual
rather than a blocked case. That residual is strictly larger than `baseUrl`'s: `baseUrl` also runs
the async `providerDestinationResolvedError` at management write, which the endpoint does not, and
parity there would still leave the hand-edited-file path uncovered because the plan-time boundary is
synchronous. The plan-time check is the
authorization boundary rather than a second opinion: a hand-edited config file, `ocx config set`,
and `ocx config import` all reach `configSchema` only and never call
`providerWebSearchBridgeConfigError`, and `resolveOllamaWebSearchEndpoint` is the only reader of
this field in the tree, so a value that survives file load still cannot be spent. It refuses
silently by design; config-time is where the operator is told why. The planner requires the
provider name for that assessment, so `planPassthroughWebSearchBridge` takes it explicitly.

