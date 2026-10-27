import { Server, Socket } from "node:net";
import { appendFileSync, readFileSync } from "node:fs";
import { mock } from "bun:test";
import * as reclaim from "../../src/server/port-reclaim";

type Mapping = { scenario: "preflight-busy" | "bind-race" | "primary-busy"; primaryPort: number; busyPort: number; log: string; networkLog: string };
const mapping: Mapping = JSON.parse(readFileSync(process.env.OCX_FORK_CLI_MAPPING!, "utf8"));
function unmapped(message: string): never { console.error(`Unmapped ${message}`); process.exit(97); }
const networkRecord = (kind: string, hostname: string, port: number, actualPort: number) => {
  appendFileSync(mapping.networkLog, JSON.stringify({ kind, hostname, port, actualHostname: "127.0.0.1", actualPort }) + "\n");
};
let selectedPrimaryPort: number | undefined;
const primaryPort = (port: number) => port === 10101 || (mapping.primaryPort === 0 && (port === 0 || port === selectedPrimaryPort));
const record = (kind: "node" | "bun", hostname: string, port: number) => {
  appendFileSync(mapping.log, JSON.stringify({ kind, hostname, port }) + "\n");
  if (port !== 10100 && !primaryPort(port)) unmapped(`fixed-topology bind: ${kind} ${hostname}:${port}`);
};
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args: unknown[]) {
  const options = args[0] as { host?: string; port?: number };
  if (!options || typeof options !== "object" || typeof options.port !== "number") unmapped("net.listen signature");
  record("node", options.host ?? "", options.port);
  const busy = mapping.scenario === "preflight-busy" && options.port === 10100
    || mapping.scenario === "primary-busy" && options.port === 10101;
  if (options.port === 0) this.prependOnceListener("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") selectedPrimaryPort = address.port;
  });
  networkRecord("node-bind", options.host ?? "", options.port, busy ? mapping.busyPort : 0);
  args[0] = { ...options, host: "127.0.0.1", port: busy ? mapping.busyPort : 0 };
  return Reflect.apply(originalListen, this, args);
} as typeof originalListen;
const originalServe = Bun.serve;
Bun.serve = ((options: Bun.Serve.Options<unknown>) => {
  record("bun", options.hostname as string, options.port as number);
  const busy = mapping.scenario === "bind-race" && options.port === 10100;
  networkRecord("bun-bind", options.hostname as string, options.port as number, busy ? mapping.busyPort : 0);
  return originalServe({ ...options, hostname: "127.0.0.1", port: busy ? mapping.busyPort : 0 });
}) as typeof Bun.serve;
// Keep reclaim's probes and decision, but give its wait loop no wall-clock budget.
const reclaimListenPort = reclaim.reclaimListenPort;
mock.module("../../src/server/port-reclaim", () => ({ ...reclaim,
  reclaimListenPort: (port: number, hostname?: string, options?: reclaim.ReclaimListenPortOptions) =>
    reclaimListenPort(port, hostname, { ...options, timeoutMs: 0 }),
}));

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (port !== 10100 && !primaryPort(port)) unmapped(`outbound fetch: ${url.origin}`);
  networkRecord("fetch", url.hostname, port, mapping.busyPort);
  url.hostname = "127.0.0.1";
  url.port = String(mapping.busyPort);
  return originalFetch(input instanceof Request ? new Request(url, input) : url, init);
}) as typeof fetch, originalFetch);
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args: unknown[]) {
  const normalized = Array.isArray(args[0]) ? args[0] as unknown[] : args;
  const options = typeof normalized[0] === "object" ? normalized[0] as { port?: number; host?: string }
    : { port: Number(normalized[0]), host: typeof normalized[1] === "string" ? normalized[1] : "127.0.0.1" };
  if (options.port !== 10100 && (options.port === undefined || !primaryPort(options.port))) unmapped("outbound net.connect");
  networkRecord("net-connect", options.host ?? "", options.port, mapping.busyPort);
  if (typeof normalized[0] === "object") normalized[0] = { ...options, host: "127.0.0.1", port: mapping.busyPort };
  else { normalized[0] = mapping.busyPort; if (typeof normalized[1] === "string") normalized[1] = "127.0.0.1"; }
  return Reflect.apply(originalConnect, this, args);
} as typeof originalConnect;
