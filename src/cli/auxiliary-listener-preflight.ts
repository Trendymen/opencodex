import { resolveForkModelApiTopology } from "../fork/model-api-listener-config";
import type { OcxConfig } from "../types";
import { AuxiliaryListenerBindError } from "../server/ports";
import { createServer } from "node:net";

/**
 * Reject impossible auxiliary binds before startup creates private state. On Windows
 * that publication requires several synchronous ACL subprocesses. This is only an
 * early rejection: startServer still owns the actual bind and transactional rollback
 * if another process takes the port between this probe and startup.
 */
export async function assertAuxiliaryListenerPortsAvailable(config: OcxConfig, effectiveMainPort?: number): Promise<void> {
  const topology = resolveForkModelApiTopology(config, effectiveMainPort);
  const loopback = config.unauthenticatedLoopbackListener;
  const management = config.runtimeRole === "hub" ? config.hub?.managementIngress : undefined;
  const targets = [
    { listener: "unauthenticatedLoopbackListener", hostname: "127.0.0.1", port: loopback?.enabled ? loopback.port : undefined },
    { listener: "hub.managementIngress", hostname: "127.0.0.1", port: management?.enabled ? management.port : undefined },
    { listener: "forkModelApiListener", hostname: "0.0.0.0", port: topology.listener?.port },
  ] as const;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (target.port === undefined) continue;
    const duplicate = targets.slice(0, index).find(other => other.port === target.port);
    if (duplicate) throw new AuxiliaryListenerBindError(target.listener, target.port, target.hostname,
      new Error(`port is also configured for ${duplicate.listener}`));
  }
  for (const { listener, port, hostname } of targets) {
    // The port-less companion shares the public bind; it has no independent target.
    if (port === undefined) continue;
    await new Promise<void>((resolve, reject) => {
      const probe = createServer(socket => socket.destroy());
      const fail = (cause: unknown) => reject(new AuxiliaryListenerBindError(listener, port, hostname, cause));
      probe.once("error", fail);
      probe.once("listening", () => probe.close(error => error ? fail(error) : resolve()));
      try { probe.listen({ port, host: hostname }); } catch (error) { fail(error); }
    });
  }
}
