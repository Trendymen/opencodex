export function forkBaseVersion(value: unknown): string | null;
export function isSameUpstreamVersion(latest: unknown, current: unknown): boolean;
export function forkUpdateDecision(
  latest: unknown,
  current: unknown,
): "same" | "proceed" | "unresolved";
export function forkVersionTagError(
  version: unknown,
  tags: readonly string[],
  pointsAtHead?: (tag: string) => boolean,
): string | null | undefined;
