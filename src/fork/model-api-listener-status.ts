import * as z from "zod/v4";
import type { ForkModelApiRuntimeSnapshot } from "./model-api-listener";
import type { ForkModelApiTopology } from "./model-api-listener-config";

export type ForkModelApiStatus = {
  enabled: boolean;
  active: boolean | null;
  hostname: string | null;
  port: number | null;
  inactiveReason: "disabled" | "primary-non-loopback" | "not-running" | "unverified" | null;
  restartRequired: boolean | null;
};

const bind = z.object({ hostname: z.string(), port: z.number().int().min(0).max(65535) });
const runtimeSnapshot: z.ZodType<ForkModelApiRuntimeSnapshot> = z.object({
  topology: z.union([
    z.object({ mode: z.enum(["disabled", "primary"]), primary: bind, listener: z.null() }),
    z.object({ mode: z.literal("auxiliary"), primary: bind, listener: z.object({ hostname: z.literal("0.0.0.0"), port: z.literal(10100) }) }),
  ]),
  active: z.boolean(), bind: bind.nullable(),
});

export function parseForkModelApiRuntimeSnapshot(value: unknown): ForkModelApiRuntimeSnapshot | null {
  const parsed = runtimeSnapshot.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function projectForkModelApiStatus(
  desired: ForkModelApiTopology, observed: ForkModelApiRuntimeSnapshot | null, running: boolean,
): ForkModelApiStatus {
  const enabled = desired.mode !== "disabled";
  if (!running) return { enabled, active: false, hostname: null, port: null, inactiveReason: "not-running", restartRequired: false };
  if (!observed) return { enabled, active: null, hostname: null, port: null, inactiveReason: "unverified", restartRequired: null };
  const topology = observed.topology;
  return {
    enabled, active: observed.active, hostname: observed.bind?.hostname ?? null, port: observed.bind?.port ?? null,
    inactiveReason: observed.active ? null : topology.mode === "disabled" ? "disabled"
      : topology.mode === "primary" ? "primary-non-loopback" : "not-running",
    restartRequired: desired.mode !== topology.mode || desired.primary.hostname !== topology.primary.hostname
      || desired.primary.port !== topology.primary.port,
  };
}
