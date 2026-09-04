import { describe, expect, test } from "bun:test";
import {
  createNestedExecAdapterEventRepair,
  createNestedExecPassthroughRepair,
} from "../src/server/responses-nested-exec-call-repair";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

describe("nested exec repair contexts", () => {
  const CODE_MODE_EXEC = {
    type: "namespace",
    name: "functions",
    tools: [{ type: "custom", name: "exec", description: "Run JavaScript with nested helpers." }],
  };

  test("derives adapter-event repair from Codex's reserved functions custom exec declaration", () => {
    const repair = createNestedExecAdapterEventRepair({
      rawBody: { tools: [CODE_MODE_EXEC] },
      replayPrefixLength: 0,
      isPassthrough: false,
      translatorBudget: createTestTranslatorBudget(),
    });
    expect(repair.clientDeclaredWireToolNames).toEqual(new Set(["exec"]));
    expect(repair.plan).toEqual({ execWireName: "exec", repairFunctionsExec: true, repairWebRun: true });
  });

  test("does not create an adapter repair plan for passthrough traffic", () => {
    const repair = createNestedExecAdapterEventRepair({
      rawBody: { tools: [CODE_MODE_EXEC] },
      replayPrefixLength: 0,
      isPassthrough: true,
      translatorBudget: createTestTranslatorBudget(),
    });
    expect(repair.plan).toBeUndefined();
  });

  test("does not authorize nested repair for ordinary or unproven exec declarations", () => {
    for (const tools of [
      [{ type: "function", name: "exec", parameters: { type: "object" } }],
      [{ type: "custom", name: "exec" }],
    ]) {
      const repair = createNestedExecAdapterEventRepair({
        rawBody: { tools },
        replayPrefixLength: 0,
        isPassthrough: false,
        translatorBudget: createTestTranslatorBudget(),
      });
      expect(repair.plan).toBeUndefined();
    }
  });

  test("builds a passthrough coordinator only when a lowered exec needs repair", () => {
    const repair = createNestedExecPassthroughRepair({
      execWasLowered: true,
      currentTurnExecDeclaration: { kind: "custom" },
      clientDeclaredWireToolNames: new Set(["exec"]),
      translatorBudget: createTestTranslatorBudget(),
    });
    expect(repair.plan).toEqual({ execWireName: "exec", repairFunctionsExec: true, repairWebRun: true });
    expect(repair.coordinator).toBeDefined();
    expect(repair.inspection).toBeDefined();
    repair.coordinator?.dispose();
    repair.inspection?.dispose();
  });

  test("refuses passthrough repair when the lowered exec declaration is ambiguous", () => {
    const repair = createNestedExecPassthroughRepair({
      execWasLowered: true,
      currentTurnExecDeclaration: undefined,
      clientDeclaredWireToolNames: new Set(["exec"]),
      translatorBudget: createTestTranslatorBudget(),
    });
    expect(repair.plan).toBeUndefined();
    expect(repair.coordinator).toBeUndefined();
    expect(repair.inspection).toBeUndefined();
  });

  test("requires the conversion fact that matches the unique exec declaration", () => {
    const customNotLowered = createNestedExecPassthroughRepair({
      execWasLowered: false,
      currentTurnExecDeclaration: { kind: "custom" },
      clientDeclaredWireToolNames: new Set(["exec"]),
      translatorBudget: createTestTranslatorBudget(),
    });
    expect(customNotLowered.plan).toBeUndefined();

    const functionOnWire = createNestedExecPassthroughRepair({
      execWasLowered: false,
      currentTurnExecDeclaration: { kind: "function" },
      clientDeclaredWireToolNames: new Set(["exec"]),
      translatorBudget: createTestTranslatorBudget(),
    });
    expect(functionOnWire.plan).toEqual({ execWireName: "exec", repairFunctionsExec: true, repairWebRun: true });
    functionOnWire.coordinator?.dispose();
    functionOnWire.inspection?.dispose();
  });
});
