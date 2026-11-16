#!/usr/bin/env node
// Controlled real-CLI smoke of the Claude Code runner (Issue #105). NOT PART OF CI.
//
// Run by the coordinator on the local WSL test worker, as the agent user, with the operator's
// approval to switch Claude Code on for the duration of the smoke only (DoR of #105):
//
//   pnpm run build:packages && pnpm --filter @agentic-studio/agent-worker run build
//   CLAUDE_CODE_ENABLED=true node apps/agent-worker/scripts/smoke-claude.mjs
//
// It runs the runner directly (no Studio, no database) on a throwaway Git repository in a
// temporary directory, deleted afterwards (pass --keep to keep it):
//   1. the version check;
//   2. one start with a trivial change;
//   3. one question, then a resume with the answer (same session);
//   4. a tool call that starts a container through the agent user's rootless Docker, with the
//      full approved Mode (--permission-prompts none and Studio's --settings; note from #94).
// It prints only redacted summary lines: outcomes, counts and yes/no checks. Never the agent's
// output, the session id, the environment or file content. The CLI uses the agent user's own
// subscription login; this script never reads it.
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DEFINITION } from '../dist/agent-definition/index.js';
import { ClaudeCodeRunner, probeClaudeCode } from '../dist/claude-code/runner.js';
import { DEFAULT_PROVIDER_BINARIES } from '../dist/config.js';
import { GitRunner } from '../dist/git.js';
import { ProviderGate, readProviderSwitches } from '../dist/provider-gate.js';
import { composeProjectName } from '../dist/run-layout.js';
import { drainRunStep } from '../dist/runner.js';
import { StepProcesses } from '../dist/step-processes.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const keep = process.argv.includes('--keep');
const line = (text) => process.stdout.write(`${text}\n`);

if (process.platform !== 'linux') {
  line('smoke: Linux only (run it in WSL as the agent user).');
  process.exit(1);
}
const switches = readProviderSwitches(process.env);
if (!switches.claude_code) {
  line('smoke: CLAUDE_CODE_ENABLED is not exactly "true"; nothing was started.');
  process.exit(1);
}
const gate = new ProviderGate(switches);
const cli = {
  gate,
  binaries: { ...DEFAULT_PROVIDER_BINARIES, claude_code: process.env.CLAUDE_CODE_BIN || 'claude' },
};

const version = await probeClaudeCode(cli, process.env);
line(
  `version check: ${version.ok ? `${version.version} (supported)` : `FAILED: ${version.reason}`}`,
);
if (!version.ok) process.exit(1);

const root = mkdtempSync(join(tmpdir(), 'studio-claude-smoke-'));
const runDir = join(root, 'run');
const repoDir = join(runDir, 'repo');
mkdirSync(repoDir, { recursive: true });
const git = new GitRunner();
const identity = ['-c', 'user.name=Studio Smoke', '-c', 'user.email=smoke@example.test'];
const local = { cwd: repoDir, timeoutMs: 60_000 };
await git.run(['init', '--quiet', '--initial-branch=main'], local);
writeFileSync(join(repoDir, 'README.md'), '# Smoke repository\n');
writeFileSync(join(repoDir, 'CLAUDE.md'), 'Keep changes minimal. Do not commit.\n');
await git.run(['add', '--all'], local);
await git.run([...identity, 'commit', '--quiet', '-m', 'Initial commit'], local);
const startCommit = (await git.run(['rev-parse', 'HEAD'], local)).trim();

const runner = new ClaudeCodeRunner({ cli, git, env: process.env, maxTurns: 20 });
let failures = 0;

/** One Run step; prints a redacted summary and returns the result (or undefined). */
async function step(label, start) {
  const processes = new StepProcesses(join(runDir, 'step-processes'));
  const counts = { message: 0, command: 0, output: 0, notice: 0 };
  const events = [];
  const input = {
    run: {
      runId: RUN_ID,
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: 'claude_code',
      task: 'unused',
      startCommit,
      repository: { remoteUrl: 'https://git.example.test/smoke.git' },
      limits: { stepMinutes: 15, maxSteps: 10 },
      completedSteps: 0,
      integrationBranch: 'main',
      kind: 'start',
      studioPaths: [],
    },
    workspace: { repoDir, runDir, env: { COMPOSE_PROJECT_NAME: composeProjectName(RUN_ID) } },
    signal: AbortSignal.timeout(15 * 60_000),
    processes,
    agentDefinition: AGENT_DEFINITION,
  };
  try {
    const result = await drainRunStep(start(input), (event) => {
      counts[event.type] += 1;
      events.push(event);
    });
    line(
      `${label}: outcome=${result.outcome}, session ref present: ${result.sessionRef ? 'yes' : 'no'}, ` +
        `checks reported: ${result.checks?.length ?? 0}, events: ${JSON.stringify(counts)}`,
    );
    return { result, events };
  } catch (error) {
    failures += 1;
    line(
      `${label}: FAILED (${error?.name ?? 'Error'}: ${error?.message ?? error}), events: ${JSON.stringify(counts)}`,
    );
    return { events };
  } finally {
    await processes.terminate(5000);
    await processes.release();
  }
}

const check = (label, ok) => {
  if (!ok) failures += 1;
  line(`  ${label}: ${ok ? 'yes' : 'NO'}`);
};
const read = (path) => {
  try {
    return readFileSync(join(repoDir, path), 'utf8');
  } catch {
    return undefined;
  }
};

try {
  // 2. A trivial change.
  const first = await step('step 1 (start, trivial change)', (input) =>
    runner.start({
      ...input,
      run: {
        ...input.run,
        task: 'Create a file named hello.txt containing exactly the word hello and a newline. Do not commit. Then end the step as done.',
      },
    }),
  );
  check('outcome done', first.result?.outcome === 'done');
  check('hello.txt created with the expected content', read('hello.txt')?.trim() === 'hello');

  // 3. A question, then the answer resumes the same session.
  const asked = await step('step 2 (question)', (input) =>
    runner.start({
      ...input,
      run: {
        ...input.run,
        task:
          'Before changing anything, ask the operator one question: should greeting.txt contain "hi" or "hey"? ' +
          'Offer exactly these two options and recommend "hi". Do not create the file yet.',
      },
    }),
  );
  check(
    'outcome needs_input with a question',
    asked.result?.outcome === 'needs_input' && !!asked.result.question,
  );
  check('no greeting.txt before the answer', read('greeting.txt') === undefined);
  if (asked.result?.sessionRef) {
    const answered = await step('step 3 (resume with the answer)', (input) =>
      runner.resume({ ...input, answer: 'hey', sessionRef: asked.result.sessionRef }),
    );
    check('outcome done after the answer', answered.result?.outcome === 'done');
    check('same session resumed', answered.result?.sessionRef === asked.result.sessionRef);
    check('greeting.txt follows the answer', read('greeting.txt')?.trim() === 'hey');
  } else {
    failures += 1;
    line('step 3 (resume): SKIPPED, no session from step 2');
  }

  // 4. A container through the agent user's rootless Docker, with the full Mode.
  line(
    `docker: DOCKER_HOST set for the agent: ${process.env.DOCKER_HOST ? 'yes' : 'no (default socket)'}`,
  );
  const docker = await step('step 4 (rootless Docker tool call)', (input) =>
    runner.start({
      ...input,
      run: {
        ...input.run,
        task:
          'Run exactly `docker run --rm hello-world` with the Bash tool, once. Change no files. ' +
          'In the summary, say whether its output contained "Hello from Docker!". End the step as done.',
      },
    }),
  );
  check(
    'docker run was called',
    docker.events.some((event) => event.type === 'command' && event.text.includes('docker run')),
  );
  check(
    'the container printed "Hello from Docker!"',
    docker.events.some(
      (event) => event.type === 'output' && event.text.includes('Hello from Docker!'),
    ),
  );
  check(
    'no tool call was denied',
    !docker.events.some((event) => event.type === 'notice' && event.text.includes('denied')),
  );
} finally {
  if (keep) line(`kept: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

line(failures === 0 ? 'smoke: PASS' : `smoke: FAIL (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
