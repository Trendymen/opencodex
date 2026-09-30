# Responses Reset Replay Boundary

The ambiguous reset refusal applies across Responses, Chat, and Claude-facing relays. The [Responses failover contract](responses-failover.md) owns the resend grant; this document records how every delivery path settles that grant and tells clients whether to retry.

## Ambiguous connection-reset replay boundary

Three failures look alike from the outside — the turn may have executed and we cannot
prove otherwise — and they are answered differently, because the status is an instruction
to the client and the client obeys it. Codex builds its retry policy from
`ApiRetryConfig { retry_429: false, retry_5xx: true, max_attempts: request_max_retries() }`
with `DEFAULT_REQUEST_MAX_RETRIES = 4`. A 5xx is therefore an invitation to send the whole
turn up to four more times, and a 429 is where the client stops.

**A pre-header fetch rejection this proxy refuses to replay is a refusal this proxy made.**
`src/lib/upstream-retry.ts` returns a marked **429** carrying its own code,
`upstream_reset_replay_refused`. No response headers is not evidence that the model POST
was never processed, so the decision not to replay is ours, made before any response
existed — the same shape as `request_send_budget_exhausted`, and it takes the same status
for the same reason. An explicitly replay-safe operation retries instead, and a provider that
opted into `retryOnReset` may spend the request's single replacement grant; once that grant is
gone, or the leg has no send left, or a later attempt fails any other way, the leg settles as
this same refusal. Nothing on that path hands the client a status that invites the whole turn
to be sent again. See [ambiguous-resend gate](responses-failover.md#ambiguous-resend-gate).

That includes what the replacement send itself answers. Once the grant is spent, the first send
may already have run the turn, so `settleOperatorReplacement` sorts the replacement's answer, for
the pre-header row in `fetchWithResetRetry` and the WebSocket row alike:

| Replacement answer | Result |
| --- | --- |
| 2xx | Returned unchanged. |
| 307, 308, 401, 402, 408, 409, 413, 429, or any 5xx | Body released; settles as the refusal. |
| Any other status | Real status and non-replayability kept; bounded client projection retains allowlisted error type and code and `x-should-retry: false` when present, withholds upstream body text and all other upstream headers, and emits a fixed generic message. |

The refusal set is everything that would send again: the client retry table (408, 409, 429,
every 5xx, which the Codex client retries whatever the headers say), a client following a
307/308 with the same body, a 413 answered as a context overflow the client compacts and resends,
and this proxy's credential and quota recovery (401 refresh or rotation, 402/429 account
rotation). The gateway statuses in `isTransientUpstreamStatus` are only
a subset; 429 and 529 escaped them before. A kept status stays the upstream's evidence for the
caller, and the marker stops every recovery loop that checks it, such as the opaque-blob rebuild
of a 400 or the Codex pool's gated-model retry. A combo rebuilds a failed attempt as a new
response, so `consumeComboFailure` records `nonReplayable` and the combo stops rather than hopping
on, say, a context overflow. The cost is that a real 401, 402 or 429 on a replacement send is not
recorded against its credential on that request.

A 2xx replacement carries no marker, and its stream can still fail before any output. A marker
cannot carry that case, because the combo preflight rebuilds the failure as a fresh Response, so
the request execution budget's `ambiguousResendSpent` is what stops the combo, for all three
replacement rows (pre-header, SSE and WebSocket): a status the client would resend becomes the
refusal, and anything else keeps its status and the non-replayable marker. The direct path skips
the streamed opaque-blob rebuild and settles the preflight's projected failure by the same rule.
Policy fallback does not hop on a marked answer.
A scope derived from a budget this factory did not build (the shape-tested bridge in
`src/lib/request-execution-budget.ts`) remembers a grant it claimed through the bridge, keyed by
the bridged parent, so every sibling scope reports it spent even when that parent predates the
`ambiguousResendSpent` flag.

**An upstream reset observed mid-stream or after a terminal keeps its existing behaviour.**
The passthrough read path still settles a genuine upstream reset as a synthetic 502, and the
Codex WebSocket transport still settles `upstream_closed_before_response` (socket closed
after the create frame) and `upstream_no_response` (origin never produced an event) as 502
and 504. Those describe something the upstream did after our send, and they are the contract
the public server reference already documents. The 504 and a drop after the response started
are never replaced. Only the 502 of a socket that closed or errored before any Responses event
may be replaced over HTTP, when the provider opted into `retryOnReset` (#4191). That replacement
claims from the request's one allowance; if it resets before its head, that is the pre-header row
again and may use a configured second replacement, otherwise it settles as the refusal.

This reclassification is the recorded behaviour change: before it, the pre-header refusal
borrowed `upstream_closed_before_response` and its 502, which multiplied the duplicate send
the refusal exists to prevent. The distinct code is what keeps the two separable afterwards —
both are non-replayable, but only one is ours to restate.

Because the refusal now carries 429, a 429 is no longer sufficient evidence of a provider
rate limit. Every same-target replay, key rotation, account rotation and pool-quota recorder
that keys on 429 first asks `isNonReplayableResponse`:
`src/server/responses/adapter-dispatch.ts`, `src/server/responses/adapter-continuation.ts`,
`src/server/responses/passthrough-dispatch.ts`, `src/server/responses/compact.ts` and
`src/server/chat-native.ts`. Compact additionally records the transport outcome rather than
the client-facing status, so pool health sees exactly what it saw before the correction.
Rotating on a synthetic 429 would both re-send an inference that may already have run and
write a cooldown against a credential that refused nothing — a false signal that outlives the
request, which is the same hazard `rotateRunTurnAdapterOnPreflight429` already guards for the
send budget.

In `adapter-dispatch.ts` the guard at the top of the recovery loop is necessary and was not
sufficient. The refusal can also be produced by a refetch made INSIDE an arm, and that arm
then still holds it: the same-target loop re-enters while `rateLimitRetries` is below the
configured attempts, and the key, Anthropic-pool and generic-OAuth rotations re-enter while a
credential is left to try. The key-401 arm is in the same class from the other direction — its
refetch answers 429 and it falls through into the arms below. So every arm that reassigns
`upstreamResponse` from `rebuildAndRefetch` re-enters the loop guard rather than continuing,
which is what makes the top-of-loop check the single exit for this verdict.

**A refusal this proxy made never acquires a `Retry-After` and never becomes quota evidence.**
Guarding the ten call sites that READ 429 as a rate limit left the sites that WRITE evidence,
synthesize a wait, or re-classify the status on the way out. `isNonReplayableResponse` is the
wrong question for those, because it also covers the WebSocket post-send verdicts, which are
genuine upstream observations; the question is whether any upstream produced this status at
all. `isReplayRefusalResponse` in `src/lib/upstream-retry.ts` answers exactly that, applied
where the refusal is synthesized and reapplied by `src/bridge/errors.ts` when the formatter
re-wraps it after combo failure consumption. Three writers consult it or the code:
`src/server/responses/passthrough-delivery.ts` skips `recordCodexUpstreamOutcome`, which would
otherwise classify the synthetic 429 as quota exhaustion and cool the account;
`src/server/responses/passthrough-error.ts` suppresses the retryable-429 default and drops any
inherited header, taking provenance from the caller that still holds the response and falling
back to the code in the body — provenance is not optional there, because the bounded read
answers with an empty string for anything not display-safe and an empty body is exactly what
the default fires on; and `src/server/chat-native.ts` restores the code its own classifier overwrote —
429 maps to `rate_limit_error`, which already carries a code, so the branch that copies an
upstream code could never reach it — and suppresses the same synthetic wait.

**The verdict is a property of the response, and every surface states it the same way.** The
translated Chat wrapper in `src/server/chat-completions.ts` was the fourth writer and the one
that had none of this: it preserved the cyber-policy code and `model_not_found`, took the
upstream code only when `classifyError` had produced none, and then attached the retryable-429
default. A refusal therefore left the Chat bridge as an ordinary rate limit carrying an
instruction to send the turn again. It now reads the same two things the native surface reads —
`isReplayRefusalResponse` on the response it still holds, and `isReplayRefusalCode` on a body
that came through an intermediate formatter — and never the status, which a refusal and a real
rate limit share. The failed-envelope path in the same function restates it too, so a refusal
arriving as `status: "failed"` is not reported as the 502 a Codex client retries four times.
Because a re-wrap is where the in-process marker is lost, `retainReplayRefusal` and
`carryReplayRefusal` in `src/lib/upstream-retry.ts` are what each formatter calls:
`src/bridge/errors.ts`, `src/server/responses/passthrough-error.ts`, both Chat wrappers, the
routed Claude Messages wrapper, and the deferred-logging re-wrap in `src/server/relay.ts`.

**Dropping `Retry-After` is necessary and not sufficient.** The status stays 429 because Codex
stops there and a 5xx invites four more sends, but the Stainless-generated clients — `openai`
and `anthropic`, Python and Node — decide from a status table that includes 429 and compute
their own backoff when no wait is named, so a bare 429 is still resent by most callers of this
proxy. Every surface therefore also emits `x-should-retry: false`, the one signal those clients
read before that table. The refusal is the only code that gets it: the WebSocket post-send
verdicts are genuine upstream observations and keep their existing 502/504 contract. The
acceptance evidence is a count, not a shape — `tests/server/replay-refusal-parity.test.ts` runs
the proxy over a socket, drives all four surfaces with a client that implements the published
SDK rule, and asserts one physical upstream send per logical request, with a rate-limit control
that shows the same client resending.

The existing provider HTTP-status policy and the shared physical-send budget remain
independent: zero refuses dispatch, invalid counts fail, and a stopped send is counted once.
A denied first combo target returns a local typed 429 `request_send_budget_exhausted` without dispatch; a denied later hop, like a ladder with no target left, returns the last real upstream failure without contacting that target.
Exception at both exits (`exhaustedFailure` in `core-combo.ts`): when that last failure is a 400/401/403 (a fallback refusing its own credential or plan), the first 429/402 of the ladder is returned instead, and the logical log adopts that quota failure's child diagnostics while retaining every physical attempt and its spend history. When no target answered with quota evidence, a 503 `combo_unavailable` is considered only from target/expiry pairs snapshotted before dispatch for unexpired 429/402 cooldowns passing the picker's provider availability and cached quota checks, without evaluating request eligibility. Only this exhaustion branch evaluates snapshot targets' request eligibility, treating throws as ineligible, and its `Retry-After` uses the earliest still-active eligible snapshot expiry; non-quota cooldowns, disabled/ineligible targets and cooldowns created during this request cannot replace the fallback refusal or shorten the delay. Coverage: `tests/responses/responses-combo-exhausted-error.test.ts`.
`src/bridge/errors.ts` retains only the allowlisted non-replayable transport codes,
reapplies the in-process marker, attaches no `Retry-After`, and restates 429 for the refusal
code alone so a combo or adapter formatter holding an upstream-shaped 502 cannot hand the
client back a retryable status. Other upstream codes keep the existing classification;
cyber-policy hard blocks retain precedence. The helper, formatter and public Responses count
regressions live in `tests/lib/upstream-retry.test.ts`,
`tests/responses/responses-send-budget-counts.test.ts` and
`tests/codex-integration/reserve-dispatch.test.ts`. The three write-side paths are pinned
separately: a second armed same-target attempt in
`tests/responses/responses-send-budget-counts.test.ts`, the absent cooldown and absent
`Retry-After` on a Codex pool account in `tests/responses/responses-account-label.test.ts`,
the formatter in `tests/server/retry-after-429.test.ts`, and the native Chat classification in
`tests/providers/upstream-transient-retry.test.ts`.

