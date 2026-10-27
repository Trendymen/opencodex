import type { ServerIngress } from "./serve-options";
import { isLoopbackHostname } from "../auth-cors";
import { isClaudeInterceptedPath } from "../../claude/intercept/listener";

export function trustedLoopbackForIngress(ingress: ServerIngress, hostname: string): boolean {
  return ingress === "unauthenticated-loopback"
    || (ingress === "public" && isLoopbackHostname(hostname));
}

/**
 * Routes the Claude intercept TLS listener may reach. Everything else on that socket is relayed
 * to the real upstream by the listener itself, so a request that lands here with another path
 * is a bug, not a client — refuse it.
 */
export function claudeInterceptRouteAllowed(url: URL, req: Request): boolean {
  return isClaudeInterceptedPath(url.pathname, req.method);
}
