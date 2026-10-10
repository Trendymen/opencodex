# 历史计划续页

承接[原计划](2026-08-29-v2350-ben2-rebase-repair.md)。以下为原有 Task 6 及后续内容，不作为当前同步任务的执行入口。

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

- [ ] **Step 3: Snapshot final-run identity and classify/execute the release `git push --atomic`**

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
| G4: publish immutable ben.2 | S2R-4 through S2R-6 | `2.35.0-ben.2`, new exact candidate CI, one post-CI review gate, frozen annotated Tag, one leased `git push --atomic` including the verified official v2.35 Tag, independent final main CI, verified public Release. |

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
- [ ] One `git push --atomic` uses exact branch leases, the frozen Fork Tag raw OID, and one explicit refset containing main, sync, marker, official `v2.35.0`, and Fork `v2.35.0-ben.2`.
- [ ] Final main-push CI is uniquely bound and successful before GitHub Release.
- [ ] GitHub Release is public, stable, same-name, source-archive-only and metadata-verified.
- [ ] Promotion/Release post-state proves origin `v2.34.0` remains exact `80fff9a7f...` and origin `v2.35.0` is exact `fc4de772...`, with both independently revalidated from the fixed official URL.
- [ ] No npm publish or developer/self-hosted global install/service mutation occurs.
- [ ] Final refs, Tag, Release, worktree and all background sessions are terminal and reconciled.
