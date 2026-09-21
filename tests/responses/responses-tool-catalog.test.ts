import { describe, expect, test } from "bun:test";
import {
  collectDeclaredNamelessClientCallTypes,
  collectDeclaredBareWireToolNames,
  collectDeclaredWireToolNames,
  currentTurnWireToolCatalogBody,
  hasExplicitWireToolCatalog,
  undeclaredToolCallNameInResponse,
} from "../../src/server/responses-undeclared-tool-guard";

describe("collectDeclaredBareWireToolNames", () => {
  test("collects top-level bare tools and functions namespace, ignoring other namespaces and flattened/dotted names", () => {
    const names = collectDeclaredBareWireToolNames({
      tools: [
        { type: "function", name: "view_image" },
        { type: "custom", name: "exec" },
        { type: "function", name: "foo__tool" },
        { type: "function", name: "foo.tool" },
        { type: "namespace", name: "functions", tools: [{ type: "function", name: "shell" }, { type: "function", name: "bar.baz" }] },
        { type: "namespace", name: "linear", tools: [{ type: "function", name: "create_issue" }] },
      ],
      input: [
        {
          type: "additional_tools",
          tools: [{ type: "function", name: "extra_tool" }, { type: "function", name: "pkg__sub" }],
        },
      ],
    });
    expect([...names].sort()).toEqual(["exec", "extra_tool", "shell", "view_image"]);
  });

  test("returns empty set for invalid or missing body", () => {
    expect(collectDeclaredBareWireToolNames(null).size).toBe(0);
    expect(collectDeclaredBareWireToolNames({}).size).toBe(0);
  });
});

describe("collectDeclaredWireToolNames", () => {
  test("reads function, custom, and namespaced tools off the outbound body", () => {
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "function", name: "exec" },
        { type: "custom", name: "apply_patch" },
        { type: "namespace", name: "linear", tools: [{ type: "function", name: "create_issue" }] },
        { type: "web_search" },
      ],
    });

    // Namespaced MCP tools are reachable under every coordinate system (`ns__name`, the bare
    // name, and the dotted `ns.name` some providers echo), so all are accepted.
    expect([...names].sort()).toEqual(
      ["apply_patch", "create_issue", "exec", "linear.create_issue", "linear__create_issue"],
    );
  });

  test("withholds the bare alias when only a namespaced exec was declared", () => {
    // A bare `exec` in the declared set is not just a name: it switches on nested-helper
    // normalization, so aliasing a namespaced MCP `exec` under the bare name would authorize
    // `exec_command`/`shell_command`/`apply_patch`/`view_image` this request never declared.
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "exec" }] }],
    });

    expect([...names]).toEqual(["mcp__exec", "mcp.exec"]);
  });

  test("withholds a dotted alias two declared identities would both claim", () => {
    // Dots are legal in a namespace and in a name, so `{a, b.c}` and `{a.b, c}` flatten onto
    // the same "a.b.c". Accepting it would authorize whichever identity happened to be
    // registered last, so neither gets the alias and both keep their unambiguous `ns__name`.
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "namespace", name: "a", tools: [{ type: "function", name: "b.c" }] },
        { type: "namespace", name: "a.b", tools: [{ type: "function", name: "c" }] },
      ],
    });

    expect(names.has("a.b.c")).toBe(false);
    expect(names.has("a__b.c")).toBe(true);
    expect(names.has("a.b__c")).toBe(true);
  });

  test("suppresses the ambiguous dotted alias in either declaration order", () => {
    // The caller controls declaration order, so the outcome must not: resolve ownership across
    // the whole catalog before registering, or the "winner" is attacker-chosen.
    const forward = collectDeclaredWireToolNames({
      tools: [
        { type: "namespace", name: "a", tools: [{ type: "function", name: "b.c" }] },
        { type: "namespace", name: "a.b", tools: [{ type: "function", name: "c" }] },
      ],
    });
    const reverse = collectDeclaredWireToolNames({
      tools: [
        { type: "namespace", name: "a.b", tools: [{ type: "function", name: "c" }] },
        { type: "namespace", name: "a", tools: [{ type: "function", name: "b.c" }] },
      ],
    });

    expect([...forward].sort()).toEqual([...reverse].sort());
    expect(forward.has("a.b.c")).toBe(false);
  });

  test("a dotted spelling never authorizes another identity's canonical wire name", () => {
    // "x__y.z" is the canonical name of {x, "y.z"} AND the dotted spelling of {"x__y", z}.
    // Only the first is declared, so a call for the second must still be refused: otherwise a
    // stranger's canonical name silently grants a tool the caller never declared.
    const declared = collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "x", tools: [{ type: "function", name: "y.z" }] }],
    });

    expect(declared.has("x__y.z")).toBe(true);
    expect(
      undeclaredToolCallNameInResponse({
        output: [{ type: "function_call", namespace: "x__y", name: "z", call_id: "c1" }],
      }, declared),
    ).toBe("z");
    // The identity that really owns that canonical name is still accepted.
    expect(
      undeclaredToolCallNameInResponse({
        output: [{ type: "function_call", namespace: "x", name: "y.z", call_id: "c2" }],
      }, declared),
    ).toBeUndefined();
  });

  test("keeps a uniquely owned dotted alias, which is the echo #3402 reported", () => {
    // The fix is scoped to ambiguity: an unambiguous dotted echo must still be restored, or the
    // defect this PR exists to fix comes back.
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "namespace", name: "default", tools: [{ type: "custom", name: "apply_patch" }] },
      ],
    });

    expect(names.has("default.apply_patch")).toBe(true);
    expect(names.has("default__apply_patch")).toBe(true);
  });

  test("keeps exec bare in Codex's reserved functions namespace", () => {
    // Codex groups ordinary top-level tools here; this is not an MCP namespace and the parser
    // deliberately lowers its children without a namespace.
    const names = collectDeclaredWireToolNames({
      tools: [{
        type: "namespace",
        name: "functions",
        tools: [{ type: "custom", name: "exec", description: "Run a command" }],
      }],
    });

    expect([...names]).toEqual(["exec"]);
  });

  test("keeps the bare alias when the request also declared a top-level exec", () => {
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "custom", name: "exec" },
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "exec" }] },
      ],
    });

    expect([...names].sort()).toEqual(["exec", "mcp.exec", "mcp__exec"]);
  });

  test("reads tools carried inside input as an additional_tools item", () => {
    // Codex Desktop's responses_lite WS path ships the catalog there instead of body.tools.
    const names = collectDeclaredWireToolNames({
      input: [
        { type: "message", role: "user", content: [] },
        { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "wait" }] },
      ],
    });

    expect([...names]).toEqual(["wait"]);
  });

  test("reads definitions loaded by a current tool-search output", () => {
    const names = collectDeclaredWireToolNames({
      input: [{
        type: "tool_search_output",
        tools: [{ type: "function", name: "deferred_read" }],
      }],
    });

    expect([...names]).toEqual(["deferred_read"]);
  });

  test("recognizes nested function names accepted by the parser", () => {
    expect([...collectDeclaredWireToolNames({
      tools: [{ type: "function", function: { name: "lookup" } }],
    })]).toEqual(["lookup"]);
    expect(collectDeclaredWireToolNames({
      tools: [{ type: "function", function: {} }],
    }).size).toBe(0);
  });

  test("is empty for a body this proxy could not read", () => {
    expect(collectDeclaredWireToolNames(undefined).size).toBe(0);
    expect(collectDeclaredWireToolNames({ tools: "nonsense" }).size).toBe(0);
  });

  test("is empty when a readable request omits the tool catalog", () => {
    expect(collectDeclaredWireToolNames({}).size).toBe(0);
  });

  test("is empty when a readable request explicitly declares an empty tool catalog", () => {
    // The name set alone cannot distinguish omission from an explicit deny-all catalog, so the
    // caller separately tracks whether the readable body contained a supported catalog array.
    expect(collectDeclaredWireToolNames({ tools: [] }).size).toBe(0);
  });

  test("ignores hosted tool entries, which carry no client-executable name", () => {
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "web_search" }, { type: "image_generation" }, { type: "function", name: "exec" }],
    });

    expect([...names]).toEqual(["exec"]);
  });
});

describe("hasExplicitWireToolCatalog", () => {
  test("distinguishes omitted or unreadable catalogs from top-level arrays", () => {
    expect(hasExplicitWireToolCatalog(undefined)).toBe(false);
    expect(hasExplicitWireToolCatalog({})).toBe(false);
    expect(hasExplicitWireToolCatalog({ tools: "nonsense" })).toBe(false);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "function" }] })).toBe(false);
    expect(hasExplicitWireToolCatalog({ tools: [] })).toBe(true);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "function", name: "exec" }] })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      tools: [{ type: "function" }, { type: "custom", name: "apply_patch" }],
    })).toBe(true);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "web_search" }] })).toBe(true);
    expect(hasExplicitWireToolCatalog({ tools: [{ type: "image_gen" }, { type: "x_search" }] })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      tools: [{ type: "namespace", name: "empty", tools: [] }],
    })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      tools: [{
        type: "namespace",
        name: "outer",
        tools: [{ type: "namespace", name: "inner", tools: [] }],
      }],
    })).toBe(false);
  });

  test("recognizes an additional_tools array, including an explicit empty catalog", () => {
    expect(hasExplicitWireToolCatalog({
      input: [{ type: "additional_tools", role: "developer", tools: [] }],
    })).toBe(true);
    expect(hasExplicitWireToolCatalog({
      input: [{ type: "additional_tools", role: "developer", tools: "nonsense" }],
    })).toBe(false);
    expect(hasExplicitWireToolCatalog({
      input: [{ type: "additional_tools", role: "developer", tools: [{}] }],
    })).toBe(false);
  });
});

describe("collectDeclaredNamelessClientCallTypes", () => {
  test("maps supported nameless declarations to their client response call types", () => {
    const callTypes = collectDeclaredNamelessClientCallTypes({
      tools: [{ type: "local_shell" }, { type: "tool_search" }, { type: "web_search" }],
      input: [{
        type: "additional_tools",
        tools: [{ type: "computer_use_preview" }, { type: "function", name: "exec" }],
      }],
    });

    expect([...callTypes].sort()).toEqual(["computer_call", "local_shell_call", "tool_search_call"]);
  });
});

describe("currentTurnWireToolCatalogBody", () => {
  test("keeps top-level tools and only the current input suffix", () => {
    const body = {
      tools: [],
      input: [
        { type: "additional_tools", tools: [{ type: "function", name: "historical" }] },
        { type: "message", role: "assistant", content: [] },
        { type: "additional_tools", tools: [{ type: "function", name: "current" }] },
      ],
    };
    const current = currentTurnWireToolCatalogBody(body, 2) as typeof body;

    expect(current.tools).toEqual([]);
    expect(current.input).toEqual([
      { type: "additional_tools", tools: [{ type: "function", name: "current" }] },
    ]);
    expect(body.input).toHaveLength(3);
  });
});
