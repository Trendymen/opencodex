import type { Server } from "bun";
import { isLinkManagementPath } from "../link/management-routes";
import { AuxiliaryListenerBindError } from "../server/ports";
import type { ForkModelApiTopology } from "./model-api-listener-config";

export type ForkModelApiBinder<T> = (options: Bun.Serve.Options<T>) => Server<T>;
export type ForkModelApiRuntimeSnapshot = {
  topology: ForkModelApiTopology;
  active: boolean;
  bind: { hostname: string; port: number } | null;
};
export interface ForkModelApiListener<T> {
  start(options: Bun.Serve.Options<T>): void;
  owns(server: Server<T>): boolean;
  snapshot(): ForkModelApiRuntimeSnapshot;
  stop(close?: boolean): Promise<void>;
}

export function forkModelApiRouteAllowed(url: URL): boolean {
  return url.pathname.startsWith("/v1/") && !isLinkManagementPath(url.pathname);
}

export function createForkModelApiListener<T>(topology: ForkModelApiTopology, deps: {
  bind: ForkModelApiBinder<T>;
  track: <S extends { stop(close?: boolean): void | Promise<void> }>(server: S) => S;
}): ForkModelApiListener<T> {
  let server: Server<T> | undefined;
  let stopping: Promise<void> | undefined;
  return {
    start(options) {
      if (topology.mode !== "auxiliary" || server || stopping) return;
      try { server = deps.track(deps.bind({ ...options, unix: undefined, ...topology.listener })); }
      catch (cause) { throw new AuxiliaryListenerBindError("forkModelApiListener", topology.listener.port, topology.listener.hostname, cause); }
    },
    owns(candidate) { return candidate === server; },
    snapshot() { return { topology, active: server !== undefined && stopping === undefined, bind: server && !stopping ? { hostname: server.hostname!, port: server.port! } : null }; },
    async stop(close) {
      if (!server) return;
      stopping ??= Promise.resolve().then(() => server!.stop(close));
      await stopping;
    },
  };
}
