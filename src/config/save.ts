import type { OcxConfig } from "../types";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  adoptCustomModelCatalogMigration,
  projectCustomModelCatalogMigration,
} from "../codex/custom-model-catalog-migration";
import {
  clearPendingConfigDeletions,
  projectConfigRebaseProvenance,
} from "./rebase-provenance";
import { getConfigDir } from "./paths";
import { persistConfigUnlocked, readRawConfigJson } from "./persist-unlocked";
import { withConfigMutationLockSync, bumpGenerationForCooperatingConfigWrite } from "./mutation-lock";
import { configReasoningPinsConfigError } from "./provider-validation";

/** Persist `config` to config.json under the config-mutation lock. */
export function saveConfig(config: OcxConfig): void {
  const pinError = configReasoningPinsConfigError(config);
  if (pinError) throw new Error(pinError);
  // Keep the real-home assertion ahead of even lock-directory preparation.
  assertNotRealHomeUnderTest(getConfigDir());
  withConfigMutationLockSync(() => {
    const withProvenance = projectCustomModelCatalogMigration(
      readRawConfigJson(),
      projectConfigRebaseProvenance(config),
    );
    if (persistConfigUnlocked(withProvenance)) bumpGenerationForCooperatingConfigWrite();
    adoptCustomModelCatalogMigration(config, withProvenance);
    if (withProvenance.configRebaseProvenance === undefined) delete config.configRebaseProvenance;
    else config.configRebaseProvenance = structuredClone(withProvenance.configRebaseProvenance);
    clearPendingConfigDeletions(config);
  });
}
