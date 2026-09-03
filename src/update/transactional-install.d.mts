export type InstallTreeVerification = { ok: boolean; failures: string[] };
export function verifyInstallTree(packageDir: string, expectedVersion?: string): InstallTreeVerification;
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
  deps?: {
    rename?: (from: string, to: string) => void;
    linkMarker?: (from: string, to: string) => void;
    realpath?: (path: string) => string;
    remove?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
    writeFile?: (path: string, data: string, options?: { flag?: string; mode?: number }) => void;
    writeRecoveryFile?: (path: string, data: string, options?: { flag?: string; mode?: number }) => void;
  };
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
