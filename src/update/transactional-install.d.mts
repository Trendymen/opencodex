export type InstallTreeVerification = { ok: boolean; failures: string[] };
export function verifyInstallTree(packageDir: string, expectedVersion?: string): InstallTreeVerification;
export function verifyPnpmInstallTree(packageDir: string, expectedVersion?: string): InstallTreeVerification;
export function bootRestoreProbe(
  packageDir: string,
  deps?: {
    rename?: (from: string, to: string) => void;
    remove?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
    isProcessAlive?: (pid: number) => boolean;
    readDirectory?: (path: string) => string[];
    realpath?: (path: string) => string;
    platform?: NodeJS.Platform;
  },
): { action: "none" | "pending" | "aborted" | "reaped" | "restored" | "failed"; count?: number; from?: string; error?: string };
export type UpdateFsDeps = {
  rename?: (from: string, to: string) => void;
  mkdir?: (path: string) => void;
  rm?: (path: string, options: { recursive: true; force: true }) => void;
  now?: () => number;
  linkMarker?: (from: string, to: string) => void;
  realpath?: (path: string) => string;
  remove?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  writeFile?: (path: string, data: string, options?: { flag?: string; mode?: number }) => void;
  writeRecoveryFile?: (path: string, data: string, options?: { flag?: string; mode?: number }) => void;
};
export const UPDATE_OWNER_MARKER: string;
export const STALE_STAGE_MIN_AGE_MS: number;
export function removeOwnedStage(stageRoot: string, deps?: UpdateFsDeps): { removed: boolean; code?: string };
export function sweepUpdateLeftovers(args: {
  packageDir: string;
  pkgName: string;
  log?: (line: string) => void;
  deps?: UpdateFsDeps;
}): {
  removed: string[];
  inUse: Array<{ path: string; code: string }>;
  recent: string[];
  notOwned: string[];
};
export function launcherUsableAfterNpmUpdate(tx: { ok: boolean; phase: string; rolledBack?: boolean } | null | undefined): boolean;
export function transactionalNpmUpdate(args: {
  packageDir: string;
  pkgName: string;
  targetVersion?: string;
  tag: string;
  packageSpec?: string;
  installArgs?: string[];
  runNpm: (args: string[]) => { status: number | null };
  verifyStage?: (packageDir: string, expectedVersion?: string) => InstallTreeVerification;
  verifyLive?: (packageDir: string, expectedVersion?: string) => InstallTreeVerification;
  verifyRollback?: (packageDir: string) => InstallTreeVerification;
  deferCommit?: boolean;
  log?: (line: string) => void;
  deps?: UpdateFsDeps;
}): {
  ok: boolean;
  phase: "stage" | "verify" | "swap-backup" | "swap-live" | "post-verify" | "double-fault" | "pending-existing" | "pending-marker" | "pending-owner" | "pending" | "commit" | "done";
  error?: string;
  rolledBack?: boolean;
  backup?: string;
  recoveryUnsafe?: boolean;
  markerWriteFailed?: boolean;
  markerCleanupFailed?: boolean;
  commit?: () => { ok: boolean; phase: string; error?: string; recoveryUnsafe?: boolean };
  rollback?: () => { ok: boolean; phase: string; error?: string; recoveryUnsafe?: boolean; markerWriteFailed?: boolean; markerCleanupFailed?: boolean };
};
