# OpenCodex v2.35.0-ben.2 Rebase Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v2.35 rebase 的 turn-termination 对象身份与 origin-only CI 基线证明缺口，修正 Fork 维护真源，并在 exact candidate/final CI 成功后发布不可变 `v2.35.0-ben.2`。

**Architecture:** `core.ts` 只增加一个局部 adopt/rebind 入口，所有实质 CI 基线验证集中到一个新的 Bun 脚本；workflow 仅在运行完整 suite 的 job 中接线。代码与 version 完成后，以单独 `FORK_CHANGES.md` commit 形成发布前 snapshot；先验证远端 sync candidate，再用一次 `git push --atomic` 同时更新 `main`、`sync/v2.35.0`、`upstream-release`、官方 Tag 与 Fork Tag，随后验证 main push，最后创建 GitHub Release。

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
2. 本Plan修订必须把official Tag absent/exact、发布用 `git push --atomic` 与恢复状态写成可执行命令；
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

### S2R-5：冻结 Tags，并执行发布用的 `git push --atomic`

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

后文 Task 7 用一次 `git push --atomic` 同时更新 `main`、`sync/v2.35.0`、`upstream-release` 与 Fork Tag 的历史发布步骤不变。Fork ben.2 Tag仍必须annotated。Tag annotation与Release
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
  `fc4de772...`在本轮发布用的 `git push --atomic` 中补齐；任何existing mismatch均fail closed，禁止
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
| 发布用 `git push --atomic` | `pending external gate` |
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


后续任务与验收清单见[历史计划续页](2026-08-29-v2350-ben2-rebase-repair-continuation.md)。两页共同保留这份历史计划的完整内容。
