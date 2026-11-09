import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogDetailDialog, SessionEffortIndicator } from "../src/pages/Logs";
import { DICTS, interpolate, type TFn } from "../src/i18n/shared";
import type { SessionEffortObservation } from "../../src/usage/session-effort-observation";

const source = readFileSync(join(import.meta.dir, "../src/pages/Logs.tsx"), "utf8");
const t: TFn = (key, vars) => interpolate(DICTS.en[key], vars);

/**
 * The table's effort cell used to stack the wire field (`reasoning_effort=high`) under the
 * label. It repeated the label, and in the mono font it outgrew the 9% column and painted
 * over the provider cell. The wire field stays reachable in the cell title and the detail
 * dialog, so a reader who wants it still has it.
 */
describe("Logs table effort cell", () => {
  test("shows the initial input update and explains its observation boundary", () => {
    expect(source).toContain("sessionEffortObservation");
    expect(source).toContain('t("logs.effort.initialTopLevel")');
    expect(source).toContain('t("logs.effort.initialUpdate")');
    expect(source).toContain('t("logs.effort.observationBoundary")');
  });

  test("renders initial observation, unknown continuation and legacy detail", () => {
    const visible: SessionEffortObservation = { clientEffort: "high", sessionEffort: "max", status: "visible" };
    const unknown: SessionEffortObservation = { clientEffort: "high", sessionEffort: "unknown", status: "not_in_input" };
    expect(renderToStaticMarkup(createElement(SessionEffortIndicator, { observation: visible, t }))).toContain(">max<");
    expect(renderToStaticMarkup(createElement(SessionEffortIndicator, { observation: unknown, t }))).toContain(">unknown<");
    const detail = (observation?: SessionEffortObservation) => renderToStaticMarkup(createElement(LogDetailDialog, {
      detail: { timestamp: 1, model: "model", provider: "p", status: 200, durationMs: 1, usageStatus: "unreported",
        requestedEffort: "high->medium", effectiveEffort: "low", sessionEffortObservation: observation },
      detailInfo: null, localeCode: "en", t, onClose: () => {},
    }));
    const html = detail(visible);
    expect(html).toContain("Client initial top-level effort");
    expect(html).toContain("Initial input session update");
    expect(html).toContain("high → medium → low");
    expect(html).toContain("Later WebSocket frames may change settings");
    expect(html).toContain("may not have been forwarded or applied upstream");
    expect(detail(unknown)).toContain("No update in initial input; session value unknown");
    expect(detail({ ...unknown, status: "unrecognized" })).toContain("Unrecognized update; session value unknown");
    expect(detail()).not.toContain("Client initial top-level effort");
  });

  test("retains the effort chain and wire title alongside the initial update", () => {
    const cell = source.match(/<td className="mono log-reasoning-cell" title=\{reasoningWire\}>([^]*?)<\/td>/);
    expect(cell).not.toBeNull();
    expect(cell![1]).toContain("{effortLabel(log)}");
    expect(cell![1]).toContain("observation={log.sessionEffortObservation}");
    expect(cell![1]).not.toContain("reasoningWire");
  });

  test("the detail dialog still shows the wire field next to the label", () => {
    expect(source).toContain('{effortLabel(detail)}{reasoningWire ? ` (${reasoningWire})` : ""}');
  });
});
