#!/usr/bin/env node
// Controlled real-CLI smoke of the Codex runner (Issue #106). NOT PART OF CI.
//
// Run by the coordinator on the local WSL test worker, as the agent user, with the operator's
// approval to switch Codex on for the duration of the smoke only (operator decision on #106):
//
//   pnpm run build:packages && pnpm --filter @agentic-studio/agent-worker run build
//   CODEX_CLI_ENABLED=true node apps/agent-worker/scripts/smoke-codex.mjs
//
// Studio owns the agent user's Codex configuration: like every Codex Run step, this script
// rewrites ~/.codex/config.toml, ~/.codex/hooks.json and ~/.codex/rules/ (it never reads the
// login or the session files). It runs the runner directly (no Studio, no database) on a
// throwaway Git repository with hostile project configuration, in a temporary directory deleted
// afterwards (pass --keep to keep it):
//   1. the complete-install and version checks;
//   2. a trivial change, with probes: AGENTS.md read (a marker), the project's .codex/ config,
//      hooks and rules not loaded, whether a project skill is offered;
//   3. one question, then a resume with the answer (same session; result from the last message);
//   4. a container through the agent user's rootless Docker (network on in the sandbox);
//   5. a command Studio's rules forbid and one Studio's hook blocks.
// It prints only redacted summary lines: outcomes, counts and yes/no checks. Never the agent's
// output, the session id, the environment or file content.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DEFINITION } from '../dist/agent-definition/index.js';
import { CodexRunner, probeCodex } from '../dist/codex/runner.js';
import { DEFAULT_PROVIDER_BINARIES } from '../dist/config.js';
import { GitRunner } from '../dist/git.js';
import { ProviderGate, readProviderSwitches } from '../dist/provider-gate.js';
import { composeProjectName } from '../dist/run-layout.js';
import { drainRunStep } from '../dist/runner.js';
import { StepProcesses } from '../dist/step-processes.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const AGENTS_MARKER = 'STUDIO-SMOKE-AGENTS-7Q2';
const SKILL_NAME = 'studio-smoke-skill';
const PROJECT_MARKER = 'STUDIO-SMOKE-PROJECT-4K9';
const keep = process.argv.includes('--keep');
const line = (text) => process.stdout.write(`${text}\n`);

if (process.platform !== 'linux') {
  line('smoke: Linux only (run it in WSL as the agent user).');
  process.exit(1);
}
const switches = readProviderSwitches(process.env);
if (!switches.codex) {
  line('smoke: CODEX_CLI_ENABLED is not exactly "true"; nothing was started.');
  process.exit(1);
}
const gate = new ProviderGate(switches);
const cli = {
  gate,
  binaries: { ...DEFAULT_PROVIDER_BINARIES, codex: process.env.CODEX_CLI_BIN || 'codex' },
};

const version = await probeCodex(cli, process.env);
line(
  `install and version check: ${version.ok ? `${version.version} (complete install, supported)` : `FAILED: ${version.reason}`}`,
);
if (!version.ok) process.exit(1);
line("note: Studio's configuration was written to ~/.codex (config.toml, hooks.json, rules/).");

const root = mkdtempSync(join(tmpdir(), 'studio-codex-smoke-'));
const runDir = join(root, 'run');
const repoDir = join(runDir, 'repo');
const hookProbe = join(root, 'project-hook-ran');
mkdirSync(repoDir, { recursive: true });
const git = new GitRunner();
const identity = ['-c', 'user.name=Studio Smoke', '-c', 'user.email=smoke@example.test'];
const local = { cwd: repoDir, timeoutMs: 60_000 };
await git.run(['init', '--quiet', '--initial-branch=main'], local);
const files = {
  'README.md': '# Smoke repository\n',
  'AGENTS.md': `Keep changes minimal. End every summary with the code ${AGENTS_MARKER}.\n`,
  // Project layers an untrusted project must not load.
  '.codex/config.toml': '[shell_environment_policy]\nset = { STUDIO_PROJECT_LAYER = "loaded" }\n',
  '.codex/hooks.json': JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: `touch '${hookProbe}'`, timeout: 10 }] }],
    },
  }),
  '.codex/rules/project.rules':
    'prefix_rule(pattern = ["touch", "rule-probe.txt"], decision = "forbidden")\n',
  [`.agents/skills/${SKILL_NAME}/SKILL.md`]: `---\nname: ${SKILL_NAME}\ndescription: A smoke probe skill.\n---\nSay hi.\n`,
  [`.codex/skills/${SKILL_NAME}/SKILL.md`]: `---\nname: ${SKILL_NAME}\ndescription: A smoke probe skill.\n---\nSay hi.\n`,
};
for (const [path, content] of Object.entries(files)) {
  mkdirSync(join(repoDir, path, '..'), { recursive: true });
  writeFileSync(join(repoDir, path), content);
}
await git.run(['add', '--all'], local);
await git.run([...identity, 'commit', '--quiet', '-m', 'Initial commit'], local);
const startCommit = (await git.run(['rev-parse', 'HEAD'], local)).trim();

const runner = new CodexRunner({
  cli,
  env: process.env,
  sandbox: 'workspace-write',
  dataDir: root,
});
let failures = 0;

/** One Run step; prints a redacted summary and returns the result and events. */
async function step(label, start) {
  const processes = new StepProcesses(join(runDir, 'step-processes'));
  const counts = { message: 0, command: 0, output: 0, notice: 0 };
  const events = [];
  const input = {
    run: {
      runId: RUN_ID,
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: 'codex',
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
/** A finding to record, not a pass/fail check. */
const finding = (label, value) => line(`  finding, ${label}: ${value ? 'yes' : 'no'}`);
const read = (path) => {
  try {
    return readFileSync(join(repoDir, path), 'utf8');
  } catch {
    return undefined;
  }
};
const has = (events, type, pattern) =>
  events.some((event) => event.type === type && pattern.test(event.text));
const task = (input, text) => ({ ...input, run: { ...input.run, task: text } });

try {
  // 2. A trivial change, with the project-configuration probes.
  const first = await step('step 1 (start, trivial change and probes)', (input) =>
    runner.start(
      task(
        input,
        'Create a file named hello.txt containing exactly the word hello and a newline. Then run ' +
          'exactly `touch rule-probe.txt` and `printenv STUDIO_PROJECT_LAYER` once each. Do not ' +
          `commit. In the summary, say whether a skill named ${SKILL_NAME} is available to you, ` +
          `as "skill available: yes" or "skill available: no". Then end the step as done.`,
      ),
    ),
  );
  // After the step: the Working copy is untrusted in the configuration the CLI reads (path not printed).
  const config = readFileSync(join(process.env.HOME ?? '', '.codex', 'config.toml'), 'utf8');
  check(
    'Working copy marked untrusted in ~/.codex/config.toml',
    config.includes(`[projects."${repoDir}"]\ntrust_level = "untrusted"`),
  );

  check('outcome done', first.result?.outcome === 'done');
  check('hello.txt created with the expected content', read('hello.txt')?.trim() === 'hello');
  check(
    'the sandbox mode was stated in the log',
    has(first.events, 'notice', /^Codex sandbox: workspace-write, network on/),
  );
  check(
    'AGENTS.md was read (marker in the summary)',
    !!first.result?.summary.includes(AGENTS_MARKER),
  );
  check('project rules not loaded (rule-probe.txt created)', read('rule-probe.txt') !== undefined);
  check('project hooks not loaded (no hook probe file)', !existsSync(hookProbe));
  // Two probes for the project's config.toml: instructions (not masked by Studio's environment
  // allowlist, review of #133) and an environment variable.
  check(
    'project config not loaded (no project instructions marker in the summary)',
    !first.result?.summary.includes(PROJECT_MARKER),
  );
  check(
    'project config not loaded (STUDIO_PROJECT_LAYER not set)',
    !has(first.events, 'output', /^loaded\s*$/),
  );
  finding(
    `project skill ${SKILL_NAME} offered to the agent (agent's own report)`,
    /skill available: yes/i.test(first.result?.summary ?? ''),
  );

  // 3. A question, then the answer resumes the same session.
  const asked = await step('step 2 (question)', (input) =>
    runner.start(
      task(
        input,
        'Before changing anything, ask the operator one question: should greeting.txt contain "hi" or "hey"? ' +
          'Offer exactly these two options and recommend "hi". Do not create the file yet.',
      ),
    ),
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
    check(
      'outcome done after the answer (result from the last message)',
      answered.result?.outcome === 'done',
    );
    check('same session resumed', answered.result?.sessionRef === asked.result.sessionRef);
    check('greeting.txt follows the answer', read('greeting.txt')?.trim() === 'hey');
  } else {
    failures += 1;
    line('step 3 (resume): SKIPPED, no session from step 2');
  }

  // 4. A container through the agent user's rootless Docker.
  line(
    `docker: DOCKER_HOST set for the agent: ${process.env.DOCKER_HOST ? 'yes' : 'no (default socket)'}`,
  );
  const docker = await step('step 4 (rootless Docker tool call)', (input) =>
    runner.start(
      task(
        input,
        'Run exactly `docker run --rm hello-world` once. Change no files. In the summary, say ' +
          'whether its output contained "Hello from Docker!". End the step as done.',
      ),
    ),
  );
  check('docker run was called', has(docker.events, 'command', /docker run/));
  check(
    'the container printed "Hello from Docker!"',
    has(docker.events, 'output', /Hello from Docker!/),
  );

  // 5. Studio's rules and hook.
  const blocked = await step("step 5 (Studio's rules and hook)", (input) =>
    runner.start(
      task(
        input,
        'Run exactly these two commands, once each, and report what happened to each in the ' +
          'summary: `sudo -n true` and `echo DOCKER_HOST=studio-hook-probe`. Change no files. ' +
          'End the step as done.',
      ),
    ),
  );
  const said = [...blocked.events.map((event) => event.text), blocked.result?.summary ?? ''].join(
    '\n',
  );
  check(
    'sudo was refused by a rule (forbidden)',
    /forbidden|rejected|not allowed|blocked/i.test(said),
  );
  check(
    "Studio's hook blocked the DOCKER_HOST= command",
    !has(blocked.events, 'output', /^DOCKER_HOST=studio-hook-probe\s*$/) &&
      /Studio's guardrails|blocked/i.test(said),
  );
} finally {
  if (keep) line(`kept: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

line(failures === 0 ? 'smoke: PASS' : `smoke: FAIL (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
