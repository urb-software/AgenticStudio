# Agent worker: behaviour notes

Longer knowledge that used to sit in code comments of `apps/agent-worker` (rule 14 keeps comments to three lines). Isolation and trust decisions are in [ADR 0002](adr/0002-agent-run-isolation.md) and [Security](../engineering/security.md); this page holds the loop, the Working copy preparation, the smoke runs and the Fake Runner scenarios.

## The loop (`src/worker.ts`)

The worker carries one Run at a time. It claims a Run, prepares its Working copy while the Run is `preparing`, carries the step out through the runner while sending heartbeats, commits what a `done` step left, reports the step result with the Working copy's state, delivers (pushes the Run branch, opens the draft pull request), reports the final state and repeats. The Run's events are forwarded to Studio as they happen. A claim of kind `deliver` (a delivery retry) only delivers from the kept Working copy.

**Stop handling.** A step is stopped when the heartbeat answer carries the operator's cancel, when it reaches its time limit, when Studio says the worker lost the Run, or when the worker stops. The runner is aborted, the step's process groups get SIGINT and then SIGKILL after the grace period, and the Run's containers are removed (the Working copy is kept). The Run is then reported `cancelled`, `timed_out`, nothing (lost) or `failed` with `worker_lost`. A step that would exceed the Run's step maximum (per part: the first part and each Follow-up have their own allowance) is not started (`step_limit`). While Studio is unreachable the step keeps going and its reports wait, in order, in an outbox. A delivery starts only while no stop is pending; a stop or crash during it leaves a delivery to retry (`delivery_failed`), except an operator's cancel, which ends the Run `cancelled`.

**Resume.** A claim of kind `resume` (the operator answered the agent's question) is carried like a start, except that the kept Working copy is located instead of prepared and the runner resumes the session Studio names, with the answer, as the Run's next step: numbered after the steps it took, with its events after the sequence numbers Studio stored. The provider gate and the step limit are checked first, as for every step.

**Diffs.** After every step result the Run's diffs are computed from the Working copy and reported right after the step report (or why they could not be computed). Once a delivery has pushed the Run branch they are reported again, marked as pushed.

## Working copy preparation (`src/working-copy.ts`)

1. The Project's cache (`<dataDir>/cache/<projectId>.git`, a bare repository with every branch of the remote) is created on first use or refreshed with `fetch --prune`; a cache whose remote differs from the Run's is discarded and rebuilt.
2. The start commit must be in the cache, otherwise preparation fails (`preparation_failed`).
3. The Working copy is a local clone of the cache (objects hardlinked), checked out at exactly the start commit on the Run branch.
4. Its Git identity is the Agent account's and its `origin` is the Project's remote URL; no credential is written. The Task and the Run file sit beside it, outside the repository.
5. The Run's Environment file, if any, is written at its path in the Working copy, owner-only, listed under Studio's section of `.git/info/exclude` and in the Run file's `studioPaths`, so it is never committed. It goes with the Working copy.

## Smoke runs of the provider CLIs (`apps/agent-worker/scripts/smoke-*.mjs`)

Not part of CI. The coordinator runs them on the local WSL test worker as the agent user, with the operator's approval to switch the provider on for the duration of the smoke only. Studio's guardrails are root-owned managed files, so they are installed first as root and removed afterwards with `scripts/smoke-guardrails.sh install|remove` (from a root-owned copy of the same commit; `install` needs `SMOKE_NODE_BIN` set). Build first (`pnpm run build:packages` and the worker's `build`), then run `CLAUDE_CODE_ENABLED=true node apps/agent-worker/scripts/smoke-claude.mjs` or `CODEX_CLI_ENABLED=true node apps/agent-worker/scripts/smoke-codex.mjs`.

Each script runs the runner directly (no Studio, no database) on a throwaway Git repository in a temporary directory (`--keep` keeps it) and prints only redacted summary lines: outcomes, counts and yes/no checks, never the agent's output, the session id, the environment or file content. The CLI uses the agent user's own login, which the script never reads. The checks, in order:

1. the version check (Codex: the complete-install check too);
2. a start with a trivial change (Codex also probes that `AGENTS.md` text reaches the agent, that the project's `.codex/` config, hooks and rules are not loaded, and whether a project skill is offered);
3. one question, then a resume with the answer in the same session;
4. a tool call that starts a container through the agent user's rootless Docker;
5. a command Studio refuses (Claude: the managed hook; Codex: the managed rules), and for Claude a write outside the Working copy;
6. Claude: `git push` to a local bare remote does not land. Codex: the managed hook blocks a command no rule covers and the step still ends;
7. the CLI started directly with the record's options after planting user-level hooks, allow rules and (Claude) an `env` with `NODE_OPTIONS`: none takes effect and the managed hook still blocks. Codex also checks the push to a local bare remote does not land; Studio's user-level configuration is rewritten afterwards (Claude: `~/.claude/settings.json` is restored);
8. a Follow-up after the finished first step: the runner resumes the same session with reason `follow_up`, the result is done and the file follows the instruction;
9. bring up to date with a conflict: a local `integration` branch and the Run branch change the same line, the worker's own `BranchUpdates` merges it, the runner resumes the session with the bring-up instruction and the worker's `complete()` finishes the merge. Checked: no unmerged paths, no conflict markers, a merge commit with both parents, nothing pushed.

## Fake Runner scenarios (`src/fake-runner.ts`)

The scenario names are `FAKE_SCENARIOS`; a Follow-up plays the scenario its text names (`[fake:<scenario>]`, default `success`). Every step streams an agent message, a command and its output. In short: `success`, `commit` (one new file committed), `dirty` (one file left uncommitted), `checks-failed`, `two-files`, `fail`, `question` and `question-twice` (a `needs_input` result; resumed, it succeeds, or asks again), `lost-session`, `slow`, `long` (a Run to cancel), `stubborn` (ignores the abort, the hard path), `crash`, `secret` and `print-env` (redaction proven end to end), and `resolve-conflicts` and `resolve-in-tree` (resolve the open merge; the first also stages it, the second leaves staging to the worker, as for an agent whose sandbox cannot write `.git`).
