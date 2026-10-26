import { contextEndpoint } from "../../codex/context-compat";

/**
 * Routes the unauthenticated loopback listener will serve. Everything else 404s.
 *
 * This is an allowlist rather than a filter applied to the public handler, because a filter
 * inverts the failure mode: a route added later would be reachable here by default. The
 * entries below are exactly what a directly-spawned `codex app-server` needs.
 *
 * `POST /v1/alpha/search` is the native Codex web-search relay. Codex issues it against the
 * same base URL as `/v1/responses`, so leaving it off the list turned every native web search
 * on the direct-spawn host into a 404 (#3192). The handler still runs its own admission, so a
 * loopback caller without a ChatGPT credential is refused inside it rather than by this gate.
 *
 * The standalone Images client uses the same base URL for its two POST routes. Their handler
 * keeps the paid upstream behind its own admission and forward-credential checks, so admit only
 * the exact methods and paths it serves (#3428).
 *
 * `POST /v1/messages` (Anthropic wire) and `POST /v1/chat/completions` (OpenAI chat wire)
 * are the inference endpoints the hub's OWN local clients speak: `ocx claude` and the
 * `system-env` injection and Claude Desktop 3P dial the first, Cursor Private Inference, the
 * vision `routed-describe` helper and aside/opencode the second (#4236). On a hub whose
 * public listener binds a tailnet address there is no other local socket for them, so
 * leaving them off this list left every non-Codex local client pointed at a closed port.
 * Both handlers resolve their own admission from the RECEIVING listener's policy view — the
 * same resolver and the same loopback short-circuit `/v1/responses` already uses — so this
 * adds a wire, not a trust level. `/api/*` is deliberately still absent: local management
 * discovery goes to the authenticated management surface, never to this listener.
 *
 * `POST /v1/messages/count_tokens` completes that Anthropic wire. It is admitted on a
 * narrower argument than the other two rather than on symmetry: it spends no provider quota,
 * reaches no stored credential, and returns a token count computed from the request body the
 * caller already holds. Withholding it bought no confinement — the same caller may POST the
 * whole conversation to `/v1/messages` on this socket — and cost Claude Code its server-side
 * count, which it then silently replaces with a local estimate. `/api/*`, `/healthz`,
 * `/readyz` and the GUI remain 404 here, which is the boundary that actually matters.
 *
 * `GET /v1/models` is on the list for a reason that is easy to miss. When catalog
 * materialization fails or finds no source, `syncCodex` warns and injects with
 * `catalogPath: null`; Codex then builds an ONLINE model manager and `model/list` refreshes
 * through `GET {base_url}/models`. Returning 404 there would leave the picker on its bundled
 * fallback — fixing the direct-spawn host while breaking its model list.
 */
export function loopbackRouteAllowed(url: URL, req: Request): boolean {
  const path = url.pathname;
  if (path === "/v1/responses") {
    return req.method === "POST" || req.headers.get("upgrade")?.toLowerCase() === "websocket";
  }
  if (path === "/v1/responses/compact") return req.method === "POST";
  if (path === "/v1/messages" || path === "/v1/chat/completions") return req.method === "POST";
  if (path === "/v1/messages/count_tokens") return req.method === "POST";
  if (path === "/v1/audio/transcriptions") return req.method === "POST";
  if (path === "/v1/audio/transcriptions/stream") return req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (path === "/v1/alpha/search") return req.method === "POST";
  if (contextEndpoint(path)) return req.method === "POST";
  if (path === "/v1/images/generations" || path === "/v1/images/edits") {
    return req.method === "POST";
  }
  if (path === "/v1/models") return req.method === "GET";
  // Realtime voice — a directly-spawned `codex app-server` needs these for desktop voice
  // the same way it needs /v1/responses. Two shapes, same trust model as /v1/responses:
  //  - standalone sessions (codex-rs thread/realtime/start, WebSocket transport):
  //    WebSocket upgrades on the bare /v1/realtime and /v1/live paths only;
  //  - WebRTC calls (desktop v3 voice): POST call-create on /v1/live or
  //    /v1/realtime/calls, then the sideband join as a WebSocket upgrade on the keyed
  //    /v1/live/{callId}, /v1/realtime/calls/{callId}, or /v1/realtime?call_id= form
  //    (the join reaches this listener through the injected
  //    experimental_realtime_ws_base_url; openai/codex #35830).
  // Plain HTTP on the upgrade paths stays rejected.
  const isWebSocketUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (path === "/v1/realtime") return isWebSocketUpgrade;
  if (path === "/v1/live") return isWebSocketUpgrade || req.method === "POST";
  if (path === "/v1/realtime/calls") return req.method === "POST";
  if (/^\/v1\/(?:live|realtime\/calls)\/[^/]+\/?$/.test(path)) return isWebSocketUpgrade;
  return false;
}
