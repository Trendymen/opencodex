export function forkBaseVersion(value: unknown): string | null;
export function isSameUpstreamVersion(latest: unknown, current: unknown): boolean;
export function forkUpdateDecision(
  latest: unknown,
  current: unknown,
  channel?: "latest" | "preview",
): "same" | "proceed" | "unresolved" | "older";
export function forkVersionTagError(
  version: unknown,
  tags: readonly string[],
  tagIsAncestorOfHead?: (tag: string) => boolean,
): string | null | undefined;
