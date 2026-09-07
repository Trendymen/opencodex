const FORK_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-ben\.([1-9]\d*)$/;
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PREVIEW_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-preview\.([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;

function stableVersionParts(value) {
  if (typeof value !== "string") return null;
  const match = STABLE_VERSION_RE.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function forkVersionParts(value) {
  if (typeof value !== "string") return null;
  const match = FORK_VERSION_RE.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 5).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isCanonicalPreviewVersion(value) {
  const match = PREVIEW_VERSION_RE.exec(value);
  if (!match) return false;
  return match[4].split(".").every(part => !/^0\d+$/.test(part));
}

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
export function forkUpdateDecision(latest, current, channel = "latest") {
  const currentFork = forkVersionParts(current);
  if (!currentFork) {
    return typeof latest === "string" && isSameUpstreamVersion(latest, current) ? "same" : "proceed";
  }
  if (typeof latest !== "string") return "unresolved";
  const normalizedLatest = latest.trim();
  if (channel === "preview") {
    return isCanonicalPreviewVersion(normalizedLatest) ? "proceed" : "unresolved";
  }
  if (channel !== "latest") return "unresolved";

  const latestStable = stableVersionParts(normalizedLatest);
  const latestFork = forkVersionParts(normalizedLatest);
  if (!latestStable && !latestFork) return "unresolved";

  const latestBase = latestStable ?? latestFork.slice(0, 3);
  const currentBase = currentFork.slice(0, 3);
  for (let index = 0; index < currentBase.length; index++) {
    if (latestBase[index] !== currentBase[index]) {
      return latestBase[index] < currentBase[index] ? "older" : "proceed";
    }
  }
  if (latestStable) return "same";
  if (latestFork[3] < currentFork[3]) return "older";
  if (latestFork[3] === currentFork[3]) return "same";
  return "proceed";
}

/** Validate the immutable, monotonic tag line for a recognized fork version. */
export function forkVersionTagError(version, tags, pointsAtHead = () => false) {
  const base = forkBaseVersion(version);
  if (!base) return undefined;
  const baseTag = `v${base}`;
  if (!tags.includes(baseTag)) return `fork version ${version} has no official ${baseTag} base tag`;

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
