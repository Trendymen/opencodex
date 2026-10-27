import * as z from "zod/v4";

export type ForkModelApiListenerConfig = { enabled: boolean };

export const forkModelApiListenerSchema = z.object({ enabled: z.boolean() }).strict();

export class ForkModelApiConfigurationError extends Error {
  constructor(message: string) {
    super(`forkModelApiListener: ${message}`);
    this.name = "ForkModelApiConfigurationError";
  }
}

export type ForkModelApiTopology =
  | { mode: "disabled" | "primary"; primary: { hostname: string; port: number }; listener: null }
  | { mode: "auxiliary"; primary: { hostname: string; port: number }; listener: { hostname: "0.0.0.0"; port: 10100 } };

type TopologyConfig = { hostname?: string; port?: number; forkModelApiListener?: ForkModelApiListenerConfig };

export function resolveForkModelApiTopology(config: TopologyConfig, effectiveMainPort?: number): ForkModelApiTopology {
  const option = config.forkModelApiListener;
  if (option !== undefined && !forkModelApiListenerSchema.safeParse(option).success) {
    throw new ForkModelApiConfigurationError("expected an object containing only boolean enabled");
  }
  if (option?.enabled && config.hostname !== undefined && typeof config.hostname !== "string") {
    throw new ForkModelApiConfigurationError("enabled listener requires a valid main hostname");
  }
  const configuredHost = typeof config.hostname === "string" ? config.hostname.trim() : undefined;
  const hostname = !configuredHost || /^localhost\.?$/i.test(configuredHost) ? "127.0.0.1" : configuredHost;
  const port = effectiveMainPort !== undefined ? effectiveMainPort : config.port !== undefined ? config.port : 10100;
  const primary = { hostname, port };
  if (!option?.enabled) return { mode: "disabled", primary, listener: null };
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ForkModelApiConfigurationError("enabled listener requires a valid main port");
  }
  // Match the native bind-scope predicate without importing its catalog dependencies.
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  const loopback = ["127.0.0.1", "::1", "[::1]"].includes(normalizedHost);
  if (loopback) {
    if (port === 10100) throw new ForkModelApiConfigurationError("loopback main port must differ from model API port 10100");
    return { mode: "auxiliary", primary, listener: { hostname: "0.0.0.0", port: 10100 } };
  }
  if (port !== 10100) throw new ForkModelApiConfigurationError("nonloopback main port must be 10100");
  return { mode: "primary", primary, listener: null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function assertForkModelApiRawConfig(raw: unknown): void {
  const config = record(raw);
  if (!config || config.forkModelApiListener === undefined) return;
  resolveForkModelApiTopology(config as TopologyConfig);
}

export function assertForkModelApiLoadPreserved(raw: unknown, loaded: unknown): void {
  const source = record(raw);
  if (record(source?.forkModelApiListener)?.enabled !== true) return;
  const target = record(loaded);
  if (record(target?.forkModelApiListener)?.enabled !== true) {
    throw new ForkModelApiConfigurationError("explicit enable was lost during config loading");
  }
  const before = resolveForkModelApiTopology(source as TopologyConfig);
  const after = resolveForkModelApiTopology(target as TopologyConfig);
  if (before.mode !== after.mode || before.primary.hostname !== after.primary.hostname || before.primary.port !== after.primary.port) {
    throw new ForkModelApiConfigurationError("main topology changed during config loading");
  }
}
