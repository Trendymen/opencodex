import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch, ProviderUpdateResult } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { LanguageProvider } from "../src/i18n/provider";
import { CODEX_PASSTHROUGH_CATALOG } from "../../src/fork/codex-passthrough-contract";

const official: WorkspaceItem = { name: "openai", adapter: "openai-responses", authMode: "forward",
  baseUrl: "https://chatgpt.com/backend-api/codex", codexAccountMode: "pool" };
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>; let testWindow: Window;
const roots: Root[] = [];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: testWindow.document, window: testWindow,
    navigator: testWindow.navigator, localStorage: testWindow.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

async function render(item = official, update?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>) {
  const container = document.createElement("div"); document.body.append(container);
  const { createRoot } = await import("react-dom/client"); const root = createRoot(container); roots.push(root);
  const patches: ProviderUpdatePatch[] = []; const names: string[] = []; const dirty: boolean[] = [];
  const onUpdateProvider = update ?? (async (name, patch) => { names.push(name); patches.push(patch); return { ok: true }; });
  const onDirtyChange = (value: boolean) => { dirty.push(value); };
  const rerender = async (next: WorkspaceItem) => { await act(async () => { root.render(<LanguageProvider><ProviderSettings
    key={next.name} item={next} onUpdateProvider={onUpdateProvider} onDirtyChange={onDirtyChange}
  /></LanguageProvider>); }); };
  await rerender(item);
  return { container, patches, names, dirty, rerender };
}

function permission(container: HTMLElement, path: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[data-codex-permission="${path}"]`);
  expect(input).not.toBeNull(); return input!;
}
async function click(element: HTMLElement) { await act(async () => { element.click(); await Promise.resolve(); }); }
function save(container: HTMLElement) { return container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!; }
async function setText(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? testWindow.HTMLTextAreaElement.prototype : testWindow.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

for (const item of [official, { ...official, codexAccountMode: "direct" as const },
  { ...official, name: "native-subscription" }, { ...official, disabled: true }]) {
  test(`official settings expose all default permissions (${item.name}/${item.codexAccountMode}/${!!item.disabled})`, async () => {
    const { container, patches, dirty } = await render(item);
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input[data-codex-permission]")];
    expect(inputs.length).toBe(CODEX_PASSTHROUGH_CATALOG.length); expect(inputs.every(input => input.checked && !input.disabled)).toBe(true);
    expect(patches).toEqual([]); expect(dirty.at(-1)).toBe(false);
  });
}

for (const item of [{ ...official, authMode: "key" }, { ...official, baseUrl: "https://api.openai.com/v1" },
  { ...official, baseUrl: "https://gateway.example/v1" }, { ...official, adapter: "openai-chat" }]) {
  test(`noncanonical settings omit the subscription controls (${item.authMode}/${item.adapter}/${item.baseUrl})`, async () => {
    const { container } = await render(item); expect(container.querySelector("input[data-codex-permission]")).toBeNull();
  });
}

test("an existing model adapter override exposes the controls for its native destination", async () => {
  const item = { ...official, name: "native-override", adapter: "openai-chat", modelAdapters: { "gpt-native": "openai-responses" } };
  const { container } = await render(item); expect(permission(container, "normalizeEncryptedContent").checked).toBe(true);
});

test("a single compatibility edit saves only that leaf and keeps other stored fields", async () => {
  const item = { ...official, codexPassthrough: { normalizeEncryptedContent: true, localErrorPolicies: { resetReplayRefusal: false } } };
  const { container, patches } = await render(item);
  await click(permission(container, "rewriteAnnotationInstructions")); expect(patches).toEqual([]);
  await click(save(container)); expect(patches).toEqual([{ codexPassthrough: { rewriteAnnotationInstructions: false } }]);
  expect(permission(container, "normalizeEncryptedContent").checked).toBe(true);
  expect(permission(container, "localErrorPolicies.resetReplayRefusal").checked).toBe(false);
});

test("local policies save a sparse nested patch", async () => {
  const { container, patches } = await render();
  await click(permission(container, "localErrorPolicies.inputAdmissionPrecheck")); await click(save(container));
  expect(patches).toEqual([{ codexPassthrough: { localErrorPolicies: { inputAdmissionPrecheck: false } } }]);
});

test("private SSE deadline starts enabled and saves only its override", async () => {
  const { container, patches } = await render();
  expect(permission(container, "privateSseReadDeadline").checked).toBe(true);
  await click(permission(container, "privateSseReadDeadline"));
  expect(permission(container, "normalizeEncryptedContent").checked).toBe(true);
  await click(save(container));
  expect(patches).toEqual([{ codexPassthrough: { privateSseReadDeadline: false } }]);
});

test("pacing and permission edits share one save without rewriting general settings", async () => {
  const { container, patches } = await render({ ...official, requestPacing: { enabled: true, requestsPerMinute: 20 } });
  await click(permission(container, "bridgeLiteMetadata"));
  await setText(container.querySelector<HTMLInputElement>('.pwi-pacing-grid input[type="number"]')!, "10");
  await click(save(container));
  expect(patches).toEqual([{ requestPacing: { enabled: true, requestsPerMinute: 10 }, codexPassthrough: { bridgeLiteMetadata: false } }]);
});

test("a renamed provider saves permissions under its own name", async () => {
  const { container, names } = await render({ ...official, name: "renamed-official" });
  await click(permission(container, "bridgeLiteMetadata")); await click(save(container));
  expect(names).toEqual(["renamed-official"]);
});

test("turning every permission off saves all twenty-one fields without account or pacing changes", async () => {
  const { container, patches } = await render();
  const button = container.querySelector<HTMLButtonElement>("[data-codex-passthrough-all-off]"); expect(button).not.toBeNull();
  await click(button!); expect(patches).toEqual([]); await click(save(container));
  const value = patches[0]?.codexPassthrough; expect(value).toBeTruthy();
  for (const row of CODEX_PASSTHROUGH_CATALOG) {
    expect(row.group === "localErrors" ? value?.localErrorPolicies?.[row.key] : value?.[row.key]).toBe(false);
  }
  expect(Object.keys(patches[0]!)).toEqual(["codexPassthrough"]);
});

test("an unrelated note save does not manufacture default permission overrides", async () => {
  const { container, patches } = await render();
  await setText(container.querySelector<HTMLTextAreaElement>("textarea.pwi-settings-textarea")!, "synthetic note");
  await click(save(container)); expect(patches[0]?.note).toBe("synthetic note"); expect(patches[0]).not.toHaveProperty("codexPassthrough");
});

test("discard restores stored values and toggle-back leaves an unset default omitted", async () => {
  const { container, dirty } = await render({ ...official, codexPassthrough: { bridgeLiteMetadata: false } });
  await click(permission(container, "normalizeEncryptedContent")); await click(permission(container, "normalizeEncryptedContent"));
  expect(dirty.at(-1)).toBe(false); expect(save(container)).toBeNull();
  await click(permission(container, "bridgeLiteMetadata"));
  await click(container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-ghost")!);
  expect(permission(container, "bridgeLiteMetadata").checked).toBe(false); expect(dirty.at(-1)).toBe(false);
});

test("a failed save keeps the permission draft and accessible failure feedback", async () => {
  const { container } = await render(official, async () => ({ ok: false, error: "synthetic save failure" }));
  await click(permission(container, "normalizeEncryptedContent")); await click(save(container));
  expect(permission(container, "normalizeEncryptedContent").checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("synthetic save failure");
  expect(save(container).disabled).toBe(false);
});

test("successful refetch clears the draft while equivalent and mode-only refetches keep unsaved edits", async () => {
  const { container, dirty, rerender } = await render();
  await click(permission(container, "bridgeLiteMetadata"));
  await rerender({ ...official, codexAccountMode: "direct" }); expect(permission(container, "bridgeLiteMetadata").checked).toBe(false);
  await rerender({ ...official }); expect(dirty.at(-1)).toBe(true);
  await rerender({ ...official, codexPassthrough: { bridgeLiteMetadata: false } });
  expect(permission(container, "bridgeLiteMetadata").checked).toBe(false); expect(dirty.at(-1)).toBe(false);
});

test("permission inputs have labels and descriptions and follow the existing save busy state", async () => {
  let finish!: (value: ProviderUpdateResult) => void;
  const { container } = await render(official, () => new Promise(resolve => { finish = resolve; }));
  const input = permission(container, "expandRequestHistory");
  expect(input.id).toBeTruthy(); expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBeTruthy();
  expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
  await click(input); await click(save(container)); expect(input.disabled).toBe(true);
  await act(async () => { finish({ ok: false, error: "synthetic busy failure" }); });
  expect(input.disabled).toBe(false); expect(input.checked).toBe(false);
});

test("a failed permission save restores keyboard focus after the busy button is enabled", async () => {
  let finish!: (value: ProviderUpdateResult) => void;
  const { container } = await render(official, () => new Promise(resolve => { finish = resolve; }));
  await click(permission(container, "bridgeLiteMetadata"));
  const button = save(container); button.focus(); await click(button);
  expect(button.disabled).toBe(true); document.body.focus();
  await act(async () => { finish({ ok: false, error: "synthetic failure" }); });
  expect(document.activeElement).toBe(button); expect(button.disabled).toBe(false);
});

test("a successful repeated all-off save clears dirty even when refetch values are unchanged", async () => {
  const stored = { ...Object.fromEntries(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group !== "localErrors").map(row => [row.key, false])),
    localErrorPolicies: Object.fromEntries(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group === "localErrors").map(row => [row.key, false])) };
  const item = { ...official, codexPassthrough: stored };
  const { container, dirty, rerender, patches } = await render(item);
  await click(container.querySelector<HTMLButtonElement>("[data-codex-passthrough-all-off]")!); await click(save(container));
  await rerender({ ...item, codexPassthrough: structuredClone(stored) });
  expect(patches).toEqual([{ codexPassthrough: stored }]); expect(dirty.at(-1)).toBe(false);
  expect(save(container)).toBeNull(); expect(container.querySelector('[role="status"]')?.textContent).toContain("saved");
});

test("equivalent pacing refetch retains a failed permission save message and draft", async () => {
  const item = { ...official, requestPacing: { enabled: true, requestsPerMinute: 20 } };
  const { container, rerender } = await render(item, async () => ({ ok: false, error: "synthetic permission save failure" }));
  await click(permission(container, "bridgeLiteMetadata")); await click(save(container));
  await rerender({ ...item, requestPacing: { ...item.requestPacing } });
  expect(permission(container, "bridgeLiteMetadata").checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("synthetic permission save failure");
  await rerender({ ...item, requestPacing: { ...item.requestPacing }, codexAccountMode: "direct" });
  expect(permission(container, "bridgeLiteMetadata").checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("synthetic permission save failure");
});

test("acknowledged permissions remain visible until refetch and later edits stay sparse", async () => {
  const { container, dirty, patches } = await render();
  await click(permission(container, "bridgeLiteMetadata")); await click(save(container));
  expect(dirty.at(-1)).toBe(false); expect(permission(container, "bridgeLiteMetadata").checked).toBe(false);
  await click(permission(container, "normalizeEncryptedContent")); await click(save(container));
  expect(patches).toEqual([{ codexPassthrough: { bridgeLiteMetadata: false } }, { codexPassthrough: { normalizeEncryptedContent: false } }]);
  await click(permission(container, "normalizeEncryptedContent"));
  await click(container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-ghost")!);
  expect(permission(container, "bridgeLiteMetadata").checked).toBe(false);
  expect(permission(container, "normalizeEncryptedContent").checked).toBe(false); expect(dirty.at(-1)).toBe(false);
});

for (const change of ["edit", "saved change"] as const) test(`obsolete permission error clears after ${change} without pacing`, async () => {
  const { container, dirty, rerender } = await render(official, async () => ({ ok: false, error: "synthetic prior save failure" }));
  await click(permission(container, "bridgeLiteMetadata")); await click(save(container));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("synthetic prior save failure");
  if (change === "edit") await click(permission(container, "normalizeEncryptedContent"));
  else {
    await rerender({ ...official, codexPassthrough: { bridgeLiteMetadata: false } });
    expect(dirty.at(-1)).toBe(false);
  }
  expect(container.querySelector('[role="alert"]') === null).toBe(true);
});
