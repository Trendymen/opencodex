/** HTTP/SSE fixture 拒绝 canonical 上游 WS；本地客户端及其他目的地保持原样。 */
export function installHttpOnlyCodexWebSocket(): void {
  const currentWebSocket = globalThis.WebSocket;
  const prefix = "/backend-api/codex";
  globalThis.WebSocket = new Proxy(currentWebSocket, {
    construct(target, args, newTarget) {
      const url = new URL(String(args[0]));
      if (url.protocol === "wss:" && url.hostname === "chatgpt.com"
        && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
        throw new Error("HTTP-only Codex fixture rejects native upstream WebSocket");
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
}
