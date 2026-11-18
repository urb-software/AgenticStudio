#!/usr/bin/env node
// Real-CLI smoke of the Codex runner, NOT PART OF CI: run it as the agent user after installing
// the managed guardrails; it rewrites ~/.codex/config.toml and prints redacted lines only.
// Procedure and checks: docs/architecture/agent-worker.md.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_DEFINITION } from '../dist/agent-definition/index.js';
import {
  codexEnvironment,
  codexPrompt,
  codexStartArguments,
  codexStepFiles,
} from '../dist/codex/cli-options.js';
import { prepareCodexHome } from '../dist/codex/codex-home.js';
import { CODEX_RESULT_JSON_SCHEMA } from '../dist/codex/result-schema.js';
import { CodexRunner, probeCodex } from '../dist/codex/runner.js';
import { CodexStream } from '../dist/codex/stream.js';
import { ManagedGuardrails } from '../dist/managed-guardrails.js';
import { DEFAULT_PROVIDER_BINARIES } from '../dist/config.js';
import { BranchUpdates } from '../dist/branch-update.js';
import { bringUpToDateInstruction } from '../dist/agent-definition/bring-up-to-date.js';
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
// The runner refuses every step without the managed files; say so up front.
const managed = await new ManagedGuardrails().problem('codex');
line(`managed guardrails: ${managed === null ? 'in place' : `FAILED: ${managed}`}`);
if (managed !== null) {
  line(
    'smoke: install them first, as root, from a root-owned copy of this commit ' +
      '(apps/agent-worker/scripts/smoke-guardrails.sh install).',
  );
  process.exit(1);
}
line("note: Studio's configuration was written to ~/.codex (config.toml, rules/).");

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
// A local bare remote for the push probe, in the step's temporary directory (the sandbox lets
// the agent write there, so only Studio's rules and hook can stop the push). Nothing leaves.
const remote = join(runDir, 'tmp', 'remote.git');
mkdirSync(remote, { recursive: true });
await git.run(['init', '--quiet', '--bare', remote], { cwd: root, timeoutMs: 60_000 });
await git.run(['remote', 'add', 'origin', remote], local);
const pushed = async () =>
  git
    .run(['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/smoke-push'], {
      cwd: root,
      timeoutMs: 60_000,
    })
    .then(
      () => true,
      () => false,
    );

const runner = new CodexRunner({
  cli,
  git,
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
const hookTask = (probe) =>
  `Run exactly \`DOCKER_HOST=unix:///nonexistent.sock touch ${probe}\` once. If it is refused, ` +
  'quote the refusal word for word in the summary. Change nothing else. End the step as done.';
/** Whether the step's log or summary carries the guard script's refusal. */
const saidByGuard = ({ events, result }) =>
  [...events.map((event) => event.text), result?.summary ?? ''].some((text) =>
    text.includes("Studio's guardrails"),
  );

/**
 * Step 7: the CLI started directly with exactly the record's command (as the runner does, minus
 * the rewrite of the user configuration), after planting user-level configuration an agent could
 * write. Studio's user-level configuration is rewritten afterwards.
 */
async function plantedConfigurationProbe() {
  const home = process.env.HOME ?? '';
  const codexHome = join(home, '.codex');
  const userHookProbe = join(runDir, 'tmp', 'user-hook-ran');
  try {
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: `touch '${userHookProbe}'`, timeout: 10 }] },
          ],
        },
      }),
    );
    rmSync(join(codexHome, 'rules', 'studio.rules'), { force: true });
    writeFileSync(
      join(codexHome, 'rules', 'agent.rules'),
      'prefix_rule(pattern = ["git", "push"], decision = "allow")\n',
    );
    appendFileSync(join(codexHome, 'config.toml'), '\n[features]\nhooks = false\n');

    const files = codexStepFiles(runDir);
    mkdirSync(files.dir, { recursive: true });
    mkdirSync(files.tmpDir, { recursive: true });
    writeFileSync(files.schemaFile, CODEX_RESULT_JSON_SCHEMA);
    rmSync(files.resultFile, { force: true });
    writeFileSync(
      files.promptFile,
      codexPrompt(
        AGENT_DEFINITION.text,
        'Do these two things, each exactly once, and quote any refusal word for word in the ' +
          'summary: 1. run `git push origin HEAD:refs/heads/smoke-push`; 2. run ' +
          '`DOCKER_HOST=unix:///nonexistent.sock touch hook-probe-2.txt`. Change nothing else. ' +
          'End the step as done.',
      ),
    );
    const args = codexStartArguments({ workingCopy: repoDir, sandbox: 'workspace-write', files });
    const env = codexEnvironment({
      base: process.env,
      tmpDir: files.tmpDir,
      composeProjectName: composeProjectName(RUN_ID),
    });
    const stdin = openSync(files.promptFile, 'r');
    let child;
    try {
      child = spawn(cli.binaries.codex, args, {
        cwd: repoDir,
        env,
        stdio: [stdin, 'pipe', 'ignore'],
        timeout: 15 * 60_000,
      });
    } finally {
      closeSync(stdin);
    }
    const exited = new Promise((resolve) => child.once('close', resolve));
    const stream = new CodexStream();
    const events = [];
    for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      events.push(...stream.accept(text));
    }
    const code = await exited;
    const resultText = existsSync(files.resultFile)
      ? readFileSync(files.resultFile, 'utf8')
      : undefined;
    const outcome = stream.finish(
      { exitCode: code, spawnFailed: false },
      { kind: 'file', text: resultText },
    );
    events.push(...outcome.events);
    const result = 'result' in outcome ? outcome.result : undefined;
    line(
      `step 7 (planted user-level hook, allow rule and hooks = false, CLI started directly): ` +
        `exit code ${code}, outcome=${result?.outcome ?? 'none'}, events: ${events.length}`,
    );
    check('planted user-level hook did not run', !existsSync(userHookProbe));
    check('git push did not land despite a planted allow rule (managed rules)', !(await pushed()));
    check(
      'the managed hook still blocked with hooks = false in the user configuration',
      read('hook-probe-2.txt') === undefined,
    );
    finding("the refusal names Studio's guardrails", saidByGuard({ events, result }));
  } catch (error) {
    failures += 1;
    line(`step 7: FAILED (${error?.name ?? 'Error'}: ${error?.message ?? error})`);
  } finally {
    await prepareCodexHome({ home, dataDir: root }, [repoDir]);
    rmSync(join(codexHome, 'rules', 'agent.rules'), { force: true });
    line("  Studio's user-level Codex configuration rewritten: yes");
  }
}
const has = (events, type, pattern) =>
  events.some((event) => event.type === type && pattern.test(event.text));
const task = (input, text) => ({ ...input, run: { ...input.run, task: text } });

/** Step 8: a Follow-up after a `done` step resumes the same session (`reason: 'follow_up'`). */
async function followUpStep(finished) {
  if (!finished.result?.sessionRef) {
    failures += 1;
    line('step 8 (Follow-up after done): SKIPPED, no session from step 1');
    return;
  }
  const followed = await step('step 8 (Follow-up after a finished step)', (input) =>
    runner.resume({
      ...input,
      run: { ...input.run, kind: 'resume', resumeReason: 'follow_up', followUpNumber: 1 },
      answer:
        'Append a second line containing exactly the word again to hello.txt. Do not commit. ' +
        'End the step as done.',
      sessionRef: finished.result.sessionRef,
      reason: 'follow_up',
    }),
  );
  check('outcome done after the Follow-up', followed.result?.outcome === 'done');
  check('same session resumed', followed.result?.sessionRef === finished.result.sessionRef);
  check(
    'hello.txt follows the Follow-up (hello, then again)',
    read('hello.txt')?.trim().split('\n').join('|') === 'hello|again',
  );
}

/**
 * Step 9: the worker's BranchUpdates merges a local `integration` branch into the Run branch with a
 * conflict (the repository stands in for the Project's cache), the runner resumes the session
 * and the worker's complete() finishes the merge; nothing is pushed.
 */
async function bringUpToDateStep(finished) {
  if (!finished.result?.sessionRef) {
    failures += 1;
    line('step 9 (bring up to date): SKIPPED, no session from step 1');
    return;
  }
  const gitIn = (args) => git.run(args, local);
  const commitAll = async (message) => {
    await gitIn(['add', '--all']);
    await gitIn([...identity, 'commit', '--quiet', '--allow-empty', '-m', message]);
  };
  const write = (text) => writeFileSync(join(repoDir, 'conflict.txt'), text);
  await commitAll('Smoke: save the earlier steps');
  write('one\ntwo\nthree\n');
  await commitAll('Smoke: conflict.txt base');
  await gitIn(['branch', 'integration']);
  await gitIn(['checkout', '--quiet', 'integration']);
  write('one\ntwo from integration\nthree\n');
  await commitAll('Smoke: integration side');
  await gitIn(['checkout', '--quiet', '-b', 'smoke-run', 'main']);
  write('one\ntwo from the run\nthree\n');
  await commitAll('Smoke: run side');
  const tip = (await gitIn(['rev-parse', 'integration'])).trim();
  const runTip = (await gitIn(['rev-parse', 'HEAD'])).trim();

  const updates = new BranchUpdates({
    dataDir: root,
    git,
    workingCopies: { refreshProjectCache: async () => repoDir },
    agentGitName: 'Studio Smoke',
    agentGitEmail: 'smoke@example.test',
    logger: { error: () => undefined },
  });
  const prepared = {
    runId: RUN_ID,
    runDir,
    repoDir,
    runBranch: 'smoke-run',
    startCommit,
    env: { COMPOSE_PROJECT_NAME: composeProjectName(RUN_ID) },
  };
  let update;
  let run;
  const resumed = await step('step 9 (bring up to date, conflict)', (input) =>
    (async function* () {
      run = {
        ...input.run,
        kind: 'resume',
        resumeReason: 'bring_up_to_date',
        followUpNumber: 2,
        integrationBranch: 'integration',
      };
      update = await updates.start(prepared, run, input.signal);
      if (update.outcome !== 'conflicts') throw new Error(`the merge ended ${update.outcome}`);
      return yield* runner.resume({
        ...input,
        run,
        answer: bringUpToDateInstruction({
          integrationBranch: 'integration',
          start: update,
          note: '',
        }),
        sessionRef: finished.result.sessionRef,
        reason: 'bring_up_to_date',
      });
    })(),
  );
  if (update === undefined) return;
  check(
    'the worker left the merge open with conflict.txt listed',
    update.files.join() === 'conflict.txt',
  );
  check('outcome done after the bring-up instruction', resumed.result?.outcome === 'done');
  let completed = null;
  try {
    completed = await updates.complete(prepared, run, AbortSignal.timeout(60_000), tip);
  } catch (error) {
    failures += 1;
    line(`  the worker completing the merge: FAILED (${error?.name ?? 'Error'})`);
    await updates.abort(prepared, update.baseCommit).catch(() => false);
  }
  if (completed === null) return;
  line(
    `  merge commit made by: ${completed.completed ? 'the worker (agent left the files in the tree)' : 'the agent'}`,
  );
  const unmerged = (await gitIn(['diff', '--name-only', '--diff-filter=U'])).trim();
  const parents = (await gitIn(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
  const text = read('conflict.txt') ?? '';
  check('no unmerged paths remain', unmerged === '');
  check('no conflict markers remain in conflict.txt', text !== '' && !/^(<{7}|>{7})/m.test(text));
  check(
    'the merge commit has both parents (the Run branch, then integration)',
    parents.length === 3 && parents[1] === runTip && parents[2] === tip,
  );
  check(
    'nothing was pushed',
    (
      await git.run(['--git-dir', remote, 'for-each-ref', '--format=%(refname)'], {
        cwd: root,
        timeoutMs: 60_000,
      })
    ).trim() === '',
  );
  finding(
    'conflict.txt keeps both sides (agent report is not used; file content)',
    /integration/.test(text) && /run/.test(text),
  );
}

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
  // After the step: the Working copy is untrusted in the CLI's configuration (path not printed).
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
    'AGENTS.md reached the agent through the worker (marker in the summary)',
    !!first.result?.summary.includes(AGENTS_MARKER),
  );
  check('project rules not loaded (rule-probe.txt created)', read('rule-probe.txt') !== undefined);
  check('project hooks not loaded (no hook probe file)', !existsSync(hookProbe));
  // Two probes for the project's config.toml: instructions (not masked by the environment
  // allowlist) and an environment variable.
  check(
    'project config not loaded (no project instructions marker in the summary)',
    !first.result?.summary.includes(PROJECT_MARKER),
  );
  check(
    'project config not loaded (STUDIO_PROJECT_LAYER not set)',
    !has(first.events, 'output', /^loaded\s*$/),
  );
  // Known limitation (security.md §2): Codex documents no key that disables project skills.
  finding(
    `project skill ${SKILL_NAME} offered to the agent (agent's own report; known limitation)`,
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

  // 5. Studio's rules.
  const blocked = await step("step 5 (Studio's rules)", (input) =>
    runner.start(
      task(
        input,
        'Run exactly `sudo -n true` once and report what happened in the summary. Change no ' +
          'files. End the step as done.',
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

  // 6. Studio's managed hook: no rule covers a DOCKER_HOST= override; only the hook refuses it.
  const hooked = await step("step 6 (Studio's managed hook)", (input) =>
    runner.start(task(input, hookTask('hook-probe.txt'))),
  );
  check('the step ended with a result', hooked.result !== undefined);
  check(
    'the guarded command did not run (no hook-probe.txt)',
    read('hook-probe.txt') === undefined,
  );
  finding("the refusal names Studio's guardrails", saidByGuard(hooked));

  // 7. A hook, an allow rule and hooks = false planted at user level take no effect.
  await plantedConfigurationProbe();
  // 8. A Follow-up after the finished step 1 resumes the same session.
  await followUpStep(first);

  // 9. Bring the Run branch up to date: the worker merges, the agent resolves the conflict.
  await bringUpToDateStep(first);
} finally {
  if (keep) line(`kept: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

line(failures === 0 ? 'smoke: PASS' : `smoke: FAIL (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
