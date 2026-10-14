import { useId } from "react";
import { useT } from "../../i18n/shared";
import type { TKey } from "../../i18n/en";
import {
  CODEX_PASSTHROUGH_CATALOG, resolveCodexPassthroughPermissions,
  type CodexPassthroughConfig, type PermissionPath,
} from "../../../../src/fork/codex-passthrough-contract";

const copy = {
  normalizeRequestParameters: { label: "pws.codex.normalizeRequestParameters", desc: "pws.codex.normalizeRequestParametersDesc" },
  expandRequestHistory: { label: "pws.codex.expandRequestHistory", desc: "pws.codex.expandRequestHistoryDesc" },
  normalizeEncryptedContent: { label: "pws.codex.normalizeEncryptedContent", desc: "pws.codex.normalizeEncryptedContentDesc" },
  snapshotSkillsCatalog: { label: "pws.codex.snapshotSkillsCatalog", desc: "pws.codex.snapshotSkillsCatalogDesc" },
  rewriteAnnotationInstructions: { label: "pws.codex.rewriteAnnotationInstructions", desc: "pws.codex.rewriteAnnotationInstructionsDesc" },
  bridgeLiteMetadata: { label: "pws.codex.bridgeLiteMetadata", desc: "pws.codex.bridgeLiteMetadataDesc" },
  backfillResponseFields: { label: "pws.codex.backfillResponseFields", desc: "pws.codex.backfillResponseFieldsDesc" },
  repairResponseToolCalls: { label: "pws.codex.repairResponseToolCalls", desc: "pws.codex.repairResponseToolCallsDesc" },
  redactUpstreamErrors: { label: "pws.codex.redactUpstreamErrors", desc: "pws.codex.redactUpstreamErrorsDesc" },
  privateSseReadDeadline: { label: "pws.codex.privateSseReadDeadline", desc: "pws.codex.privateSseReadDeadlineDesc" },
  synthesizeTerminalFailure: { label: "pws.codex.synthesizeTerminalFailure", desc: "pws.codex.synthesizeTerminalFailureDesc" },
  normalizeHostedImages: { label: "pws.codex.normalizeHostedImages", desc: "pws.codex.normalizeHostedImagesDesc" },
  synthesizeRoutingHint: { label: "pws.codex.synthesizeRoutingHint", desc: "pws.codex.synthesizeRoutingHintDesc" },
  synthesizeSessionId: { label: "pws.codex.synthesizeSessionId", desc: "pws.codex.synthesizeSessionIdDesc" },
  addResponseRequestId: { label: "pws.codex.addResponseRequestId", desc: "pws.codex.addResponseRequestIdDesc" },
  addResponseBrowserHeaders: { label: "pws.codex.addResponseBrowserHeaders", desc: "pws.codex.addResponseBrowserHeadersDesc" },
  "localErrorPolicies.resetReplayRefusal": { label: "pws.codex.resetReplayRefusal", desc: "pws.codex.resetReplayRefusalDesc" },
  "localErrorPolicies.requestPacingAdmission": { label: "pws.codex.requestPacingAdmission", desc: "pws.codex.requestPacingAdmissionDesc" },
  "localErrorPolicies.inputAdmissionPrecheck": { label: "pws.codex.inputAdmissionPrecheck", desc: "pws.codex.inputAdmissionPrecheckDesc" },
  "localErrorPolicies.accountSoftPrecheck": { label: "pws.codex.accountSoftPrecheck", desc: "pws.codex.accountSoftPrecheckDesc" },
  "localErrorPolicies.transportErrorMapping": { label: "pws.codex.transportErrorMapping", desc: "pws.codex.transportErrorMappingDesc" },
} satisfies Record<PermissionPath, { label: TKey; desc: TKey }>;

const groups = {
  request: "pws.codex.requestGroup", response: "pws.codex.responseGroup",
  headers: "pws.codex.headersGroup", localErrors: "pws.codex.localErrorsGroup",
} satisfies Record<typeof CODEX_PASSTHROUGH_CATALOG[number]["group"], TKey>;

export default function CodexPassthroughSettings({ value, onChange, disabled }: {
  value: CodexPassthroughConfig | undefined;
  onChange: (patch: CodexPassthroughConfig) => void;
  disabled: boolean;
}) {
  const t = useT(); const id = useId(); const permissions = resolveCodexPassthroughPermissions(value);
  const allOff = () => {
    const patch: CodexPassthroughConfig = { localErrorPolicies: {} };
    for (const row of CODEX_PASSTHROUGH_CATALOG) {
      if (row.group === "localErrors") patch.localErrorPolicies![row.key] = false;
      else patch[row.key] = false;
    }
    onChange(patch);
  };
  return <section className="pwi-pacing-card" aria-labelledby={`${id}-title`}>
    <div className="pwi-pacing-head">
      <div><h3 id={`${id}-title`}>{t("pws.codex.title")}</h3><p>{t("pws.codex.desc")}</p></div>
      <button type="button" className="btn btn-ghost btn-sm" data-codex-passthrough-all-off disabled={disabled} onClick={allOff}>{t("pws.codex.allOff")}</button>
    </div>
    <p className="pwi-settings-hint">{t("pws.codex.protected")}</p>
    <p className="pwi-settings-hint">{t("pws.codex.effects")}</p>
    {Object.entries(groups).map(([group, title]) => <details key={group}>
      <summary className="pwi-settings-label">{t(title)}</summary>
      <div className="pwi-pacing-overrides">
        {CODEX_PASSTHROUGH_CATALOG.filter(row => row.group === group).map(row => {
          // oxlint-disable-next-line local-i18n/no-hardcoded-ui-strings -- config path used only in data attributes
          const path: PermissionPath = row.group === "localErrors" ? `localErrorPolicies.${row.key}` : row.key;
          const text = copy[path]; const inputId = `${id}-${row.key}`;
          return <div className="pwi-auth-optin-row" key={path}>
            <div className="pwi-auth-optin-copy">
              <label htmlFor={inputId} className="pwi-auth-optin-label">{t(text.label)}</label>
              <span id={`${inputId}-desc`} className="pwi-settings-hint">{t(text.desc)}</span>
            </div>
            <input id={inputId} type="checkbox" data-codex-permission={path} aria-describedby={`${inputId}-desc`} disabled={disabled}
              checked={row.group === "localErrors" ? permissions.localErrorPolicies[row.key] : permissions[row.key]}
              onChange={event => onChange(row.group === "localErrors"
                ? { localErrorPolicies: { [row.key]: event.target.checked } } : { [row.key]: event.target.checked })} />
          </div>;
        })}
      </div>
    </details>)}
  </section>;
}
