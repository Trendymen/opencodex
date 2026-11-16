import type { CodexPassthroughPermissions } from "./codex-passthrough-contract";
import { repairFunctionCallsInJson } from "../responses/function-call-compat";
import { backfillResponsesFieldsJson } from "../server/responses/responses-field-backfill";
import { repairResponsesSnapshotJson } from "../server/responses-snapshot-repair";

export function normalizeCodexResponseSnapshotJson(text: string, permissions: CodexPassthroughPermissions | undefined,
  schemas: Parameters<typeof repairFunctionCallsInJson>[1], repairSnapshot: boolean, outboundBody: unknown): string {
  const snapshot = repairSnapshot && permissions?.backfillResponseFields !== false
    ? repairResponsesSnapshotJson(text, outboundBody) : text;
  const fields = permissions?.backfillResponseFields === false ? snapshot : backfillResponsesFieldsJson(snapshot);
  return permissions?.repairResponseToolCalls === false ? fields : repairFunctionCallsInJson(fields, schemas);
}
