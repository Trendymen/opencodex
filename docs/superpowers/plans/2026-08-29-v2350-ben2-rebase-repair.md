# OpenCodex v2.35.0-ben.2 Rebase Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v2.35 rebase 的 turn-termination 对象身份与 origin-only CI 基线证明缺口，修正 Fork 维护真源，并在 exact candidate/final CI 成功后发布不可变 `v2.35.0-ben.2`。

**Architecture:** `core.ts` 只增加一个局部 adopt/rebind 入口，所有实质 CI 基线验证集中到一个新的 Bun 脚本；workflow 仅在运行完整 suite 的 job 中接线。代码与 version 完成后，以单独 `FORK_CHANGES.md` commit 形成 pre-promotion snapshot；先验证远端 sync candidate，再原子 promotion、验证 main push、最后创建 GitHub Release。

**Tech Stack:** Bun 1.4、严格 TypeScript/ESM、Bun test、Git refs/annotated Tags、GitHub Actions、GitHub CLI。

**Spec:** `docs/superpowers/specs/2026-08-29-v2350-ben2-rebase-repair-design.md`

## S2R Official-Tag Preservation Successor（当前唯一执行入口）

后文S1 Repair与原Tasks 1–7只保留为执行审计记录，本节完整覆盖其中仍写着
“origin official Tag必须缺失/no-mirror”的旧规则和命令，不得再执行那些旧分支。

当前remote sync为已成功candidate
`5548eb2a0d71d84bee03a4fa8424750bfdc78b85`，其workflow_dispatch run
`33236921544` 已通过严格controller验证；但该run不能证明其后的Spec/Plan/contract提交。
远端main仍为ben.1 `98b14f722...`，marker仍为`fc4de772...`；本地/远端ben.2 Tag、
promotion、final CI与Release均未发生。origin已有与固定官方仓库完全一致的lightweight
`v2.34.0`（raw=peeled=`80fff9a7f...`），缺少`v2.35.0`。

### S2R-1：文档门禁

1. Spec修订必须记录完整链：`d555/33234936660`失败、`d252/33236405510`失败、
   `5548/33236921544`成功但不可复用于新descendant、官方Tag保留规则纠正，以及ben.2
   Tag/promotion/final CI/Release未发生；单独提交并通过原`SPEC_DOCUMENT` reviewer。
2. 本Plan修订必须把official Tag absent/exact、atomic promotion与恢复状态写成可执行命令；
   单独提交并通过原`PLAN_DOCUMENT` reviewer。

### S2R-2：最窄contract/truth实现

**Files:**
- Modify: `tests/fork-maintenance-truth.test.ts`
- Modify after RED: `FORK_CHANGES.md`
- Update temporarily: `.tmp/v2.35.0-ben.2-ci-controller.mjs`
- Preserve/update temporarily: `.tmp/v2.35.0-ben.2-state.json`
- Do not modify: runtime、workflow、`scripts/prepare-fork-official-base.ts`、`package.json`

1. 先amend现有maintenance truth test并运行RED，机械要求：
   - 三candidate predecessor chain与三个run ID/结果；
   - `5548`成功证据不能证明新descendant；
   - Fork origin对每个已rebase基线保留official Tag；`v2.34.0`保持exact
     `80fff9a7f...`，`v2.35.0`在promotion时保留exact `fc4de772...`；
   - ben.2 Tag/promotion/final CI/Release仍未发生；新S2R candidate及later gates pending。
2. 更新`FORK_CHANGES.md`使contract GREEN；保留16-overlap/112-path和所有旧证据，记录规则
   纠正与新的implementation HEAD/shortstat。先提交test-only implementation，最后再提交
   docs-only truth snapshot；不得改package。
3. focused只运行`bun test tests/fork-maintenance-truth.test.ts`、`bun run typecheck`、
   `bun run privacy:scan`和`git diff --check`；candidate远端CI承担全套验证，不重复本地prepush。

### S2R-3：修订可恢复controller

1. Controller读取固定官方仓库与origin的`v2.34.0`/`v2.35.0` raw/peeled：
   - official与origin `v2.34.0`都必须type=`commit`且raw=peeled=`80fff9a7f...`；
   - fixed-official `v2.35.0`必须type=`commit`且raw=peeled=`fc4de772...`；
   - promotion前origin `v2.35.0`只允许absent或exact；promotion后只允许exact；
   - 任何多行、unsupported type或mismatch均fail closed，不删除、不force、不移动。
2. `supersede-candidate`必须允许origin `v2.35.0`为absent或exact，继续严格要求ben.2 absent、
   fresh remote sync exact predecessor与new SHA descendant，并把`5548`run完整移入history。
3. self-test新增official v2.35 absent、present-exact、present-mismatch，以及v2.34 mismatch；
   `bun .tmp/v2.35.0-ben.2-ci-controller.mjs self-test`必须通过，state/controller继续保持
   `0600`/`0700`。

### S2R-4：新candidate与CI

1. 新docs-only snapshot必须是`5548eb2a0` descendant，worktree clean，remote sync fresh-read
   exact `5548eb2a0`；ben.2 Tag不存在；origin v2.34 exact、v2.35 absent或exact。
2. 执行`supersede-candidate 5548eb2a0... NEW_CANDIDATE`，然后以
   `--force-with-lease=refs/heads/sync/v2.35.0:5548eb2a0...`仅fast-forward sync。
3. `snapshot candidate`→`intent candidate`→一次workflow_dispatch→`bind candidate`→持久
   watcher→`verify candidate`。仍要求17个named success jobs、唯一literal Windows job-level
   skip、零展开Windows shards。失败保留immutable history并走successor；成功后才可建Tag。
4. 按用户指定顺序，candidate CI成功后复用原Spec/Quality reviewer做一次并行re-review；
   无Critical/Important才进入promotion，不增加额外review轮。

### S2R-5：冻结Tags并原子promotion

1. Fresh-run `bun scripts/prepare-fork-official-base.ts`，从固定官方仓库重验证并确保本地
   `refs/tags/v2.35.0`为exact lightweight `fc4de772...`。独立fresh-read确认origin
   `v2.34.0`仍exact `80fff9a7f...`，origin `v2.35.0`为absent或exact。
2. 创建一次annotated `v2.35.0-ben.2`；message必须记录完整三candidate predecessor chain、
   新S2R candidate/run、官方Tag保留纠正、local/review成功，并把promotion/final CI/Release
   标为pending。冻结Fork Tag raw OID，不得重建或移动。
3. `snapshot final push main "$CANDIDATE"`与`intent final`必须先落盘。使用一次atomic push，
   两个Tag refspec都不加force/lease：

```bash
git push --atomic origin \
  --force-with-lease=refs/heads/main:$REMOTE_MAIN_OLD \
  --force-with-lease=refs/heads/sync/v2.35.0:$CANDIDATE \
  --force-with-lease=refs/heads/upstream-release:$REMOTE_MARKER_OLD \
  "$CANDIDATE":refs/heads/main \
  "$CANDIDATE":refs/heads/sync/v2.35.0 \
  "$REMOTE_MARKER_OLD":refs/heads/upstream-release \
  refs/tags/v2.35.0:refs/tags/v2.35.0 \
  refs/tags/v2.35.0-ben.2:refs/tags/v2.35.0-ben.2
```

4. 完整pre-state A：branches pre、v2.35 absent、ben.2 absent；完整pre-state B：branches pre、
   v2.35 exact、ben.2 absent；完整post-state：branches promoted、v2.35 exact、ben.2 raw/peeled
   exact。所有状态还要求v2.34 exact。Reported success只接受post；确定失败停止；真正uncertain
   只在pre A/B允许以相同Tag raw OID、相同显式refset与fresh branch leases重试一次。
5. Remote post后按旧OID transaction对齐local main/marker，`--no-tags`刷新三branch tracking
   refs；persist promotion state时同时记录v2.34/v2.35/Fork Tag raw/peeled。

### S2R-6：Final CI与Release

1. `bind final`只绑定唯一push/main/exact candidate新run，watch至terminal后`verify final`；
   不复用candidate run。
2. Final CI成功后，Release Notes必须区分`d555`失败、`d252`失败、`5548`成功但stale、
   新S2R candidate/final run，并记录v2.34/v2.35官方Tag exact保留和Fork Tag raw/peeled。
3. 创建/修正公开稳定`v2.35.0-ben.2` Release，要求assets=[]；最终fresh-read要求
   main/sync/candidate一致、marker=`fc4de772...`、origin v2.34=`80fff9a7f...`、origin
   v2.35=`fc4de772...`、Fork Tag annotated且peeled=candidate。全部terminal后才删除临时
   controller/state/notes。

## S1 Successor Repair Override（历史执行记录；不得再作为入口）

本Plan原 Tasks 1–5与首轮Task 6已经执行。首个docs-only candidate
`d5558096bb229b5fbf5607a6468c2871b2b1213e` 已推送到
`origin/sync/v2.35.0`；绑定run `33234936660` 在所有Linux/macOS suite的
`Prepare verified Fork official base`步骤失败。失败原因不是网络/transient，而是官方
`refs/tags/v2.35.0` 的真实type为 `commit`（lightweight），raw与peeled均为
`fc4de772...`，而原脚本/Spec错误要求type=`tag`。Controller已把该run记录为terminal
`run_conclusion_failure`。`main`仍为ben.1，marker仍为官方SHA，本地/远端ben.2 Tag、
promotion、final CI与Release均不存在。

因此当前从 **S1** 恢复；下面本节覆盖后文历史Tasks的执行状态。后文Tasks 1–5与Task 6
Steps 1–5只作为原始审计记录，不得重复执行，不得重建state或重新dispatch失败candidate。
当前repair按以下顺序连续执行：

### Repair A：提交已批准的修订文档

1. 修订Spec，记录S1状态、observed lightweight official ref、repair-only范围、failed
   candidate/run、replacement lease与Release evidence；通过原 `SPEC_DOCUMENT` reviewer。
2. 只提交Spec修订，父链必须是`d5558096b` descendant。
3. 修订本Plan并通过原 `PLAN_DOCUMENT` reviewer；只提交Plan修订。两份文档不得与实现
   或`FORK_CHANGES.md`混合。

### Repair B：修复现有official-ref verifier（TDD）

**Files:**
- Modify: `scripts/prepare-fork-official-base.ts`
- Modify: `tests/fork-ci-official-baseline.test.ts`

1. 先修改现有专用测试并运行RED：把observed-style fixture改为lightweight官方Tag且期望
   成功；保留独立annotated成功fixture；新增official ref指向blob/tree等unsupported object
   的拒绝fixture。RED必须命中当前“not annotated”实现。
2. `PrepareForkOfficialBaseResult.prepared`新增
   `refKind: "lightweight" | "annotated"`。Bare ref type只接受：
   - `commit` → lightweight，要求raw OID==`^{commit}`；
   - `tag` → annotated，保留raw tag-object OID与peeled commit；
   - 其他type → fail closed。
3. 两类ref都必须继续通过完整official-main ancestry、checkout import type/raw/peeled逐项
   equality、origin marker peeled equality、已有本地type/raw/peeled equality和zero-OID CAS。
   Lightweight本地Tag ref以commit OID创建；annotated以tag-object OID创建。不得放宽固定URL、
   cleanup、FETCH_HEAD、env isolation、redaction或no-mirror边界。
4. 专用测试GREEN后运行`tests/ci-workflows.test.ts`、typecheck、privacy、prepush和diff checks；
   提交仅这两个existing paths，中文subject。

### Repair C：重建replacement维护真源快照

**Files:**
- Modify and commit implementation evidence: `tests/fork-maintenance-truth.test.ts`
- Modify but keep uncommitted until review: `FORK_CHANGES.md`
- Do not modify: `package.json`（保持`2.35.0-ben.2`）

1. Amend现有maintenance test，使旧truth先RED，并机械要求：
   - failed candidate `d5558096bb229b5fbf5607a6468c2871b2b1213e`；
   - failed run `33234936660`及prepare-step/lightweight根因；
   - observed official type=`commit`且raw/peeled/marker=`fc4de772...`；
   - ben.2 Tag、promotion、final CI、Release未发生；
   - replacement candidate及later gates仍逐项`pending external gate`。
2. 提交maintenance-test amendment（不含`FORK_CHANGES.md`），捕获新的repair
   `IMPLEMENTATION_HEAD`。
3. 更新未提交的`FORK_CHANGES.md`：保留所有原本地/review证据，新增已知失败run与
   lightweight纠正；不得把失败run写成pending，也不得预写replacement成功。更新新的
   implementation HEAD/shortstat。测试转GREEN。
4. 重跑focused、typecheck、privacy、prepush、16-overlap、112-path与diff checks；复用原
   rebase `SPEC_COMPLIANCE`/`CODE_QUALITY` reviewer。通过后只提交`FORK_CHANGES.md`，并证明
   parent==repair IMPLEMENTATION_HEAD、docs-only、最终path count仍112。

### Repair D：复用controller state推进replacement candidate

1. 复用`.tmp/v2.35.0-ben.2-state.json`；必须已含candidate=`d5558096b`、run
   `33234936660`与`failureEvidence.kind=run_conclusion_failure`，且无tag/promotion/release。
   不调用`init-state`，不删除/重建state。
2. Fresh-read要求remote sync仍为`d5558096b`、main/marker仍为ben.1/official、本地远端ben.2
   Tag和origin official Tag均不存在；新docs candidate必须是d555 descendant。
3. 执行controller
   `supersede-candidate d5558096... NEW_CANDIDATE`，机械验证ancestor/exact predecessor lease/
   Tag absence，将失败candidate/run移入immutable history并重置candidate run slots。
4. 以`d5558096b`为`--force-with-lease` expected SHA，只fast-forward
   `origin/sync/v2.35.0`到replacement docs candidate；main/marker/Tag不动。
5. `snapshot candidate`→`intent candidate`→只dispatch一次（不传`run_windows`）→`bind`→
   watch→`verify candidate`。严格18-job allowlist与唯一job-level Windows skip不变。失败继续
   走successor规则；成功才进入后文Task 7。

### Repair E：Task 7与Release补充证据

后文Task 7原子promotion/Tag不变。Fork ben.2 Tag仍必须annotated。Tag annotation与Release
Notes除replacement candidate/final run外，还必须记录首个失败candidate `d5558096b` / run
`33234936660`、annotated-only assumption被真实official lightweight ref推翻以及对应修复。

### Repair 完成条件

- revised Spec/Plan、script/test、maintenance contract、replacement docs snapshot全部是
  d555 descendant且通过对应review；不重写已推送历史；
- overall official-relative path set仍为112、原105全部保留、新增集合仍为原七路径；
- `FORK_CHANGES.md`准确区分known failed candidate与pending replacement；
- replacement candidate CI严格成功前不存在ben.2 Tag/promotion/Release。

## Global Constraints

- 官方基线固定为 `v2.35.0` / `fc4de772b58c13f7b16b5029b1e981d612a5db06`；现有 `v2.35.0-ben.1` / `98b14f722097abce9107c76ff0eba5f4e60c2e0f` 不移动、不删除、不覆盖。
- 新版本固定为 `2.35.0-ben.2`，新 Tag 固定为 `v2.35.0-ben.2`；同名 Tag 一旦创建不得重建或移动。
- Fork origin必须保留每个已rebase官方基线的同名Tag：`v2.34.0` exact lightweight
  `80fff9a7f...`保持不变，`v2.35.0`以固定官方仓库验证的exact lightweight
  `fc4de772...`在本轮atomic promotion中补齐；任何existing mismatch均fail closed，禁止
  force、删除、重建或移动。CI仍必须每轮从固定官方URL独立重新验证，不能把origin当作
  provenance来源。
- 不弱化 `forkVersionTagError()`、空 Tag 集合保护、release-line、exact-SHA、branch lease、atomic push 或 CI-success 门禁。
- 不发布 npm、不替换开发机/持久环境的全局 OpenCodex、不操作 launchd/10100/用户配置。仅允许现有 disposable GitHub-hosted `npm-global-smoke` 执行隔离 `npm install -g`。
- Runtime 保留官方 v2.35 `WeakMap<OcxParsedRequest, string>` 隐私模型，不把 conversation scope 写进请求 body 或公共 request fields。
- Fork-only 新回归使用职责明确的新测试文件；本 Plan 唯一修改的既有测试文件是四个 Fork test 的六处 whitespace。
- `.github/workflows/ci.yml` 是安全边界：固定 remote、严格 ref、`contents: read`、无 secrets、无 push/force、credential redaction、失败 fail closed。
- 工作区直接使用当前 `sync/v2.35.0`；不创建 worktree。任何来源不明的 dirty state、ref 漂移、Tag 冲突或不确定写入结果立即停止。
- 每个实现 Task 使用中文 commit subject；Spec、Plan、实现、版本与最终真源分开提交。
- 实现 Task 完成后按 L2/L3 门禁审查；最终必须复用原 `SPEC_COMPLIANCE` 与 `CODE_QUALITY` reviewer 做完整 re-review，workflow security 是 CODE_QUALITY named-risk check。
- 用户已选择 SDD；Plan 通过后直接进入 `superpowers:subagent-driven-development`，不再询问 inline/SDD。

## File Map

| Path | Responsibility |
| --- | --- |
| `docs/superpowers/specs/2026-08-29-v2350-ben2-rebase-repair-design.md` | 已批准的行为、安全、验证和发布设计；已单独提交。 |
| `docs/superpowers/plans/2026-08-29-v2350-ben2-rebase-repair.md` | 本执行计划；实现前单独提交。 |
| `src/server/responses/core.ts` | 两个 post-bind parsed replacement 的局部 adopt/rebind 接线。 |
| `tests/fork-agent-task-recovery-kiro-turn-termination.test.ts` | Routed recovery × Kiro local terminal 行为回归与 canonical replacement 静态 invariant。 |
| `scripts/prepare-fork-official-base.ts` | CI-only official Tag/marker/main 取得、验证、redaction、local Tag publication。 |
| `tests/fork-ci-official-baseline.test.ts` | Version classifier、Git refs、完整 ancestry、credential redaction和workflow static contract。 |
| `.github/workflows/ci.yml` | 在 test/macOS/Windows suite 前准备官方 Tag；dispatch 强制 npm-global hosted matrix，并以 `run_windows=false` 保持 Windows suite 为显式测量 lane。 |
| `tests/fork-maintenance-truth.test.ts` | Package/FORK_CHANGES version、16 overlaps、v2.35 evidence、pending external gates。 |
| `package.json` | `2.35.0-ben.2` revision。 |
| `FORK_CHANGES.md` | Final docs-only pre-promotion snapshot；Tag 指向该 commit。 |
| `tests/fork-custom-tool-output-lowering.test.ts` | 删除 1 处 trailing whitespace。 |
| `tests/fork-relay-eager-flush.test.ts` | 删除 2 处 trailing whitespace。 |
| `tests/fork-sse-block-rewrite-flush.test.ts` | 删除 2 处 trailing whitespace。 |
| `tests/fork-usage-recovery-kinds.test.ts` | 删除 1 处 trailing whitespace。 |

---

### Task 1: Preserve Turn-Termination Scope Across Recovery Reparsing

**Files:**
- Create: `tests/fork-agent-task-recovery-kiro-turn-termination.test.ts`
- Modify: `src/server/responses/core.ts:2414-2423,2642-2665,3736-3744`

**Interfaces:**
- Consumes: `bindTurnTerminationScope(parsed: OcxParsedRequest, scope: string | undefined): void`, existing `resolvedConversationId`, `parseRequest()`, routed/native agent-task recovery.
- Produces: local `adoptParsedRequest(next: OcxParsedRequest): void`; no exported API. Later Tasks rely only on the committed behavior and test, not the helper name outside `core.ts`.

- [ ] **Step 1: Create the routed recovery × Kiro regression fixture**

Create the new test with isolated `OPENCODEX_HOME`, request-log reset, one local Kiro eventstream server, and the existing recovery helpers:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../src/adapters/kiro-constants";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { resetAgentTaskRecoveryState } from "../src/server/responses/agent-task-recovery";
import { clearRequestLogsForTests, getRequestLogEntries } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import {
  codexHeaders,
  encryptedInput,
  originalFetch,
  post,
  recoverySse,
} from "./helpers/agent-task-recovery";

const BACKEND_CIPHERTEXT = `gAAAA${"A".repeat(128)}`;
const THREAD_ID = "ben2-recovery-kiro-thread";
const ASSIGNMENT = "Return the recovered Kiro answer.";
const ANSWER = "Recovered Kiro answer complete.";

const enc = new TextEncoder();
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-ben2-recovery-kiro-"));
  process.env.OPENCODEX_HOME = testDir;
  clearRequestLogsForTests();
  resetAgentTaskRecoveryState();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAgentTaskRecoveryState();
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testDir, { recursive: true, force: true });
});
```

Add these exact local helpers:

```ts
function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": eventType },
    enc.encode(JSON.stringify(payload)),
  );
}

function completionFrames(answer: string): Uint8Array[] {
  const input = JSON.stringify({ answer });
  return [
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1" }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1", input }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "completion-1", stop: true }),
  ];
}

function streamOf(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
}

function scriptedKiroUpstream() {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requests.push(await req.json() as Record<string, unknown>);
      if (requests.length > 1) return new Response("unexpected extra Kiro attempt", { status: 500 });
      return new Response(streamOf(completionFrames(ANSWER)), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    },
  });
  return { server, requests };
}
```

Define `kiroRecoveryConfig(baseUrl)`:

```ts
function kiroRecoveryConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "kiro-test",
    agentTaskRecovery: { enabled: true },
    providers: {
      "kiro-test": {
        adapter: "kiro",
        baseUrl,
        authMode: "key",
        apiKey: "synthetic-token",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["gpt-5.6-sol"],
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}
```

- [ ] **Step 2: Write the failing two-turn behavior test**

Install this interceptor, then keep the Kiro server alive for both turns. One outer `try` must
contain the first `post()` and drain, the second `post()` and drain, and every request-log
assertion; its only `finally` stops the server after all assertions have run:

```ts
const kiro = scriptedKiroUpstream();
globalThis.fetch = (async (input, init) => {
  const body = typeof init?.body === "string" ? init.body : "";
  if (body.includes("capture_assignment")) {
    return new Response(recoverySse(ASSIGNMENT), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;
```

First call `post()` inside that same `try` with `encryptedInput({ ciphertext: BACKEND_CIPHERTEXT })`,
model `kiro-test/gpt-5.6-sol`, config `kiroRecoveryConfig(kiro.server.url.toString())`, and
`codexHeaders("acct-caller", { "thread-id": THREAD_ID })`. Drain/parse the completed response and
assert its final assistant text is `ANSWER`.

Still inside the same `try`, call `post()` with the exact same config, model and thread header and
this phase-less replay input:

```ts
[
  { type: "message", role: "user", content: [{ type: "input_text", text: ASSIGNMENT }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: ANSWER }] },
]
```

Assert after draining the second response:

```ts
expect(kiro.requests).toHaveLength(1);
const entry = getRequestLogEntries().filter(row => row.provider === "kiro-test").at(-1);
expect(entry).toBeDefined();
expect(entry!.localTerminalReason).toBe("kiro_final_answer_already_delivered");
expect(entry!.usageStatus).toBe("reported");
expect(entry!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
expect(entry!.usage?.estimated).toBeUndefined();
expect(entry!.attempts).toHaveLength(1);
expect(entry!.attempts![0]!.sendCount).toBe(0);
```

The outer `finally` then calls `kiro.server.stop(true)`. Because the server remains live through
the replay, any accidental second Kiro send is recorded in `kiro.requests` and deterministically
fails the `toHaveLength(1)` assertion; connection failure cannot masquerade as zero-send evidence.

- [ ] **Step 3: Add the canonical replacement static invariant**

In the same new file, read `src/server/responses/core.ts` and assert the post-bind region contains one local `adoptParsedRequest` definition, exactly two calls for the routed/native replacements, and no remaining raw assignments matching either:

```ts
expect(postBindSource).not.toContain("parsed = reparsed;");
expect(postBindSource).not.toContain("parsed = { ...parsed, context: reparsed.context");
expect((postBindSource.match(/adoptParsedRequest\(/g) ?? []).length).toBe(3); // definition + 2 calls
```

- [ ] **Step 4: Run the new test to prove RED**

Run:

```bash
bun test tests/fork-agent-task-recovery-kiro-turn-termination.test.ts
```

Expected: FAIL because the second Kiro request is sent and/or the static test finds raw parsed assignments. Record the exact failing assertion in the Task report.

- [ ] **Step 5: Implement the minimal local adopt/rebind entry**

Immediately after the existing initial bind in `handleResponsesInner()` add:

```ts
const adoptParsedRequest = (next: OcxParsedRequest): void => {
  parsed = next;
  bindTurnTerminationScope(parsed, resolvedConversationId);
};
```

Replace only the two assignments:

```ts
adoptParsedRequest(reparsed);
```

and:

```ts
adoptParsedRequest({ ...parsed, context: reparsed.context, _rawBody: reparsed._rawBody });
```

Do not alter recovery conditions, kept fields, route selection, cache flags, abort behavior or retry order.

- [ ] **Step 6: Run focused GREEN and typecheck**

Run:

```bash
bun test tests/fork-agent-task-recovery-kiro-turn-termination.test.ts \
  tests/agent-task-recovery-routed-backend.test.ts \
  tests/fork-agent-task-recovery-backend.test.ts \
  tests/server-kiro-completion-e2e.test.ts
bun run typecheck
```

Expected: all listed tests PASS, zero fail; typecheck exit 0.

- [ ] **Step 7: Verify Task 1 surface and commit**

Run:

```bash
git diff --check
git diff --name-only
```

Expected changed paths exactly:

```text
src/server/responses/core.ts
tests/fork-agent-task-recovery-kiro-turn-termination.test.ts
```

Commit:

```bash
git add src/server/responses/core.ts tests/fork-agent-task-recovery-kiro-turn-termination.test.ts
git commit -m "fix: 在 recovery 后恢复 turn termination scope"
```

Controller review gate: L2/L3 `SPEC_COMPLIANCE` + `CODE_QUALITY`; any Important blocks Task 2.

---

### Task 2: Prepare Verified Official Base Tag in Origin-Only Checkouts

**Files:**
- Create: `scripts/prepare-fork-official-base.ts`
- Create: `tests/fork-ci-official-baseline.test.ts`

**Interfaces:**
- Consumes: `forkBaseVersion(value: string): string | null`, fixed official URL, Git CLI,
  `redactSecretString()`, `redactUrlForLog()`, and `redactUserPath()`.
- Produces:

```ts
export type VersionClassification =
  | { kind: "fork"; version: string; base: string; tag: string }
  | { kind: "non-fork"; version: string };

export type PrepareForkOfficialBaseResult =
  | { kind: "not-fork"; version: string }
  | {
      kind: "prepared";
      version: string;
      tag: string;
      refKind: "lightweight" | "annotated";
      rawTagOid: string;
      peeledCommit: string;
    };

export type GitRunner = (cwd: string, args: readonly string[]) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitOperation =
  | "fetch origin marker"
  | "init official verifier"
  | "fetch official refs"
  | "verify official ancestry"
  | "import official tag"
  | "verify official tag"
  | "publish local tag"
  | "cleanup official verifier"
  | "prepare official base";

export function classifyPackageVersion(raw: unknown): VersionClassification;
export function safeGitDiagnostic(
  operation: GitOperation,
  error: unknown,
  ownedPaths?: readonly string[],
): string;
export function prepareForkOfficialBase(options: {
  repoRoot: string;
  officialRepositoryUrl: string;
  runGit?: GitRunner;
}): PrepareForkOfficialBaseResult;
export function prepareForkOfficialBaseCli(): PrepareForkOfficialBaseResult;
```

Only `prepareForkOfficialBaseCli()` supplies the production fixed URL; tests may inject a local official repo into the lower-level function.

- [ ] **Step 1: Write classifier RED tests**

Create tests asserting:

```ts
expect(classifyPackageVersion("2.35.0-ben.2")).toEqual({
  kind: "fork", version: "2.35.0-ben.2", base: "2.35.0", tag: "v2.35.0",
});
for (const value of [
  " 2.35.0-ben.2 ", "2.35.0-ben", "2.35.0-ben.0", "2.35.0-ben.02",
  "2.35.0-ben.9007199254740993", "2.35.0-ben.2.extra", "2.35.0-rc.1",
  "2.35.0-beta.1", "2.35.0-foo.1", "not-semver",
]) expect(() => classifyPackageVersion(value)).toThrow();
expect(classifyPackageVersion("2.35.0")).toEqual({ kind: "non-fork", version: "2.35.0" });
expect(classifyPackageVersion("2.36.0-preview.20260829"))
  .toEqual({ kind: "non-fork", version: "2.36.0-preview.20260829" });
```

Inject a `GitRunner` counter and assert malformed/non-Fork classification invokes Git zero times.

- [ ] **Step 2: Write origin-only Git proof RED tests**

Build disposable repositories under `mkdtempSync(join(tmpdir(), "ocx-fork-base-"))`; import
`pathToFileURL` from `node:url` and use file URLs for every local remote crossing a clone/fetch
boundary:

- official repo with full history, observed-style lightweight `v2.35.0`, and `main` one or more
  commits ahead; add a separate annotated official-Tag success fixture;
- origin repo whose `upstream-release` points at the official Tag commit and whose tags contain only `v2.35.0-ben.1`;
- shallow checkout of origin with `package.json` set to `2.35.0-ben.2`.

Use one exact argv-only fixture helper throughout the test:

```ts
function git(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
```

Create official history by committing a tagged baseline, creating lightweight `v2.35.0`, then adding
two `main` commits. Create the origin bare repo from that history, delete the official Tag from the
origin namespace, keep `upstream-release` at the tagged commit, add only
`v2.35.0-ben.1`, and clone its Fork branch with exact argv:

```ts
git(fixtureRoot, [
  "clone", "--depth=1", "--branch", "sync/v2.35.0", "--single-branch",
  pathToFileURL(originBarePath).href, checkout,
]);
```

Before calling the subject, assert all of these preconditions:

```ts
expect(git(checkout, ["rev-parse", "--is-shallow-repository"]).stdout.trim()).toBe("true");
expect(git(checkout, ["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0"]).exitCode)
  .not.toBe(0);
expect(git(checkout, ["tag", "--list", "v*"]).stdout.trim().split("\n").filter(Boolean))
  .toEqual(["v2.35.0-ben.1"]);
expect(git(officialRepo, [
  "rev-list", "--count", `${officialTagCommit}..refs/heads/main`,
]).stdout.trim()).toBe("2");
```

The fixture must use full `refs/heads/sync/v2.35.0` / `refs/heads/upstream-release` names and must
not use a plain local path or rely on Git's local-clone optimization. This proves the successful
path begins shallow and does not inherit official refs from the controller repository.

Call `prepareForkOfficialBase()` with the local official repo URL. Assert:

```ts
expect(result).toMatchObject({ kind: "prepared", tag: "v2.35.0" });
expect(result).toMatchObject({ refKind: "lightweight" });
expect(git(checkout, ["cat-file", "-t", "refs/tags/v2.35.0"]).stdout.trim()).toBe("commit");
expect(git(checkout, ["rev-parse", "refs/tags/v2.35.0^{commit}"]).stdout.trim())
  .toBe(officialTagCommit);
```

Add isolated fixtures for annotated official Tag success, unsupported blob/tree official ref,
marker mismatch, non-ancestor Tag, local same-name forged Tag, missing marker, missing main/tag,
fetch failure, and existing identical official Tag for both accepted kinds. Wrap the injected runner
to capture every argv vector and assert the official fetch
contains `--filter=blob:none`, contains no `--depth`, `--shallow-*` or `--unshallow`, and targets
only the exact Tag plus full `refs/heads/main`. On both success and every failure fixture, assert
the two owned `refs/ocx-ci/*` refs are absent afterward, the temporary bare directory is removed,
and a sentinel unrelated ref created before the call still points to its original OID. Before each
call, resolve `git rev-parse --git-path FETCH_HEAD` and capture that file as either absent or exact
bytes; after every success/failure path,
require the same absent/byte-identical state. Assert both fetches that write into the retained
checkout contain `--no-write-fetch-head`; the official fetch inside the disposable bare repo need
not, because that entire repo is removed.

- [ ] **Step 3: Write credential-redaction and production-entry RED tests**

Inject a runner returning stderr assembled from separately concatenated fragments so the tracked
Plan/test source contains no privacy-scan-shaped email or home path while the runtime fixture still
contains the exact adversarial values:

```ts
const userInfoUrl = `https://${"user"}:${"secret-token"}@${"example.invalid"}/repo.git`
  + `?access_token=${"secret-token"}#private-fragment`;
const macHome = `/${"Users"}/${"private-name"}/work/repo`;
const linuxHome = `/${"home"}/${"linux-private"}/work/repo`;
const windowsHome = `C:${"\\"}${"Users"}${"\\"}${"windows-private"}${"\\"}work${"\\"}repo`;
const stderr = [
  userInfoUrl,
  `Authorization: Bearer ${"secret-token"}`,
  macHome,
  linuxHome,
  windowsHome,
  `/${"private"}/var/folders/xy/ocx-fork-official-secret/repo.git`,
  `/${"tmp"}/ocx-fork-official-secret/repo.git`,
  `D:${"\\"}Temp${"\\"}ocx-fork-official-secret${"\\"}repo.git`,
  `Authorization: Bearer ${"secret-token"}\u0007\u2028forged-line`,
].join("\n");
```

Construct the last line in TypeScript so `\u0007` and `\u2028` are actual code points, not four
printable backslash characters.

Assert thrown/user-visible output contains none of `user`, `secret-token`,
`Authorization: Bearer`, `private-name`, `linux-private`, `windows-private`, control characters,
`ocx-fork-official-secret`, line breaks or URL query/fragment material; contains
`[CREDENTIAL HEADER REDACTED]` and `[REDACTED_PATH]`; and the entire
message including operation prefix is at most 512 characters. Cover Git nonzero exit, a runner
that throws, cleanup failure with and without an earlier primary failure, and stderr longer than
4 KiB. Pass the exact fixture `repoRoot`, `verifierRoot` and `bareDir` as `ownedPaths`, including
the cleanup-exception fixture whose message contains `bareDir`. The earlier primary verification
failure must remain the main message; cleanup may append
only the fixed suffix `; cleanup also failed`.

Create a cross-platform fake Git executable (`git` shell wrapper on POSIX, `git.cmd` on Windows,
both delegating to one temporary Bun `.mjs`) which logs argv as JSON, returns success for owned-ref
pre-clean/origin fetch/bare init, and fails the official fetch with the adversarial stderr above.
Spawn the actual production file as:

```ts
Bun.spawnSync([process.execPath, scriptPath, "https://evil.invalid/override"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    OCX_OFFICIAL_REPOSITORY_URL: "https://evil.invalid/from-env",
    FAKE_GIT_LOG: fakeGitLog,
  },
  stdout: "pipe",
  stderr: "pipe",
});
```

Assert direct execution exits nonzero, stdout is empty, stderr is exactly one bounded safe line,
and the logged official-fetch argv contains only
`https://github.com/lidge-jun/opencodex.git`, never either evil URL. This proves the
`import.meta.main` path actually invokes preparation, uses the fixed production URL, and fails
closed without a stack/private path. Also import the module normally and assert import alone runs
zero Git commands.

- [ ] **Step 4: Run Task 2 tests to prove RED**

Run:

```bash
bun test tests/fork-ci-official-baseline.test.ts
```

Expected: FAIL because the script/module does not exist.

- [ ] **Step 5: Implement deterministic classification**

Use raw string equality before `forkBaseVersion()` and exact reserved/no-op boundaries:

```ts
const RESERVED_BEN = /-ben(?:\.|$)/;
const NON_FORK = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview(?:\.[0-9A-Za-z-]+)+)?$/;

export function classifyPackageVersion(raw: unknown): VersionClassification {
  if (typeof raw !== "string" || raw !== raw.trim()) throw new Error("invalid package version");
  const base = forkBaseVersion(raw);
  if (base) return { kind: "fork", version: raw, base, tag: `v${base}` };
  if (RESERVED_BEN.test(raw) || !NON_FORK.test(raw) || hasLeadingZeroNumericPreviewPart(raw)) {
    throw new Error("invalid or reserved package version");
  }
  return { kind: "non-fork", version: raw };
}
```

- [ ] **Step 6: Implement safe Git runner and ref protocol**

Import `redactSecretString`, `redactUrlForLog`, and `redactUserPath`. Define one diagnostic entry
and use it for every Git nonzero exit, thrown runner error, CLI error and cleanup error:

```ts
const EMBEDDED_URL = /https?:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_HEADER_LINE = /(^|\n)[^\n]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\s*:[^\n]*/gi;
const LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

export function safeGitDiagnostic(
  operation: GitOperation,
  error: unknown,
  ownedPaths: readonly string[] = [],
): string {
  let detail = error instanceof Error ? error.message : String(error);
  detail = detail.replace(/\r\n?|\u2028|\u2029/g, "\n");
  detail = detail.replace(
    CREDENTIAL_HEADER_LINE,
    (_line, boundary: string) => `${boundary}[CREDENTIAL HEADER REDACTED]`,
  );
  detail = detail.replace(EMBEDDED_URL, value => redactUrlForLog(value));
  for (const path of [...ownedPaths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    detail = detail.split(path).join("[REDACTED_PATH]");
    detail = detail.split(path.replaceAll("\\", "/")).join("[REDACTED_PATH]");
    detail = detail.split(path.replaceAll("/", "\\")).join("[REDACTED_PATH]");
  }
  detail = redactUserPath(redactSecretString(detail));
  detail = detail.replace(LOG_CONTROL, " ").replace(/\s+/g, " ").trim();
  return `${operation}: ${detail || "git command failed"}`.slice(0, 512);
}
```

`GitOperation` is the closed union in Interfaces; never accept an arbitrary operation label.
Every caller after temp-root creation passes `[repoRoot, verifierRoot, bareDir]`; pre-temp
classification errors pass `[repoRoot]`. Once paths exist, include both their original spelling and
`realpathSync()` spelling in the deduplicated owned-path list so macOS `/var`→`/private/var`
canonicalization cannot evade folding. URL redaction runs before exact owned-path folding, then
secret/user-path/control handling. This avoids both arbitrary-temp leakage and URL-parser damage.
`runOrThrow()` receives the owned-path array, catches both a thrown `GitRunner` and a nonzero
result, and throws only `new Error(safeGitDiagnostic(operation, cause, ownedPaths))`. Never echo argv, remote URL, raw stderr,
`error.stack`, or a temp path.

Implement argv-only `Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })`.
The production runner preserves the executable `PATH` but sets `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_NOSYSTEM=1`, and `GIT_CONFIG_GLOBAL` to an owner-only empty config inside the
verifier temp directory; first remove every inherited environment entry whose key begins with
`GIT_CONFIG`, then set only those two exact config controls. The official fetch runs against the newly
initialized bare repo, whose local config is script-owned, so neither system/global/injected Git
config can rewrite the fixed official URL. Tests' injected `GitRunner` remains env-independent.

Use these exact owned refs/constants:

```ts
const ZERO_OID = "0".repeat(40);
const MARKER_REF = "refs/ocx-ci/fork-marker";
const OFFICIAL_TAG_REF = "refs/ocx-ci/official-tag";
const OFFICIAL_URL = "https://github.com/lidge-jun/opencodex.git";
```

The core argv sequence must be equivalent to:

```ts
runOrThrow("cleanup official verifier", repoRoot, ["update-ref", "-d", MARKER_REF]);
runOrThrow("cleanup official verifier", repoRoot, ["update-ref", "-d", OFFICIAL_TAG_REF]);
runOrThrow("fetch origin marker", repoRoot, [
  "fetch", "--no-tags", "--no-write-fetch-head", "origin",
  `+refs/heads/upstream-release:${MARKER_REF}`,
]);
runOrThrow("init official verifier", repoRoot, ["init", "--bare", bareDir]);
runOrThrow("fetch official refs", repoRoot, [
  `--git-dir=${bareDir}`, "fetch", "--no-tags", "--filter=blob:none",
  officialRepositoryUrl,
  "+refs/heads/main:refs/heads/official-main",
  `+refs/tags/${classification.tag}:refs/tags/${classification.tag}`,
]);
const bareTagRef = `refs/tags/${classification.tag}`;
const bareType = runOrThrow("verify official tag", repoRoot, [
  `--git-dir=${bareDir}`, "cat-file", "-t", bareTagRef,
]).stdout.trim();
if (bareType !== "tag" && bareType !== "commit") {
  throw new Error("official release ref is not a tag or commit");
}
const bareRawOid = runOrThrow("verify official tag", repoRoot, [
  `--git-dir=${bareDir}`, "rev-parse", bareTagRef,
]).stdout.trim();
const barePeeledCommit = runOrThrow("verify official tag", repoRoot, [
  `--git-dir=${bareDir}`, "rev-parse", `${bareTagRef}^{commit}`,
]).stdout.trim();
if (bareType === "commit" && bareRawOid !== barePeeledCommit) {
  throw new Error("lightweight official ref raw and peeled commits differ");
}
runOrThrow("verify official ancestry", repoRoot, [
  `--git-dir=${bareDir}`, "merge-base", "--is-ancestor",
  barePeeledCommit, "refs/heads/official-main",
]);
runOrThrow("import official tag", repoRoot, [
  "fetch", "--no-tags", "--no-write-fetch-head", bareDir,
  `+refs/tags/${classification.tag}:${OFFICIAL_TAG_REF}`,
]);
```

Immediately after the official fetch and before the import command shown above, run these bare-repo
argv calls in exact order:

1. `cat-file -t refs/tags/TAG` and require stdout exactly `tag` or `commit`; classify it as
   `annotated` or `lightweight` respectively, rejecting every other object type;
2. `rev-parse refs/tags/TAG` to capture the raw ref OID;
3. `rev-parse refs/tags/TAG^{commit}` to capture the peeled commit;
4. for `commit`, require raw==peeled; for `tag`, retain the raw tag-object OID; then run
   `merge-base --is-ancestor PEELED_COMMIT refs/heads/official-main` and require exit 0.

Only then execute `import official tag`. After import, run `cat-file -t OFFICIAL_TAG_REF`,
`rev-parse OFFICIAL_TAG_REF`, and `rev-parse OFFICIAL_TAG_REF^{commit}` as separate checkout argv
calls and require type/raw/peeled to equal the already captured bare evidence before comparing the
marker or publishing the local Tag. The argv-capture test must compare command indices and prove
`bare type < bare raw < bare peeled < ancestry < import < checkout type/raw/peeled`; presence
without this order is a failure.
The complete algorithm must:

1. create the verifier root with `mkdtempSync(join(tmpdir(), "ocx-fork-official-"))`,
   immediately enforce `chmodSync(verifierRoot, 0o700)`, create its empty global-config file with
   mode `0o600`, set `bareDir = join(verifierRoot, "repo.git")`, and construct the sanitized Git
   environment before the first command;
2. delete only `refs/ocx-ci/fork-marker` / `refs/ocx-ci/official-tag` from the checkout;
3. fetch exact origin `upstream-release` into the marker temp ref and initialize `bareDir`;
4. fetch full official `main` commit graph plus exact raw Tag with `--filter=blob:none` and no depth;
5. require official ref object type `tag` or `commit`, classify annotated/lightweight, capture bare
   raw/peeled, require raw==peeled for lightweight, then require
   `merge-base --is-ancestor peeled official-main` exit 0;
6. only after Step 5, fetch the verified Tag object from the bare repo into checkout temp ref with
   `--no-write-fetch-head`, then require checkout type/raw/peeled equal the bare evidence;
7. compare the already verified peeled commit with marker;
8. require any existing local official Tag type+raw+peeled to match; if absent, create
   `refs/tags/${classification.tag}` with
   `["update-ref", localTagRef, officialRawOid, ZERO_OID]`;
9. always attempt deletion of both owned temp refs and
   `rmSync(verifierRoot, { recursive: true, force: true })`. Capture the primary verification error
   before cleanup. If cleanup alone fails, throw
   `safeGitDiagnostic("cleanup official verifier", cleanupError)`; if primary and cleanup both
   fail, reserve space inside the 512-character cap and append exactly
   `; cleanup also failed`, so the suffix cannot be truncated. Next-run owned-ref pre-clean remains
   the forced-termination fallback.

Define `const CLI_REPO_ROOT = resolve(import.meta.dir, "..")`.
`prepareForkOfficialBaseCli()` takes no arguments and passes only `CLI_REPO_ROOT` plus the source
constant `OFFICIAL_URL` to the lower-level function. End the module with this exact production
guard:

```ts
if (import.meta.main) {
  try {
    prepareForkOfficialBaseCli();
  } catch (error) {
    console.error(safeGitDiagnostic("prepare official base", error, [CLI_REPO_ROOT]));
    process.exitCode = 1;
  }
}
```

Success is silent. The CLI does not parse `Bun.argv` and does not read a URL or repo-root override
from `process.env`.

- [ ] **Step 7: Run Task 2 GREEN and static safety checks**

Run:

```bash
bun test tests/fork-ci-official-baseline.test.ts
bun run typecheck
bun run privacy:scan
```

Expected: tests/typecheck/privacy exit 0.

- [ ] **Step 8: Verify Task 2 surface and commit**

Expected changed paths exactly:

```text
scripts/prepare-fork-official-base.ts
tests/fork-ci-official-baseline.test.ts
```

Commit:

```bash
git add scripts/prepare-fork-official-base.ts tests/fork-ci-official-baseline.test.ts
git commit -m "ci: 准备 Fork 官方基线 Tag 证据"
```

Controller review gate: independent `SPEC_COMPLIANCE` + security-focused `CODE_QUALITY`; any Important blocks Task 3.

---

### Task 3: Wire Official-Base Preparation Into Cross-Platform CI

**Files:**
- Modify: `.github/workflows/ci.yml:35-36,249-310,456-546,565-669,736-783`
- Modify: `tests/fork-ci-official-baseline.test.ts`

**Interfaces:**
- Consumes: Task 2 CLI `bun scripts/prepare-fork-official-base.ts`.
- Produces: exact workflow contract: preparation in `test`, `platform-macos`, `platform-windows`; dispatch-forced hosted npm-global matrix; `run_windows` opt-in measurement lane.

- [ ] **Step 1: Add failing parsed-workflow assertions**

Read `.github/workflows/ci.yml` and parse it with `Bun.YAML.parse`, matching the established
`tests/ci-workflows.test.ts` contract. Type the parsed shape locally with `permissions` and
`jobs: Record<string, { needs?: string | string[]; if?: string; "runs-on"?: unknown; strategy?: unknown; steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }> }>`.
Assert each of `test`, `platform-macos`, `platform-windows` contains exactly one step:

```yaml
- name: Prepare verified Fork official base
  run: bun scripts/prepare-fork-official-base.ts
```

For each, assert its index is after `Setup project Bun` and before both `Install dependencies` and the test step. Assert the command is absent from `storage-policy`, `api-usage`, `gates`, `keyring-smoke`, `npm-global-smoke`, and `.github/actions/setup-project-bun/action.yml`.

Assert root permissions stay `contents: read`, every checkout keeps `persist-credentials: false`, and `npm-global-smoke` has:

```yaml
if: github.event_name == 'workflow_dispatch' || needs.changes.outputs.packaging == 'true'
runs-on: ${{ matrix.os }}
matrix:
  os: [ubuntu-latest, windows-latest, macos-latest]
```

Assert `npm-global-smoke.needs` is exactly `changes`, contains no `self-hosted`, no dynamic runner expression, and no `select-windows-runner` dependency.

Also assert `workflow_dispatch.inputs.run_windows` exists with exact type `boolean`, `required: false`, and default `false`. Assert `platform-windows.if`, after YAML folded-scalar normalization, is exactly:

```text
github.event_name == 'workflow_dispatch' && inputs.run_windows == true
```

Assert `jobs["platform-windows"].name` is exactly
`windows ${{ matrix.shard }}/4`. This tracked mapping is the identity bridge used by the external
controller: a pre-matrix job-level skip is returned by GitHub with that literal unexpanded name
and zero steps, while executed matrix shards render `windows 1/4` through `windows 4/4`.

The static contract must also pin the release-verifier semantics used in Task 6: a normal candidate dispatch omits `run_windows`, accepts only the job-level `platform-windows` result as `skipped`, and expects no expanded `windows 1/4`–`windows 4/4` records. It must not treat aggregate `ci` success as a substitute for this explicit allowlist.

- [ ] **Step 2: Run workflow test to prove RED**

Run:

```bash
bun test tests/fork-ci-official-baseline.test.ts
```

Expected: FAIL because workflow steps/dispatch condition are absent.

- [ ] **Step 3: Add the dispatch input and gate the Windows measurement lane**

Replace the empty dispatch trigger with:

```yaml
  workflow_dispatch:
    inputs:
      run_windows:
        description: Run the Windows suite measurement lane
        required: false
        type: boolean
        default: false
```

Change only the `platform-windows.if` expression to:

```yaml
    if: >-
      github.event_name == 'workflow_dispatch' &&
      inputs.run_windows == true
```

Do not change `platform-windows.needs`, runner selection, matrix, timeout, or steps. The ben.2 candidate dispatch in Task 6 deliberately omits this input. An optional, separate maintenance measurement may pass `run_windows=true`, but it is not release evidence and is outside the shipping verdict.

- [ ] **Step 4: Add the preparation steps to the exact three jobs**

Insert immediately after Setup Bun in `test`, `platform-macos`, and `platform-windows`:

```yaml
      - name: Prepare verified Fork official base
        run: bun scripts/prepare-fork-official-base.ts
```

Do not add permissions, secrets, remote inputs, environment overrides or composite-action wiring.

- [ ] **Step 5: Force hosted package smoke for workflow_dispatch**

Change only the `npm-global-smoke.if` expression to:

```yaml
    if: github.event_name == 'workflow_dispatch' || needs.changes.outputs.packaging == 'true'
```

Keep its exact hosted matrix and `runs-on: ${{ matrix.os }}`.

- [ ] **Step 6: Run workflow/security GREEN**

Run:

```bash
bun test tests/fork-ci-official-baseline.test.ts tests/ci-workflows.test.ts
bun run typecheck
bun run privacy:scan
```

Expected: all pass; no workflow permission diff except the intended steps/condition.

- [ ] **Step 7: Inspect workflow diff and commit**

Run:

```bash
git diff --check
git diff -- .github/workflows/ci.yml tests/fork-ci-official-baseline.test.ts
```

Confirm fixed URL is owned by the script, not workflow input; no `pull_request_target`, secret, write permission, self-hosted npm-global or shell interpolation was introduced.

Commit:

```bash
git add .github/workflows/ci.yml tests/fork-ci-official-baseline.test.ts
git commit -m "ci: 接入 origin-only Fork 基线门禁"
```

Controller review gate: independent `SPEC_COMPLIANCE` + explicit security `CODE_QUALITY`; any Important blocks Task 4.

---

### Task 4: Remove Six Fork-Test Whitespace Additions

**Files:**
- Modify: `tests/fork-custom-tool-output-lowering.test.ts:17`
- Modify: `tests/fork-relay-eager-flush.test.ts:212,230`
- Modify: `tests/fork-sse-block-rewrite-flush.test.ts:166,178`
- Modify: `tests/fork-usage-recovery-kinds.test.ts:141`

**Interfaces:**
- Consumes: reviewer line inventory.
- Produces: no behavior/API; clean official-relative `git diff --check` for these lines.

- [ ] **Step 1: Confirm the six RED whitespace diagnostics**

Run:

```bash
git diff --check v2.35.0...HEAD
```

Expected: the six listed trailing-whitespace diagnostics appear.

- [ ] **Step 2: Remove only the six trailing-space byte sequences**

Use `apply_patch` on the exact six reviewer lines, replacing each whitespace-bearing blank line with
an empty blank line. Do not alter text, assertions, line ordering or blank-line count. Review
`git diff --word-diff=porcelain` and require only whitespace markers.

- [ ] **Step 3: Verify cleanup**

Run:

```bash
git diff --check v2.35.0...HEAD
bun test tests/fork-custom-tool-output-lowering.test.ts \
  tests/fork-relay-eager-flush.test.ts \
  tests/fork-sse-block-rewrite-flush.test.ts \
  tests/fork-usage-recovery-kinds.test.ts
```

Expected: no whitespace diagnostics; all tests pass.

- [ ] **Step 4: Commit mechanical cleanup**

```bash
git add tests/fork-custom-tool-output-lowering.test.ts \
  tests/fork-relay-eager-flush.test.ts \
  tests/fork-sse-block-rewrite-flush.test.ts \
  tests/fork-usage-recovery-kinds.test.ts
git commit -m "test: 清理 Fork 用例尾随空格"
```

Controller review gate: L0 structured review recording exact paths, no semantic diff, focused test evidence and zero residual runtime risk.

---

### Task 5: Advance ben.2 and Establish the Maintenance-Truth Red/Green Contract

**Files:**
- Create: `tests/fork-maintenance-truth.test.ts`
- Modify: `package.json:3`
- Modify later in this Task: `FORK_CHANGES.md`

**Interfaces:**
- Consumes: committed Tasks 1–4, exact official/fork refs and path matrix, package version.
- Produces: `2.35.0-ben.2`, captured `IMPLEMENTATION_HEAD`, green final pre-promotion snapshot, final docs-only commit.

- [ ] **Step 1: Write the maintenance-truth contract test**

Create a test that reads `package.json` and `FORK_CHANGES.md`. Define this exact sorted overlap
truth in the test:

```ts
const EXPECTED_OVERLAPS = [
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh-TW.ts",
  "gui/src/i18n/zh.ts",
  "package.json",
  "src/adapters/base.ts",
  "src/adapters/openai-responses.ts",
  "src/server/responses/core.ts",
  "src/usage/log.ts",
  "tests/openai-responses-passthrough.test.ts",
  "tests/update-stop-first.test.ts",
] as const;

const EXPECTED_AUTO_MERGES = EXPECTED_OVERLAPS.filter(path => path !== "package.json");
```

The document update in Step 5 must introduce two machine-delimited sections:

```markdown
<!-- ben2-overlap:start -->
Conflict (1):
- `package.json`

Auto-merge (15):
- one sorted backticked path per line
<!-- ben2-overlap:end -->

<!-- ben2-external-gates:start -->
| Gate | Tagged snapshot state |
| --- | --- |
| Candidate Cross-platform CI | `pending external gate` |
| Atomic promotion | `pending external gate` |
| Final main Cross-platform CI | `pending external gate` |
| GitHub Release | `pending external gate` |
<!-- ben2-external-gates:end -->
```

Parse the overlap block rather than using substring presence. Assert the conflict set equals only
`["package.json"]`, the auto-merge set equals `EXPECTED_AUTO_MERGES`, their sorted union equals
`EXPECTED_OVERLAPS`, and their counts are exactly 1/15/16. Parse the external-gates table and
assert its row map equals the exact four rows above. Within that block reject `/https?:\/\//`,
`/\brun\s+#?\d+/i`, and `\b(?:success|passed|completed)\b/i` so future evidence cannot be
pre-written into the immutable snapshot.

Also assert:

```ts
const version = JSON.parse(packageText).version;
expect(version).toBe("2.35.0-ben.2");
expect(changes).toContain("| Fork 包版本 | `2.35.0-ben.2` |");
expect(changes).toContain("| 本轮派生 Tag | `v2.35.0-ben.2`");
expect(changes).toContain("16 paths");
expect(changes).toContain("pending external gate");
expect(changes).not.toContain("当前为\n  `2.34.0-ben.2`");
```

Add exact section assertions that active GLM/Kimi, standalone web search, Zhipu discovery, runner and CI comparisons name `v2.35.0`; historical ben.1–ben.9 paragraphs may retain v2.34 references. Assert strict backend recovery is identified as Fork behavior and official turn termination as v2.35 behavior.

- [ ] **Step 2: Bump package version and prove document RED**

Change only:

```json
"version": "2.35.0-ben.2"
```

Run:

```bash
bun test tests/fork-maintenance-truth.test.ts
```

Expected: FAIL on old `FORK_CHANGES.md` current version/overlap/evidence. Record the first failing assertion.

- [ ] **Step 3: Commit the intentional red contract and version**

```bash
git add package.json tests/fork-maintenance-truth.test.ts
git commit -m "chore: 推进 v2.35.0-ben.2 版本真源"
```

Set and persist in the controller task report:

```bash
IMPLEMENTATION_HEAD=$(git rev-parse HEAD)
```

Do not amend or reassign this variable unless a later implementation fix creates a new implementation commit; in that case repeat the capture and regenerate the final document.

- [ ] **Step 4: Collect exact current evidence for FORK_CHANGES**

Run and retain exact outputs:

```bash
git diff --name-status v2.35.0...$IMPLEMENTATION_HEAD
git diff --shortstat v2.35.0...$IMPLEMENTATION_HEAD
git diff --check v2.35.0...$IMPLEMENTATION_HEAD
git log --reverse --oneline v2.35.0..$IMPLEMENTATION_HEAD
git rev-parse refs/tags/v2.35.0^{} origin/upstream-release
```

Compute and assert the original rebase overlap against the immutable ben.1 boundary with this
exact Node ESM command (the ben.2 workflow addition must not be folded into the historical rebase
conflict account):

```bash
node --input-type=module -e '
import { execFileSync } from "node:child_process";
const paths = args => execFileSync("git", args, { encoding: "utf8" })
  .trim().split("\n").filter(Boolean).sort();
const official = new Set(paths(["diff", "--name-only", "v2.34.0", "v2.35.0"]));
const fork = paths(["diff", "--name-only", "v2.35.0", "98b14f722097abce9107c76ff0eba5f4e60c2e0f"]);
const actual = fork.filter(path => official.has(path)).sort();
const expected = [
  "gui/src/i18n/de.ts", "gui/src/i18n/en.ts", "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts", "gui/src/i18n/ko.ts", "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts", "gui/src/i18n/zh-TW.ts", "gui/src/i18n/zh.ts",
  "package.json", "src/adapters/base.ts", "src/adapters/openai-responses.ts",
  "src/server/responses/core.ts", "src/usage/log.ts",
  "tests/openai-responses-passthrough.test.ts", "tests/update-stop-first.test.ts",
].sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`rebase overlap mismatch\nactual=${JSON.stringify(actual)}`);
}
console.log(JSON.stringify(actual, null, 2));
'
```

Retain the exact sorted output as Task evidence.

- [ ] **Step 5: Update FORK_CHANGES as pre-promotion snapshot**

Use `apply_patch` to update current-state sections only:

- current package/target: `2.35.0-ben.2` / `v2.35.0-ben.2`;
- implementation HEAD and exact shortstat from Step 4;
- ben.1 historical failure and ben.2 runtime/CI fixes;
- exact machine-delimited 16-overlap block from Step 1, with `package.json` as the only conflict
  and all sorted remaining 15 paths as auto-merges;
- official v2.35 turn termination + Fork strict recovery ownership;
- all active official comparisons updated to v2.35 with unchanged blob/path evidence where applicable;
- local gates/reviews completed so far;
- exact machine-delimited four-row external-gates table from Step 1, with candidate CI,
  promotion, final main CI and Release separately `pending external gate`;
- runner-local official Tag proof may persist but is revalidated; origin official Tag remains forbidden;
- existing real-ciphertext, Ark weekly quota and service-repair known gaps retained.

Do not write candidate/final run IDs, promotion success, Release URL or future pass claims.

- [ ] **Step 6: Prove document GREEN before committing it**

Run:

```bash
bun test tests/fork-maintenance-truth.test.ts
git diff --check -- FORK_CHANGES.md
```

Expected: PASS and no diff-check output.

- [ ] **Step 7: Run full focused and local final gates**

Run:

```bash
bun test tests/fork-agent-task-recovery-kiro-turn-termination.test.ts \
  tests/agent-task-recovery-routed-backend.test.ts \
  tests/fork-agent-task-recovery-backend.test.ts \
  tests/server-kiro-completion-e2e.test.ts \
  tests/fork-ci-official-baseline.test.ts \
  tests/fork-version-policy.test.ts \
  tests/release-version-line.test.ts \
  tests/fork-maintenance-truth.test.ts \
  tests/ci-workflows.test.ts
bun run typecheck
bun run privacy:scan
bun run prepush
git diff --check v2.35.0...HEAD
```

Expected: every command exit 0. Run `prepush` as a background session and follow it to terminal; do not infer completion from a disappearing session.

- [ ] **Step 8: Run final implementation re-reviews before docs commit**

Resume the original rebase reviewers with unchanged modes:

- `SPEC_COMPLIANCE`, `REVIEW_PHASE: RE_REVIEW`;
- `CODE_QUALITY`, `REVIEW_PHASE: RE_REVIEW`, including workflow security named-risk check.

Provide all original Important/Minor findings, `98b14f722..HEAD` fix diff including the uncommitted
`FORK_CHANGES.md`, Task reports, RED/GREEN evidence, full local gates and exact expected path
inventory. Classify each blocking re-review finding before changing files:

- code/test/workflow/package findings require a new implementation commit, then recapture
  `IMPLEMENTATION_HEAD`, regenerate the still-uncommitted `FORK_CHANGES.md`, rerun Steps 6–8, and
  reuse the same reviewer threads;
- a finding confined to the still-uncommitted `FORK_CHANGES.md` is fixed directly in that document,
  keeps `IMPLEMENTATION_HEAD` unchanged, reruns the maintenance-truth test plus applicable local
  gates, and returns to the same reviewers.

Never create an implementation commit containing only the final truth document; Step 9 remains
its sole commit boundary.

- [ ] **Step 9: Commit only the final maintenance truth**

After both re-reviews pass:

```bash
git add FORK_CHANGES.md
test "$(git diff --cached --name-only)" = "FORK_CHANGES.md"
git diff --cached --check
git commit -m "docs: 记录 v2.35.0-ben.2 修复与发布边界"
test "$(git rev-parse HEAD^)" = "$IMPLEMENTATION_HEAD"
test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = "FORK_CHANGES.md"
git diff --check HEAD^ HEAD
```

Expected: final candidate commit is green, docs-only, and its parent is the captured implementation head.

- [ ] **Step 10: Verify exact official-relative path inventory**

Run this exact Node ESM set comparison. It derives the approved old set from immutable ben.1,
requires all 105 paths to remain, then proves the current 112-path set adds only the seven paths
listed by the Spec:

```text
.github/workflows/ci.yml
docs/superpowers/specs/2026-08-29-v2350-ben2-rebase-repair-design.md
docs/superpowers/plans/2026-08-29-v2350-ben2-rebase-repair.md
scripts/prepare-fork-official-base.ts
tests/fork-agent-task-recovery-kiro-turn-termination.test.ts
tests/fork-ci-official-baseline.test.ts
tests/fork-maintenance-truth.test.ts
```

```bash
node --input-type=module -e '
import { execFileSync } from "node:child_process";
const paths = ref => execFileSync("git", ["diff", "--name-only", `v2.35.0...${ref}`], {
  encoding: "utf8",
}).trim().split("\n").filter(Boolean).sort();
const oldPaths = paths("98b14f722097abce9107c76ff0eba5f4e60c2e0f");
const newPaths = paths("HEAD");
const oldSet = new Set(oldPaths);
const added = newPaths.filter(path => !oldSet.has(path)).sort();
const expectedAdded = [
  ".github/workflows/ci.yml",
  "docs/superpowers/specs/2026-08-29-v2350-ben2-rebase-repair-design.md",
  "docs/superpowers/plans/2026-08-29-v2350-ben2-rebase-repair.md",
  "scripts/prepare-fork-official-base.ts",
  "tests/fork-agent-task-recovery-kiro-turn-termination.test.ts",
  "tests/fork-ci-official-baseline.test.ts",
  "tests/fork-maintenance-truth.test.ts",
].sort();
if (oldPaths.length !== 105) throw new Error(`old path count ${oldPaths.length} != 105`);
if (newPaths.length !== 112) throw new Error(`new path count ${newPaths.length} != 112`);
for (const path of oldPaths) {
  if (!newPaths.includes(path)) throw new Error(`old Fork path disappeared: ${path}`);
}
if (JSON.stringify(added) !== JSON.stringify(expectedAdded)) {
  throw new Error(`unexpected added paths: ${JSON.stringify(added)}`);
}
console.log(JSON.stringify({ oldCount: oldPaths.length, newCount: newPaths.length, added }, null, 2));
'
```

Any mismatch reopens Spec review and blocks remote candidate push.

---

### Task 6: Push and Verify the Exact Sync Candidate

**Files:**
- Create temporarily (gitignored): `.tmp/v2.35.0-ben.2-ci-controller.mjs`
- Create/update temporarily (gitignored, mode `0600`): `.tmp/v2.35.0-ben.2-state.json`
- No tracked files; main-controller Git/GitHub operations only.

**Interfaces:**
- Consumes: final docs-only candidate commit, clean worktree, approved re-reviews, all local gates.
- Produces: durable candidate/ref/run evidence, remote `sync/v2.35.0` at exact candidate SHA, and
  a successful uniquely bound workflow_dispatch Cross-platform run.

- [ ] **Step 1: Create and self-test the untracked CI controller**

Create `.tmp/v2.35.0-ben.2-ci-controller.mjs` with `apply_patch`, then `chmod 700`. It is an
operational verifier, not a tracked product path. The implementation must contain these exact
contracts:

```js
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPOSITORY = "Trendymen/opencodex";
const WORKFLOW = "ci.yml";
const STATE_PATH = ".tmp/v2.35.0-ben.2-state.json";
const RUN_FIELDS = "attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,status,url,workflowDatabaseId,workflowName";
const VIEW_FIELDS = `${RUN_FIELDS},jobs`;
const SKIPPED_WINDOWS = "windows ${{ matrix.shard }}/4";
const WINDOWS_SHARD = /^windows [1-4]\/4$/;
const REQUIRED_SUCCESS = [
  "changes",
  "select windows runner",
  "test 1/4", "test 2/4", "test 3/4", "test 4/4",
  "storage policy", "api usage", "gates", "macos",
  "keyring ubuntu", "keyring windows", "keyring macos",
  "npm-global ubuntu-latest", "npm-global windows-latest", "npm-global macos-latest",
  "ci",
].sort();
const EXPECTED_NAMES = [...REQUIRED_SUCCESS, SKIPPED_WINDOWS].sort();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function ghJson(args, operation) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${operation} failed`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${operation} returned invalid JSON`); }
}

function loadState() {
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  invariant(state.version === 1, "unsupported state version");
  invariant(state.repository === REPOSITORY && state.workflow === WORKFLOW, "state identity mismatch");
  return state;
}

function saveState(state) {
  const next = `${STATE_PATH}.next`;
  writeFileSync(next, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, STATE_PATH);
  chmodSync(STATE_PATH, 0o600);
}

function listRuns() {
  const runs = ghJson([
    "run", "list", "--repo", REPOSITORY, "--workflow", WORKFLOW,
    "--limit", "100", "--json", RUN_FIELDS,
  ], "list Cross-platform runs");
  invariant(Array.isArray(runs), "run list is not an array");
  return runs;
}

function verifyJobs(jobs) {
  invariant(Array.isArray(jobs), "jobs are missing");
  const names = jobs.map(job => job.name).sort();
  invariant(new Set(names).size === names.length, "duplicate job name");
  invariant(JSON.stringify(names) === JSON.stringify(EXPECTED_NAMES), "job name/cardinality mismatch");
  invariant(jobs.every(job => Number.isInteger(job.databaseId) && job.databaseId > 0), "invalid job id");
  for (const name of REQUIRED_SUCCESS) {
    const job = jobs.find(item => item.name === name);
    invariant(job?.status === "completed" && job?.conclusion === "success", `${name} did not succeed`);
  }
  const skipped = jobs.find(job => job.name === SKIPPED_WINDOWS);
  invariant(skipped?.status === "completed" && skipped?.conclusion === "skipped", "platform-windows was not skipped");
  invariant(Array.isArray(skipped?.steps) && skipped.steps.length === 0, "skipped Windows job executed steps");
  invariant(jobs.filter(job => WINDOWS_SHARD.test(job.name)).length === 0, "Windows suite shards expanded");
  invariant(jobs.filter(job => job.conclusion === "skipped").length === 1, "unexpected skipped job");
}

function verifyRunPayload(payload, expected) {
  invariant(payload.databaseId === expected.databaseId, "run id mismatch");
  invariant(payload.attempt === expected.attempt, "run attempt mismatch");
  invariant(payload.workflowDatabaseId === expected.workflowDatabaseId, "workflow id mismatch");
  invariant(payload.workflowName === "Cross-platform CI", "workflow name mismatch");
  invariant(payload.event === expected.event && payload.headBranch === expected.branch, "run event/branch mismatch");
  invariant(payload.headSha === expected.sha, "run sha mismatch");
  invariant(payload.status === "completed" && payload.conclusion === "success", "run did not succeed");
  verifyJobs(payload.jobs);
}

function terminalFailureEvidence(payload, expected) {
  invariant(payload.databaseId === expected.databaseId, "failed run id mismatch");
  invariant(payload.attempt === expected.attempt, "failed run attempt mismatch");
  invariant(payload.workflowDatabaseId === expected.workflowDatabaseId, "failed workflow id mismatch");
  invariant(payload.workflowName === "Cross-platform CI", "failed workflow name mismatch");
  invariant(payload.event === expected.event && payload.headBranch === expected.branch, "failed run route mismatch");
  invariant(payload.headSha === expected.sha, "failed run sha mismatch");
  invariant(payload.status === "completed" && payload.conclusion, "run failure is not terminal");
  let strictPassed = false;
  try {
    verifyRunPayload(payload, expected);
    strictPassed = true;
  } catch {
    // The safe closed kind below records only that the same strict verifier rejected the payload.
  }
  invariant(!strictPassed, "run satisfies the strict release contract");
  return {
    kind: payload.conclusion === "success"
      ? "release_job_contract_failure"
      : "run_conclusion_failure",
    payload,
  };
}

const SHA = /^[0-9a-f]{40}$/;
const BEN1 = "98b14f722097abce9107c76ff0eba5f4e60c2e0f";
const OFFICIAL = "fc4de772b58c13f7b16b5029b1e981d612a5db06";
const SLOT_IDENTITY = {
  candidate: { event: "workflow_dispatch", branch: "sync/v2.35.0" },
  final: { event: "push", branch: "main" },
};

function exactArgs(args, count) {
  invariant(args.length === count, "invalid argument count");
}

function slotIdentity(slot, event, branch, sha) {
  invariant(slot === "candidate" || slot === "final", "invalid slot");
  invariant(SHA.test(sha), "invalid sha");
  const identity = SLOT_IDENTITY[slot];
  invariant(event === identity.event && branch === identity.branch, "invalid slot identity");
  return { event, branch, sha };
}

function buildInitialState(args) {
  exactArgs(args, 6);
  invariant(args.every(value => SHA.test(value)), "invalid state oid");
  const [candidateSha, localMain, remoteMain, remoteSync, localMarker, remoteMarker] = args;
  invariant(localMain === BEN1 && remoteMain === BEN1, "main pre-state mismatch");
  invariant(localMarker === OFFICIAL && remoteMarker === OFFICIAL, "marker pre-state mismatch");
  invariant(remoteSync === BEN1, "new state requires ben.1 remote sync");
  return {
    version: 1,
    repository: REPOSITORY,
    workflow: WORKFLOW,
    officialBase: OFFICIAL,
    candidateSha,
    pre: {
      localMain, remoteMain, remoteSync, localMarker, remoteMarker,
      ben2TagAbsent: true,
      originOfficialTagAbsent: true,
    },
    runs: {},
    history: [],
  };
}

function initState(args) {
  try {
    const current = loadState();
    exactArgs(args, 6);
    invariant(args.every(value => SHA.test(value)), "invalid state oid");
    const [candidateSha, localMain, remoteMain, remoteSync, localMarker, remoteMarker] = args;
    invariant(current.candidateSha === candidateSha, "candidate state mismatch");
    invariant(current.pre.localMain === localMain && current.pre.remoteMain === remoteMain, "main state mismatch");
    invariant(current.pre.localMarker === localMarker && current.pre.remoteMarker === remoteMarker, "marker state mismatch");
    invariant(remoteSync === current.pre.remoteSync || remoteSync === candidateSha, "sync re-entry state mismatch");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    saveState(buildInitialState(args));
  }
}

function snapshot(args) {
  exactArgs(args, 4);
  const [slot, event, branch, sha] = args;
  const expected = slotIdentity(slot, event, branch, sha);
  const state = loadState();
  invariant(sha === state.candidateSha, "snapshot candidate mismatch");
  const existing = state.runs[slot];
  if (existing) {
    invariant(JSON.stringify(existing.expected) === JSON.stringify(expected), "snapshot identity changed");
    return;
  }
  const runs = listRuns();
  const workflowIds = [...new Set(runs.map(run => run.workflowDatabaseId))];
  invariant(workflowIds.length === 1 && Number.isInteger(workflowIds[0]) && workflowIds[0] > 0, "workflow id is ambiguous");
  invariant(runs.every(run => Number.isInteger(run.databaseId) && run.databaseId > 0), "invalid pre-run id");
  const boundaryMs = Date.now();
  state.runs[slot] = {
    expected,
    workflowDatabaseId: workflowIds[0],
    beforeIds: runs.map(run => run.databaseId).sort((a, b) => a - b),
    boundaryMs,
    notBeforeMs: Math.ceil((boundaryMs + 1) / 1000) * 1000 + 100,
  };
  saveState(state);
}

async function intent(args) {
  exactArgs(args, 1);
  const [slot] = args;
  invariant(slot === "candidate" || slot === "final", "invalid slot");
  const state = loadState();
  const run = state.runs[slot];
  invariant(run, "slot snapshot missing");
  if (run.intentAtMs !== undefined) return;
  const waitMs = Math.max(0, run.notBeforeMs - Date.now());
  invariant(waitMs <= 1_200, "invalid intent wait");
  if (waitMs > 0) await Bun.sleep(waitMs);
  run.intentAtMs = Date.now();
  saveState(state);
}

async function bind(args) {
  exactArgs(args, 1);
  const [slot] = args;
  invariant(slot === "candidate" || slot === "final", "invalid slot");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = loadState();
    const target = state.runs[slot];
    invariant(target?.intentAtMs, "slot intent missing");
    if (target.run) return;
    const before = new Set(target.beforeIds);
    const matches = listRuns().filter(run =>
      !before.has(run.databaseId)
      && run.workflowDatabaseId === target.workflowDatabaseId
      && run.workflowName === "Cross-platform CI"
      && run.event === target.expected.event
      && run.headBranch === target.expected.branch
      && run.headSha === target.expected.sha
      && Date.parse(run.createdAt) > target.boundaryMs
    );
    invariant(matches.length <= 1, "ambiguous new run");
    if (matches.length === 1) {
      const run = matches[0];
      invariant(Number.isInteger(run.attempt) && run.attempt >= 1, "invalid run attempt");
      if (slot === "final") {
        invariant(run.databaseId !== state.runs.candidate?.run?.databaseId, "final reused candidate run");
      }
      target.run = {
        databaseId: run.databaseId,
        attempt: run.attempt,
        workflowDatabaseId: run.workflowDatabaseId,
        event: run.event,
        branch: run.headBranch,
        sha: run.headSha,
        createdAt: run.createdAt,
        url: run.url,
      };
      saveState(state);
      return;
    }
    await Bun.sleep(2_000);
  }
  throw new Error("exact run did not appear before timeout");
}

function currentRun(id, attempt) {
  const args = ["run", "view", String(id), "--repo", REPOSITORY, "--json", VIEW_FIELDS];
  if (attempt !== undefined) args.splice(3, 0, "--attempt", String(attempt));
  return ghJson(args, "view Cross-platform run");
}

function adoptRerun(args) {
  exactArgs(args, 1);
  const [slot] = args;
  invariant(slot === "candidate" || slot === "final", "invalid slot");
  const state = loadState();
  const target = state.runs[slot];
  invariant(target?.run, "bound run missing");
  const payload = currentRun(target.run.databaseId);
  invariant(payload.databaseId === target.run.databaseId, "rerun id changed");
  invariant(payload.attempt === target.run.attempt + 1, "rerun attempt did not increment once");
  invariant(payload.event === target.expected.event && payload.headBranch === target.expected.branch, "rerun identity changed");
  invariant(payload.headSha === target.expected.sha, "rerun sha changed");
  target.run.attempt = payload.attempt;
  delete target.evidence;
  delete target.verifiedAt;
  saveState(state);
}

function verify(args) {
  exactArgs(args, 1);
  const [slot] = args;
  invariant(slot === "candidate" || slot === "final", "invalid slot");
  const state = loadState();
  const target = state.runs[slot];
  invariant(target?.run, "bound run missing");
  const payload = currentRun(target.run.databaseId, target.run.attempt);
  verifyRunPayload(payload, target.run);
  target.evidence = payload;
  target.verifiedAt = new Date().toISOString();
  saveState(state);
}

function gitResult(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function exactRemoteOid(ref) {
  const result = gitResult(["ls-remote", "origin", ref]);
  invariant(result.status === 0, "read remote ref failed");
  const rows = result.stdout.trim().split("\n").filter(Boolean);
  invariant(rows.length === 1, "remote ref is missing or ambiguous");
  const [oid, name] = rows[0].split("\t");
  invariant(SHA.test(oid) && name === ref, "remote ref response is invalid");
  return oid;
}

function recordFailure(args) {
  exactArgs(args, 1);
  const [slot] = args;
  invariant(slot === "candidate", "only candidate failure can be recorded");
  const state = loadState();
  const target = state.runs.candidate;
  invariant(target?.run && !target.verifiedAt, "candidate is not a failed unverified run");
  const payload = currentRun(target.run.databaseId, target.run.attempt);
  target.failureEvidence = terminalFailureEvidence(payload, target.run);
  target.failedAt = new Date().toISOString();
  saveState(state);
}

function applySupersession(state, oldSha, newSha, proof) {
  invariant(SHA.test(oldSha) && SHA.test(newSha) && oldSha !== newSha, "invalid successor oids");
  invariant(state.candidateSha === oldSha, "superseded candidate mismatch");
  invariant(state.runs.candidate?.failureEvidence, "failed candidate evidence missing");
  invariant(!state.tag && !state.promotion && !state.release, "immutable release phase already started");
  invariant(proof.remoteSync === oldSha, "successor lease is not failed candidate");
  invariant(proof.isAncestor === true, "new candidate is not a descendant");
  invariant(proof.ben2TagAbsent === true && proof.originOfficialTagAbsent === true, "tag absence proof missing");
  state.history.push({
    candidateSha: oldSha,
    runs: state.runs,
    failedAt: state.runs.candidate.failedAt,
    supersededAt: new Date().toISOString(),
  });
  state.pre.remoteSync = oldSha;
  state.candidateSha = newSha;
  state.runs = {};
  return state;
}

function supersedeCandidate(args) {
  exactArgs(args, 2);
  const [oldSha, newSha] = args;
  const state = loadState();
  const head = gitResult(["rev-parse", "HEAD"]);
  const localSync = gitResult(["rev-parse", "refs/heads/sync/v2.35.0"]);
  invariant(head.status === 0 && head.stdout.trim() === newSha, "HEAD is not successor");
  invariant(localSync.status === 0 && localSync.stdout.trim() === newSha, "local sync is not successor");
  const ancestry = gitResult(["merge-base", "--is-ancestor", oldSha, newSha]);
  const localBen2 = gitResult(["show-ref", "--verify", "--quiet", "refs/tags/v2.35.0-ben.2"]);
  const remoteBen2 = gitResult(["ls-remote", "origin", "refs/tags/v2.35.0-ben.2", "refs/tags/v2.35.0-ben.2^{}"]);
  const remoteOfficial = gitResult(["ls-remote", "origin", "refs/tags/v2.35.0", "refs/tags/v2.35.0^{}"]);
  invariant(remoteBen2.status === 0 && remoteBen2.stdout.trim() === "" && localBen2.status === 1, "ben.2 tag already exists or could not be classified");
  invariant(remoteOfficial.status === 0 && remoteOfficial.stdout.trim() === "", "official tag is mirrored");
  const next = applySupersession(state, oldSha, newSha, {
    remoteSync: exactRemoteOid("refs/heads/sync/v2.35.0"),
    isAncestor: ancestry.status === 0,
    ben2TagAbsent: true,
    originOfficialTagAbsent: true,
  });
  saveState(next);
}

function selfTest() {
  const mustReject = action => {
    let rejected = false;
    try { action(); } catch { rejected = true; }
    invariant(rejected, "negative controller fixture passed");
  };
  const firstCandidate = "c".repeat(40);
  const successorCandidate = "d".repeat(40);
  const initial = buildInitialState([
    firstCandidate, BEN1, BEN1, BEN1, OFFICIAL, OFFICIAL,
  ]);
  invariant(initial.candidateSha === firstCandidate && initial.pre.remoteSync === BEN1, "initial transition failed");
  mustReject(() => buildInitialState([
    firstCandidate, BEN1, BEN1, "e".repeat(40), OFFICIAL, OFFICIAL,
  ]));
  initial.runs.candidate = {
    failedAt: new Date().toISOString(),
    failureEvidence: { kind: "run_conclusion_failure", payload: { conclusion: "failure" } },
  };
  const successor = applySupersession(structuredClone(initial), firstCandidate, successorCandidate, {
    remoteSync: firstCandidate,
    isAncestor: true,
    ben2TagAbsent: true,
    originOfficialTagAbsent: true,
  });
  invariant(successor.candidateSha === successorCandidate, "successor transition failed");
  invariant(successor.pre.remoteSync === firstCandidate && successor.history.length === 1, "successor history failed");
  invariant(Object.keys(successor.runs).length === 0, "successor run reset failed");
  mustReject(() => applySupersession(structuredClone(initial), firstCandidate, successorCandidate, {
    remoteSync: BEN1,
    isAncestor: true,
    ben2TagAbsent: true,
    originOfficialTagAbsent: true,
  }));

  const jobs = EXPECTED_NAMES.map((name, index) => ({
    databaseId: index + 1,
    name,
    status: "completed",
    conclusion: name === SKIPPED_WINDOWS ? "skipped" : "success",
    steps: [],
  }));
  const expected = {
    databaseId: 101, attempt: 1, workflowDatabaseId: 202,
    event: "workflow_dispatch", branch: "sync/v2.35.0", sha: "a".repeat(40),
  };
  const good = {
    ...expected,
    headBranch: expected.branch,
    headSha: expected.sha,
    workflowName: "Cross-platform CI",
    status: "completed",
    conclusion: "success",
    jobs,
  };
  verifyRunPayload(good, expected);
  mustReject(() => terminalFailureEvidence(structuredClone(good), expected));
  const topLevelFailure = structuredClone(good);
  topLevelFailure.conclusion = "failure";
  invariant(
    terminalFailureEvidence(topLevelFailure, expected).kind === "run_conclusion_failure",
    "top-level failure classification failed",
  );
  const skippedHostedWindows = structuredClone(good);
  skippedHostedWindows.jobs.find(job => job.name === "npm-global windows-latest").conclusion = "skipped";
  invariant(
    terminalFailureEvidence(skippedHostedWindows, expected).kind === "release_job_contract_failure",
    "hosted Windows skip classification failed",
  );
  const missingChanges = structuredClone(good);
  missingChanges.jobs = missingChanges.jobs.filter(job => job.name !== "changes");
  invariant(
    terminalFailureEvidence(missingChanges, expected).kind === "release_job_contract_failure",
    "missing required job classification failed",
  );
  const extraJob = structuredClone(good);
  extraJob.jobs.push({ databaseId: 999, name: "extra", status: "completed", conclusion: "success", steps: [] });
  invariant(
    terminalFailureEvidence(extraJob, expected).kind === "release_job_contract_failure",
    "extra job classification failed",
  );
  const rejects = [
    value => { value.jobs = value.jobs.filter(job => job.name !== "changes"); },
    value => { value.jobs = value.jobs.filter(job => job.name !== "select windows runner"); },
    value => { value.jobs.push({ ...value.jobs[0], databaseId: 999 }); },
    value => { value.jobs.find(job => job.name === "npm-global windows-latest").conclusion = "skipped"; },
    value => { value.jobs.find(job => job.name === SKIPPED_WINDOWS).name = "windows 1/4"; },
    value => { value.jobs = value.jobs.filter(job => job.name !== "ci"); },
    value => { value.jobs.push({ databaseId: 999, name: "extra", status: "completed", conclusion: "success", steps: [] }); },
    value => { value.jobs.find(job => job.name === "macos").conclusion = "failure"; },
    value => { value.jobs.find(job => job.name === "gates").conclusion = "neutral"; },
    value => { value.jobs.find(job => job.name === "api usage").conclusion = "skipped"; },
  ];
  for (const mutate of rejects) {
    const bad = structuredClone(good);
    mutate(bad);
    mustReject(() => verifyRunPayload(bad, expected));
  }
  console.log("controller self-test passed");
}

const [command, ...args] = Bun.argv.slice(2);
try {
  switch (command) {
    case "init-state": initState(args); break;
    case "snapshot": snapshot(args); break;
    case "intent": await intent(args); break;
    case "bind": await bind(args); break;
    case "adopt-rerun": adoptRerun(args); break;
    case "verify": verify(args); break;
    case "record-failure": recordFailure(args); break;
    case "supersede-candidate": supersedeCandidate(args); break;
    case "self-test": exactArgs(args, 0); selfTest(); break;
    default: throw new Error("unknown controller command");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "controller command failed";
  console.error(`controller: ${message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 300)}`);
  process.exitCode = 1;
}
```

The script commands are exact:

- `init-state CANDIDATE LOCAL_MAIN REMOTE_MAIN REMOTE_SYNC LOCAL_MARKER REMOTE_MARKER`: require six
  lowercase 40-hex OIDs; require both main values equal immutable
  ben.1 and both marker values equal immutable official v2.35. A new state additionally requires
  remote sync=ben.1, then creates the state atomically with
  version/repository/workflow/officialBase/candidateSha, a `pre` object holding those refs plus
  `ben2TagAbsent=true` and `originOfficialTagAbsent=true`, and `runs={}`. If state already exists,
  require every immutable value to match, allow fresh remote sync only as stored pre-value or exact
  candidate, and perform no write.
- `snapshot SLOT EVENT BRANCH SHA` (`SLOT` is exactly `candidate` or `final`): call `listRuns()`, require exactly one
  positive `workflowDatabaseId` across returned rows, and atomically store the expected identity,
  every current `databaseId`, `boundaryMs=Date.now()`, and
  `notBeforeMs=Math.ceil((boundaryMs + 1) / 1000) * 1000 + 100`. Re-entry with the same slot and
  identity is a no-op; a different identity fails.
- `intent SLOT`: wait only until `notBeforeMs` (at most about 1.1 seconds), then atomically store
  `intentAtMs=Date.now()` before the dispatch or atomic push. Re-entry preserves the first value.
- `bind SLOT`: for at most 120 seconds, poll `listRuns()` every 2 seconds. Candidates must have an
  ID absent from the snapshot, the same workflow ID, exact event/branch/SHA, and
  `Date.parse(createdAt) > boundaryMs`. More than one match fails immediately; exactly one stores
  databaseId, attempt, URL, createdAt and workflow ID. `final` must additionally differ from the
  stored candidate databaseId. Run this as a yielded exec session and report progress before 60
  seconds; never hide a long blocking wait.
- `adopt-rerun SLOT`: after a deliberate transient-only `gh run rerun`, query the same run ID
  without `--attempt`, require exact metadata and `attempt === previousAttempt + 1`, then atomically
  replace only the stored attempt.
- `verify SLOT`: call `gh run view RUN_ID --attempt ATTEMPT --repo Trendymen/opencodex --json
  VIEW_FIELDS`, run `verifyRunPayload()`, then store the complete run/jobs JSON plus
  `verifiedAt`. Candidate and final therefore use identical allowlist logic.
- `record-failure candidate`: fetch the bound exact attempt; independently require exact databaseId,
  attempt, workflow ID/name, event, branch, SHA and `status=completed`. Run the same
  `verifyRunPayload()` used by `verify candidate` and require it to reject. Persist only the
  complete payload plus closed kind `run_conclusion_failure` when the top-level conclusion is not
  success, or `release_job_contract_failure` when the top-level run says success but the exact
  job/cardinality/unique-Windows-skip contract fails; never persist arbitrary exception text. A
  payload that fully passes the strict verifier cannot be recorded as failure.
- `supersede-candidate OLD_SHA NEW_SHA`: require the persisted failed candidate is `OLD_SHA`, no
  Tag/promotion/Release phase has started, local HEAD+sync=`NEW_SHA`, remote sync=`OLD_SHA`, exact
  `merge-base --is-ancestor OLD_SHA NEW_SHA`, local/remote ben.2 absence and origin official Tag
  absence. Move the old candidate/runs into immutable `history`, set the next sync lease to
  `OLD_SHA`, replace candidateSha with `NEW_SHA`, and reset `runs={}` atomically.
- `self-test`: build one good payload with exactly the 18 names above and prove it passes; clone it
  into negative cases for missing `changes`, missing `select windows runner`, duplicate job,
  skipped `npm-global windows-latest`, expanded `windows 1/4`, missing aggregate `ci`, extra job,
  failed job, unknown conclusion and second skip. It also proves initial ben.1→candidate state
  creation, failed candidate→declared descendant transition/history/reset, and rejects both an
  arbitrary initial remote sync and a successor whose remote predecessor is not the failed
  candidate. Failure-recording fixtures require: full strict payload rejects failure recording;
  matching top-level failure records `run_conclusion_failure`; top-level success with skipped
  hosted Windows, missing `changes`, or an extra job records `release_job_contract_failure`.
  Require every negative case to throw.

Implement a closed `switch (Bun.argv[2])` for only
`init-state|snapshot|intent|bind|adopt-rerun|verify|record-failure|supersede-candidate|self-test`;
validate exact argument counts,
slot vocabulary, event/branch pairs (`candidate→workflow_dispatch/sync/v2.35.0`,
`final→push/main`) and lowercase 40-hex SHA before any file or `gh` action. Unknown commands,
extra arguments or invalid state fail nonzero with a fixed single-line diagnostic and no state
rewrite. No command accepts a repository, workflow, remote URL or path override.

The Task 3 tracked workflow test ties YAML job id `platform-windows` to the exact literal name
`windows ${{ matrix.shard }}/4`; observed GitHub Actions job-level skips retain that literal name
with zero steps, while expanded matrix jobs render `windows N/4`. The controller uses that combined
static/runtime evidence and never infers a skip from missing rows.

Run:

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs self-test
```

Expected: exit 0 and one fixed `controller self-test passed` line. No `gh` command runs in
self-test mode.

- [ ] **Step 2: Capture durable pre-state and validate every absence/lineage precondition**

Capture only full refs:

```bash
CANDIDATE=$(git rev-parse HEAD)
test "$CANDIDATE" = "$(git rev-parse refs/heads/sync/v2.35.0)"
LOCAL_MAIN_OLD=$(git rev-parse refs/heads/main)
LOCAL_MARKER_OLD=$(git rev-parse refs/heads/upstream-release)
REMOTE_MAIN_OLD=$(git ls-remote origin refs/heads/main | cut -f1)
REMOTE_SYNC_OLD=$(git ls-remote origin refs/heads/sync/v2.35.0 | cut -f1)
REMOTE_MARKER_OLD=$(git ls-remote origin refs/heads/upstream-release | cut -f1)
```

Require:

- clean worktree/index and no merge/rebase/cherry-pick/revert/bisect operation;
- local/remote main exactly `98b14f722097abce9107c76ff0eba5f4e60c2e0f`;
- local/remote marker exactly `fc4de772b58c13f7b16b5029b1e981d612a5db06`;
- when the state file is absent, remote sync is exactly immutable ben.1; with an existing validated
  state, remote sync is either its stored pre-push value or exact `CANDIDATE`;
- `git merge-base --is-ancestor "$REMOTE_SYNC_OLD" "$CANDIDATE"` exits 0;
- local and remote raw/peeled `v2.35.0-ben.2` are absent;
- `git ls-remote origin refs/tags/v2.35.0 refs/tags/v2.35.0^{}` is empty. Any nonempty
  official-Tag row stops for user intervention; never delete it.

Initialize the durable state only after all checks pass:

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs init-state \
  "$CANDIDATE" "$LOCAL_MAIN_OLD" "$REMOTE_MAIN_OLD" "$REMOTE_SYNC_OLD" \
  "$LOCAL_MARKER_OLD" "$REMOTE_MARKER_OLD"
chmod 600 .tmp/v2.35.0-ben.2-state.json
```

On re-entry, `init-state` validates the existing file and refuses to overwrite any immutable
field.

- [ ] **Step 3: Idempotently publish only the sync candidate**

Fresh-read remote sync/main/marker, ben.2 Tag and official Tag again. Accept only:

- remote sync equals the saved pre value: push under its exact lease;
- remote sync already equals candidate: no-op re-entry;
- anything else: stop.

For the pre-state case:

```bash
git push origin \
  --force-with-lease=refs/heads/sync/v2.35.0:$REMOTE_SYNC_OLD \
  "$CANDIDATE":refs/heads/sync/v2.35.0
```

Then fetch only `refs/heads/sync/v2.35.0:refs/remotes/origin/sync/v2.35.0` with `--no-tags` and
require the local tracking ref and fresh `ls-remote` equal candidate; main/marker remain pre-state;
local/remote ben.2 and origin official Tags remain absent.

- [ ] **Step 4: Snapshot, dispatch once, and bind candidate CI**

Run:

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs snapshot candidate workflow_dispatch sync/v2.35.0 "$CANDIDATE"
bun .tmp/v2.35.0-ben.2-ci-controller.mjs intent candidate
```

The second command commits durable dispatch intent before the write. If no intent existed, invoke
exactly once:

```bash
gh workflow run ci.yml --repo Trendymen/opencodex --ref sync/v2.35.0
```

Do not pass `run_windows=true` or any equivalent input. On a lost/uncertain dispatch response,
never immediately dispatch again: run `bind candidate` against the saved pre-ID set until it finds
one exact run or reaches its timeout. A timeout preserves state and stops; it does not broaden the
selector or risk a duplicate dispatch.

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs bind candidate
```

Zero after the bounded wait or more than one exact new match fails closed.

- [ ] **Step 5: Wait for and mechanically verify every candidate release job**

Read the validated run ID/attempt from the state file, then:

```bash
gh run watch "$CANDIDATE_RUN_ID" --repo Trendymen/opencodex --exit-status
bun .tmp/v2.35.0-ben.2-ci-controller.mjs verify candidate
```

The controller unconditionally requires `changes`, `select windows runner`, all four Linux shards,
storage/api/gates/macOS, all three keyring jobs, all three hosted npm-global jobs and aggregate
`ci` exactly once and successful. It requires exactly one skipped literal job-level Windows record,
zero expanded Windows suite shards, and no unknown/duplicate/additional job. `ci=success` is only
additional evidence, never a substitute for the explicit set.

- [ ] **Step 6: Handle candidate failure according to S1 state**

If a failure is classified with concrete evidence as runner/runtime transient, rerun the same run
ID, execute `adopt-rerun candidate`, watch that exact attempt and `verify candidate` again. If
code/policy/document fails—including a top-level successful run rejected by the strict external
job allowlist—first execute `record-failure candidate`; the command must re-run that same strict
verifier to form closed terminal evidence. Do not create Tag. Append
fixes as descendants, recreate the final truth snapshot, reviews and gates, then—with remote sync
still equal to the failed SHA—run:

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs supersede-candidate "$FAILED_CANDIDATE" "$NEW_CANDIDATE"
```

The command mechanically proves the descendant/lease/Tag preconditions, preserves the old state in
its immutable history, and resets only the next candidate run slots. Return to Step 3 and
fast-forward sync under the failed candidate SHA lease. Never delete/recreate state, accept an
arbitrary predecessor, or rewrite published failed-candidate history.

---

### Historical Task 7: Promote, Verify Final CI, and Publish v2.35.0-ben.2

> **Superseded:** 本节保留为原S1审计记录，不得执行。当前发布只执行文首S2R-5/S2R-6；
> 尤其不得再应用本节的origin official Tag absence/no-mirror条件。

**Files:**
- Reuse: `.tmp/v2.35.0-ben.2-ci-controller.mjs`
- Reuse/update: `.tmp/v2.35.0-ben.2-state.json`
- Create temporarily: `.tmp/v2.35.0-ben.2-release-notes.md`
- No tracked files; main-controller Git/GitHub operations only.

**Interfaces:**
- Consumes: successful Task 6 candidate run, frozen candidate SHA, captured refs.
- Produces: immutable annotated Tag, atomically aligned remote/local refs, successful main-push CI, public verified GitHub Release.

- [ ] **Step 1: Enter through a fresh-read, recoverable state audit**

At every Task 7 entry—initial or resumed—load the mode-0600 state, require candidate CI has a
stored complete `verifiedAt` payload, and fresh-read these exact refs:

```bash
git rev-parse HEAD refs/heads/sync/v2.35.0 refs/heads/main refs/heads/upstream-release
git rev-parse refs/remotes/origin/sync/v2.35.0 refs/remotes/origin/main refs/remotes/origin/upstream-release
git ls-remote origin refs/heads/main refs/heads/sync/v2.35.0 refs/heads/upstream-release
git ls-remote origin refs/tags/v2.35.0-ben.2 'refs/tags/v2.35.0-ben.2^{}'
git ls-remote origin refs/tags/v2.35.0 'refs/tags/v2.35.0^{}'
```

Require HEAD/local sync/candidate all equal; marker always equals official v2.35; origin official
Tag query is empty; and local/remote refs fit one of the complete states defined below. Any mixed
state, missing state evidence, unrelated dirty path, or nonempty official Tag query stops without
deleting/moving anything. This audit happens before each later external write, not just once.
Every shell block that uses `CANDIDATE`, run IDs/URLs, old refs or Tag OIDs must load them afresh
from the validated state at the beginning of that same exec invocation and reject non-hex/non-numeric/
non-HTTPS values; no block relies on variables surviving a prior shell session.

- [ ] **Step 2: Create or recover the frozen local annotated Tag**

Tag message must include official base, the failed d555/run evidence and lightweight correction,
replacement candidate commit/run, local/review gates and known gaps; explicitly mark promotion,
final CI and Release pending. Use quoted `-m` arguments so no scratch Tag-message file or
shell-generated file is needed.

Classify the local Tag first:

- absent + state has no Tag record + remote complete pre-state: create it once with the command
  below;
- present: require object type `tag`, peeled commit=candidate, and annotation text equals the exact
  three paragraphs produced by the command below (allow only Git's one trailing newline),
  including official base, failed candidate/run/lightweight correction, replacement candidate SHA,
  stored replacement run ID/URL and pending promotion/final/Release statements. If state already
  records `rawOid`, require exact equality; if state lacks a
  Tag record because the previous process exited after creation, adopt this validated raw OID into
  state without recreating the Tag;
- any lightweight Tag, wrong peeled commit/message/raw OID, or local Tag existing before the
  persisted candidate-green state: stop.

```bash
git tag -a v2.35.0-ben.2 "$CANDIDATE" \
  -m "Trendymen Fork v2.35.0-ben.2（官方基线 v2.35.0 / fc4de772）" \
  -m "Previous candidate d5558096bb229b5fbf5607a6468c2871b2b1213e / workflow_dispatch run 33234936660 在 Tag、promotion、final CI、Release 之前失败：官方 v2.35.0 被验证为 lightweight commit ref（type=commit，raw=peeled=marker fc4de772b58c13f7b16b5029b1e981d612a5db06）。本 successor 同时接受经完整 ancestry、marker、import equality 与 CAS 验证的 lightweight/annotated official refs。" \
  -m "Replacement candidate: $CANDIDATE；Cross-platform workflow_dispatch run $CANDIDATE_RUN_ID：$CANDIDATE_RUN_URL。Local gates 与双 reviewer re-review 已通过。Promotion、final main CI、GitHub Release：pending。已知缺口以 tagged FORK_CHANGES.md 为准。"
test "$(git cat-file -t refs/tags/v2.35.0-ben.2)" = "tag"
test "$(git rev-parse refs/tags/v2.35.0-ben.2^{commit})" = "$CANDIDATE"
TAG_RAW=$(git rev-parse refs/tags/v2.35.0-ben.2)
```

After validating/creating, use `apply_patch` to add an exact `tag` object to the state containing
name, rawOid, peeledCommit, failedCandidate=`d555...`, failedRunId=`33234936660`,
officialRefKind=`lightweight`, replacement candidate run ID and `recordedAt`; `chmod 600` again.
Re-entry compares
and reuses it. After this point do not change code/docs or recreate/move the Tag.

- [ ] **Step 3: Snapshot final-run identity and classify/push the atomic promotion**

Before any possible atomic push, require origin official Tag absent again and run:

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs snapshot final push main "$CANDIDATE"
bun .tmp/v2.35.0-ben.2-ci-controller.mjs intent final
```

The durable final snapshot/pre-run ID set and high-resolution boundary must reach disk before the
push. Fresh-read remote main/sync/marker and ben.2 raw+peeled, then accept only:

- complete pre-state: main=immutable ben.1, sync=candidate, marker=official, remote ben.2 absent;
- complete post-state: main/sync=candidate, marker=official, remote ben.2 raw=`TAG_RAW` and
  peeled=candidate.

Complete post-state is a no-op re-entry and skips the push. Only complete pre-state executes:

```bash
git push --atomic origin \
  --force-with-lease=refs/heads/main:$REMOTE_MAIN_OLD \
  --force-with-lease=refs/heads/sync/v2.35.0:$CANDIDATE \
  --force-with-lease=refs/heads/upstream-release:$REMOTE_MARKER_OLD \
  "$CANDIDATE":refs/heads/main \
  "$CANDIDATE":refs/heads/sync/v2.35.0 \
  "$REMOTE_MARKER_OLD":refs/heads/upstream-release \
  refs/tags/v2.35.0-ben.2:refs/tags/v2.35.0-ben.2
```

No `+` or force/lease applies to the Tag refspec.

- [ ] **Step 4: Reconcile remote result and idempotently align local refs**

Record the push command's exit/result class without raw stderr, then fresh-read remote
main/sync/marker/Tag raw+peeled plus origin official Tag. The local result and remote state form this
strict table:

- **Reported success (exit 0):** only complete post-state is accepted. Complete pre-state or mixed
  state contradicts the success response and stops; it is not auto-retried.
- **Determinate rejection/failure:** atomic unsupported, lease/non-fast-forward rejection, remote
  Tag conflict, auth/permission failure, or any server response explicitly rejecting the update
  stops even when fresh remote is complete pre-state. Complete post/mixed state after a claimed
  rejection also stops as contradictory; no automatic continuation or retry.
- **Result genuinely uncertain:** only a tool/session timeout, connection loss after sending the
  request, or missing terminal client result qualifies. Fresh complete post-state is accepted
  without another push; mixed state stops; complete pre-state permits exactly one retry of the
  identical atomic refset with the same frozen `TAG_RAW` and fresh leases. A second uncertain result
  or any determinate result from that retry stops.

Persist the classification category, timestamp and fixed non-secret reason in the mode-0600 state
before retry/continuation. Never classify a normal nonzero Git exit with a remote rejection message
as “uncertain.” A mirrored official Tag always stops. No path splits the atomic refset or deletes/
recreates the Tag.

After complete remote post-state, classify local branch refs:

- local main=ben.1, sync=candidate, marker=official: execute the CAS transaction below;
- local main/sync=candidate, marker=official: already-post no-op;
- any other combination: stop.

CAS transaction for the all-old local state:

```bash
printf 'start\nupdate refs/heads/main %s %s\nupdate refs/heads/upstream-release %s %s\nprepare\ncommit\n' \
  "$CANDIDATE" "$LOCAL_MAIN_OLD" "$REMOTE_MARKER_OLD" "$LOCAL_MARKER_OLD" \
  | git update-ref --stdin
```

The checked-out sync branch already equals candidate and is not moved by the transaction.
Refresh only the three branch-tracking refs without Tags, then require all six local/tracking refs
to equal their already verified remote values:

```bash
git fetch --no-tags origin \
  refs/heads/main:refs/remotes/origin/main \
  refs/heads/sync/v2.35.0:refs/remotes/origin/sync/v2.35.0 \
  refs/heads/upstream-release:refs/remotes/origin/upstream-release
```

Do not fetch or create an origin copy of official `v2.35.0`.

Fresh-read all local/tracking/remote refs once more, then use `apply_patch` to add a `promotion`
state object containing the preserved boundary, exact complete remote post-state, local post-state,
raw/peeled Tag OIDs and `verifiedAt`; mode remains `0600`. If this state object already exists,
require exact equality and do not rewrite it.

- [ ] **Step 5: Bind and wait for final main-push CI**

Run `bind final`; it requires the unique new `event=push`, `headBranch=main`, exact candidate SHA,
workflow ID and created-after-boundary run, and forbids reuse of the candidate databaseId:

```bash
bun .tmp/v2.35.0-ben.2-ci-controller.mjs bind final
gh run watch "$FINAL_RUN_ID" --repo Trendymen/opencodex --exit-status
bun .tmp/v2.35.0-ben.2-ci-controller.mjs verify final
```

The same controller enforces exact job names/cardinalities: `changes`, `select windows runner`,
Linux 1–4/4, storage/api/gates/macOS, keyring ubuntu/windows/macOS, hosted npm-global
ubuntu/windows/macOS and aggregate `ci` all success; the literal unexpanded Windows job is the
only skip and has zero steps/shards. A classified transient may rerun the same run ID followed by
`adopt-rerun final`; a code/policy failure cannot move ben.2 and requires explicit user authorization
for another revision. Candidate evidence is never reused.

- [ ] **Step 6: Idempotently create/edit and verify the public GitHub Release**

Require final run `verifiedAt`, complete promotion state, matching Tag raw/peeled, and an empty
origin official Tag query immediately before Release API access.

Create `.tmp/v2.35.0-ben.2-release-notes.md` with `apply_patch` using these exact sections and the
captured concrete values (never leave shell-variable names in the file):

```markdown
# v2.35.0-ben.2

## 官方基线
- `v2.35.0` / `fc4de772b58c13f7b16b5029b1e981d612a5db06`

## Fork 修复
- recovery reparse 后恢复 Kiro turn-termination scope
- origin-only CI 精确验证官方 ref/marker/main；首个 candidate `d5558096b` / run `33234936660` 证明官方 v2.35.0 为 lightweight ref并修正 annotated-only 假设
- 修正 v2.35 维护真源、overlap 计数与 active coverage 证据
- 删除六处无必要的 Fork test trailing whitespace

## 验证结果
- Failed candidate: `d5558096b` / run `33234936660`, prepare-step policy failure and no Tag/promotion/Release
- Replacement candidate Cross-platform CI: concrete workflow_dispatch run ID and URL
- Final Cross-platform CI: concrete main-push run ID and URL
- Local focused/typecheck/privacy/prepush and reviewer results

## 引用与提交
- Replacement candidate commit, Fork Tag raw/peeled, main/sync/upstream-release exact values

## 已知缺口
- Real minted ciphertext acceptance、Ark weekly quota、service repair OCX_DEBUG boundary
```

Then `chmod 600`. Query the Releases API before writing. Classify exact HTTP status from
`gh api --include repos/Trendymen/opencodex/releases/tags/v2.35.0-ben.2`: `200` means present,
`404` means absent; network/auth/5xx/unknown status stops without guessing.

- If absent, run:

```bash
gh release create v2.35.0-ben.2 \
  --repo Trendymen/opencodex \
  --title v2.35.0-ben.2 \
  --notes-file .tmp/v2.35.0-ben.2-release-notes.md \
  --verify-tag
```

- If present, inspect first. Exact compliant metadata is a no-op. If only title/body/draft/
  prerelease differs, repair metadata idempotently with:

```bash
gh release edit v2.35.0-ben.2 \
  --repo Trendymen/opencodex \
  --title v2.35.0-ben.2 \
  --notes-file .tmp/v2.35.0-ben.2-release-notes.md \
  --draft=false --prerelease=false --verify-tag
```

An unexpected Tag binding or uploaded asset stops; do not delete/rebind it automatically. After a
create/edit response that is failed or uncertain, fresh-query before deciding whether to retry.
Never create a second Release or ben revision as recovery.

Query:

```bash
gh release view v2.35.0-ben.2 --repo Trendymen/opencodex \
  --json tagName,name,body,isDraft,isPrerelease,url,assets
```

Require exact tag/name/body, the four concrete repair bullets and both exact run IDs/URLs,
`isDraft=false`, `isPrerelease=false`, `assets=[]`, and a public URL. Use `apply_patch` to add the
verified metadata to state. Delete the notes file with `apply_patch` only after the API reaches a
known verified state. Do not upload assets or publish npm.

- [ ] **Step 7: Final immutable-state verification and report**

Verify:

```bash
git status --short --branch
git rev-parse HEAD refs/heads/main refs/remotes/origin/main refs/heads/sync/v2.35.0 refs/remotes/origin/sync/v2.35.0
git rev-parse refs/heads/upstream-release refs/remotes/origin/upstream-release
git cat-file -t refs/tags/v2.35.0-ben.2
git rev-parse refs/tags/v2.35.0-ben.2 refs/tags/v2.35.0-ben.2^{}
git ls-remote origin refs/tags/v2.35.0-ben.2 'refs/tags/v2.35.0-ben.2^{}'
git ls-remote origin refs/tags/v2.35.0 'refs/tags/v2.35.0^{}'
```

Expected: worktree clean; HEAD/main/sync/remote branches/candidate equal; markers equal
`fc4de772b`; ben.2 raw+peeled agree; origin official Tag query empty; state records exact candidate/
final run attempts and Release URL; Release remains verified. Copy the non-secret terminal evidence
into the final report, then delete the controller and state files with `apply_patch`. If any terminal
check is incomplete, retain both mode-restricted files for recovery instead. Post-Release metadata
stays in conversation/external evidence only and never mutates Tag/FORK_CHANGES.

---

## Spec Traceability

| Approved Spec goal | Plan coverage | Terminal evidence |
| --- | --- | --- |
| G1: preserve turn-termination object identity | Task 1 | Dedicated routed recovery × Kiro behavioral regression, canonical replacement invariant, focused tests, typecheck, reviewers. |
| G2: independently prove and preserve official baseline Tags | Historical Tasks 2–3 plus S2R-3/S2R-5 | Fixed-official classifier/Git/redaction evidence; origin v2.34 exact retained; v2.35 absent-or-exact preflight and exact post-state in the atomic refset. |
| G3: repair the maintenance source of truth | Historical Tasks 4–5 plus S2R-2 | Six exact whitespace removals, current-chain maintenance-truth RED/GREEN, corrected v2.35 overlap/evidence/current version, docs-only snapshot. |
| G4: publish immutable ben.2 | S2R-4 through S2R-6 | `2.35.0-ben.2`, new exact candidate CI, one post-CI review gate, frozen annotated Tag, leased atomic promotion including verified official v2.35, independent final main CI, verified public Release. |

The Spec's non-goals and safety boundaries are carried by Global Constraints and by the Task 2/3
security reviews: fixed official URL remains the provenance source; origin v2.34/v2.35 must match
that source's type/raw/peeled exactly; mismatch, force, move or reconstruction is forbidden. npm
publish, persistent/global developer install, service/config mutation, public request-field scope,
or opportunistic provider fixes remain out of scope. Every G1–G4
goal has an implementation Task, a review gate, and terminal evidence; there is no uncovered Spec
goal or extra product behavior in this Plan.

---

## Plan Completion Checklist

- [ ] Approved S2R Spec and Approved S2R Plan are committed before contract implementation.
- [ ] Tasks 1–5 each have RED/GREEN evidence and scoped commits.
- [ ] Task-level review gates pass; original reviewers close all prior findings.
- [ ] Final documentation commit contains only `FORK_CHANGES.md` and has parent=`IMPLEMENTATION_HEAD`.
- [ ] Official-relative path set is exactly 112.
- [ ] Untracked CI controller syntax/self-tests pass; mode-0600 state survives re-entry and records exact run attempts/Tag/promotion/Release evidence.
- [ ] New S2R candidate is a recorded descendant of `5548eb2a0`; workflow_dispatch is uniquely bound; every named shipping job/matrix passes, only job-level `platform-windows` is skipped, and no Windows suite shard expands before Tag creation.
- [ ] Candidate CI succeeds before the single parallel Spec/Quality re-review; no Critical/Important finding remains before Tag creation.
- [ ] Promotion preflight proves origin `v2.34.0` exact `80fff9a7f...`; origin `v2.35.0` is absent or exact `fc4de772...`; any mismatch stops without force/move/reconstruction.
- [ ] Atomic promotion uses exact branch leases, frozen Fork Tag raw OID, and one explicit refset containing main, sync, marker, official `v2.35.0`, and Fork `v2.35.0-ben.2`.
- [ ] Final main-push CI is uniquely bound and successful before GitHub Release.
- [ ] GitHub Release is public, stable, same-name, source-archive-only and metadata-verified.
- [ ] Promotion/Release post-state proves origin `v2.34.0` remains exact `80fff9a7f...` and origin `v2.35.0` is exact `fc4de772...`, with both independently revalidated from the fixed official URL.
- [ ] No npm publish or developer/self-hosted global install/service mutation occurs.
- [ ] Final refs, Tag, Release, worktree and all background sessions are terminal and reconciled.
