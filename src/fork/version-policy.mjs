const FORK_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-ben\.([1-9]\d*)$/;
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Stable upstream version from an `X.Y.Z-ben.N` fork version. */
export function forkBaseVersion(value) {
  if (typeof value !== "string") return null;
  const match = FORK_VERSION_RE.exec(value.trim());
  if (!match || !match.slice(1, 5).every(part => Number.isSafeInteger(Number(part)))) return null;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Exact equality, plus a stable release matching the current fork's upstream base. */
export function isSameUpstreamVersion(latest, current) {
  if (typeof latest !== "string" || typeof current !== "string") return false;
  const normalizedLatest = latest.trim();
  const normalizedCurrent = current.trim();
  if (normalizedLatest === normalizedCurrent) return true;
  return STABLE_VERSION_RE.test(normalizedLatest)
    && forkBaseVersion(normalizedCurrent) === normalizedLatest;
}

/** Update preflight for a fork build; unresolved registry targets must fail closed. */
export function forkUpdateDecision(latest, current) {
  const forkBase = forkBaseVersion(current);
  if (forkBase && !latest) return "unresolved";
  return latest && isSameUpstreamVersion(latest, current) ? "same" : "proceed";
}

function stableParts(value) {
  const match = STABLE_VERSION_RE.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareStable(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Validate the immutable, monotonic tag line for a recognized fork version. */
export function forkVersionTagError(version, tags, pointsAtHead = () => false) {
  const base = forkBaseVersion(version);
  if (!base) return undefined;
  const baseTag = `v${base}`;
  if (!tags.includes(baseTag)) return `fork version ${version} has no official ${baseTag} base tag`;

  const baseParts = stableParts(base);
  const stableCores = tags
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
    .map(tag => stableParts(tag.slice(1)))
    .filter(parts => parts !== null);
  if (baseParts && stableCores.some(parts => compareStable(baseParts, parts) < 0)) {
    const highest = stableCores.sort(compareStable).at(-1);
    return `fork base ${baseTag} is behind v${highest.join(".")}`;
  }

  const revision = Number(FORK_VERSION_RE.exec(version.trim())[4]);
  const highestRevision = Math.max(0, ...tags
    .filter(tag => tag.startsWith("v") && forkBaseVersion(tag.slice(1)) === base)
    .map(tag => Number(FORK_VERSION_RE.exec(tag.slice(1))[4]))
    .filter(Number.isSafeInteger));
  if (highestRevision > revision) {
    return `fork revision ben.${revision} is behind existing ben.${highestRevision}`;
  }

  const currentTag = `v${version}`;
  return tags.includes(currentTag) && !pointsAtHead(currentTag)
    ? `fork version ${version} is already tagged on another commit`
    : null;
}
