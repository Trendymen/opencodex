import { describe, expect, test } from "bun:test";
import { externalTaskInputContent } from "../../src/responses/task-input";

describe("unusable-call_id task-input seed (#3807)", () => {
  const seed = (extra: Record<string, unknown>) => ({
    type: "function_call_output", id: "fc_seed", name: "create_thread", namespace: "codex",
    output: "<codex_delegation>continue</codex_delegation>", ...extra,
  });

  test("a seed carrying call_id: null is admitted as task input", () => {
    // `null` is not a pairing key, so the item is the same external seed the absent-field
    // form already carries. Rejecting it produced the reported 400 on clients that emit
    // the field explicitly.
    expect(externalTaskInputContent(seed({ call_id: null }))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("a seed carrying an empty-string call_id is admitted identically", () => {
    expect(externalTaskInputContent(seed({ call_id: "" }))).toBe("<codex_delegation>continue</codex_delegation>");
    expect(externalTaskInputContent(seed({ call_id: "   " }))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("the absent-field form still works (no regression on a73bb160f)", () => {
    expect(externalTaskInputContent(seed({}))).toBe("<codex_delegation>continue</codex_delegation>");
  });

  test("a REAL call_id is still a paired tool result, never task input", () => {
    // The pairing key is what separates a tool result from a seed. Admitting a paired
    // result as user text would silently drop a real tool round-trip.
    expect(externalTaskInputContent(seed({ call_id: "call_1" }))).toBeUndefined();
  });

  test("a non-string, non-null call_id stays rejected", () => {
    // A numeric id is malformed input, not the absent-pairing seed shape; it keeps the
    // #3259 rejection so a wrong-typed key cannot reach a translating adapter.
    expect(externalTaskInputContent(seed({ call_id: 42 }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: {} }))).toBeUndefined();
  });

  test("every other #3735 validation still holds with an unusable call_id", () => {
    // The relaxation is ONLY about the pairing key. Envelope completeness, blank output,
    // and opaque ciphertext keep their existing rejections.
    expect(externalTaskInputContent({ type: "function_call_output", call_id: null, output: "x" })).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, namespace: "" }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: "   " }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: [] }))).toBeUndefined();
    expect(externalTaskInputContent(seed({ call_id: null, output: [{ type: "input_image", image_url: 42 }] }))).toBeUndefined();
  });
});
