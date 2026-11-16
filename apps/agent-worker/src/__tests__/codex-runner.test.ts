import { type RunPayload, type RunnerEvent } from '@agentic-studio/contracts';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DEFINITION } from '../agent-definition/index.js';
import { CODEX_RESULT_JSON_SCHEMA } from '../codex/result-schema.js';
import { CodexRunner } from '../codex/runner.js';
import { DEFAULT_PROVIDER_BINARIES } from '../config.js';
import { ProviderDisabledError, ProviderGate } from '../provider-gate.js';
import { AgentFailedError, drainRunStep, type RunStep, UsageLimitError } from '../runner.js';

// Issue #106: the Codex runner at the process-spawn boundary. `node:child_process` is mocked:
// each test asserts what the boundary was asked to start (binary, exact arguments, environment,
// working directory, standard input) and replays a recorded event stream as the CLI's output.
// The real process, the stub executable and a hostile repository are in
// codex-runner.linux.test.ts.

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

const THREAD = '0199a8f2-6c1e-7d43-9b2a-5e8f1c3d7a90';
const recording = (name: string) =>
  readFileSync(new URL(`./fixtures/codex-recordings/${name}.jsonl`, import.meta.url), 'utf8');
const lastMessage = (name: string) =>
  recording(name)
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { item?: { type?: string; text?: string } };
        return event.item?.type === 'agent_message' && event.item.text ? [event.item.text] : [];
      } catch {
        return [];
      }
    })
    .at(-1);

/** A child process that prints `output`, then exits with `code`. */
function fakeChild(output: string, code = 0) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  setImmediate(() => {
    child.stdout.end(output);
    child.stderr.end();
    child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
    child.stdout.resume();
  });
  return child;
}

const OVERRIDES = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
  'STUDIO_WORKER_TOKEN',
  'STUDIO_AGENT_GITHUB_TOKEN',
  'CODEX_CLI_ENABLED',
];

const payload = (task: string): RunPayload => ({
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  task,
  startCommit: 'a'.repeat(40),
  repository: { remoteUrl: 'https://git.example.test/acme/shop.git' },
  limits: { stepMinutes: 60, maxSteps: 10 },
  completedSteps: 0,
  integrationBranch: 'dev',
  kind: 'start',
  studioPaths: [],
});

describe('CodexRunner at the spawn boundary', () => {
  let root: string;
  let runDir: string;
  let home: string;
  let groups: number[];

  const workerEnv = () => ({
    PATH: '/usr/bin:/bin',
    HOME: home,
    USER: 'agent',
    LANG: 'C.UTF-8',
    OPENAI_API_KEY: 'test-only-openai-key',
    CODEX_API_KEY: 'test-only-codex-key',
    OPENAI_BASE_URL: 'https://proxy.example.test',
    CODEX_HOME: '/tmp/elsewhere',
    STUDIO_WORKER_TOKEN: 'test-only-worker-token',
    STUDIO_AGENT_GITHUB_TOKEN: 'test-only-agent-token',
    CODEX_CLI_ENABLED: 'true',
  });
  const runner = (
    gate = new ProviderGate({ claude_code: false, codex: true }),
    env: Record<string, string | undefined> = workerEnv(),
  ) =>
    new CodexRunner({
      cli: { gate, binaries: DEFAULT_PROVIDER_BINARIES },
      env,
      sandbox: 'workspace-write',
    });
  const input = (task: string) => ({
    run: payload(task),
    workspace: {
      repoDir: join(runDir, 'repo'),
      runDir,
      env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
    },
    signal: new AbortController().signal,
    processes: { register: (group: number) => groups.push(group) },
    agentDefinition: AGENT_DEFINITION,
  });

  async function drain(step: RunStep) {
    const events: RunnerEvent[] = [];
    const result = await drainRunStep(step, (event) => events.push(event));
    return { events, result };
  }

  /** The CLI as a mock: writes the result file like `--output-last-message`, prints the stream. */
  const replaying = (name: string, code = 0) =>
    spawn.mockImplementation((_binary: string, args: string[]) => {
      const at = args.indexOf('--output-last-message');
      const message = lastMessage(name);
      if (at !== -1 && message !== undefined) writeFileSync(args[at + 1]!, message);
      return fakeChild(recording(name), code);
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-codex-run-'));
    runDir = join(root, 'run');
    home = join(root, 'home');
    mkdirSync(join(runDir, 'repo'), { recursive: true });
    mkdirSync(home);
    groups = [];
    spawn.mockReset();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('starts the CLI with exactly the record command, a minimal environment and the prompt file as standard input', async () => {
    let configAtSpawn = '';
    spawn.mockImplementation((_binary: string, args: string[]) => {
      configAtSpawn = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, lastMessage('success')!);
      return fakeChild(recording('success'));
    });

    const { events, result } = await drain(runner().start(input('Add a health check')));

    expect(spawn).toHaveBeenCalledOnce();
    const [binary, args, options] = spawn.mock.calls[0]!;
    const codexDir = posix.join(runDir, 'codex');
    expect(binary).toBe('codex');
    expect(args).toEqual([
      'exec',
      '--json',
      '--cd',
      join(runDir, 'repo'),
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '--output-schema',
      posix.join(codexDir, 'result.schema.json'),
      '--output-last-message',
      posix.join(codexDir, 'result.json'),
      '-',
    ]);
    expect(options).toEqual({
      cwd: join(runDir, 'repo'),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        USER: 'agent',
        LANG: 'C.UTF-8',
        TERM: 'dumb',
        TMPDIR: posix.join(runDir, 'tmp'),
        COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a',
      },
      // Standard input is a file descriptor (the prompt file), never an open pipe.
      stdio: [expect.any(Number), 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    for (const name of OVERRIDES) expect(options.env).not.toHaveProperty(name);
    expect(groups).toEqual([4242]);
    // The sandbox mode comes first in the Run's log.
    expect(events[0]).toEqual({
      type: 'notice',
      text: "Codex sandbox: workspace-write, network on (set by the agent worker's configuration).",
    });
    // Studio's configuration was in place, with this Working copy untrusted, before the CLI started.
    expect(configAtSpawn).toContain('network_access = true');
    expect(configAtSpawn).toMatch(/\[projects\.".*repo"\]\ntrust_level = "untrusted"/);
    expect(result).toEqual({
      outcome: 'done',
      summary: 'Added a health check endpoint.',
      pullRequest: { title: 'Add a health check', body: 'Assumption: GET /health.' },
      checks: [{ name: 'npm test', result: 'passed' }],
      sessionRef: THREAD,
    });
  });

  it("writes the prompt and the schema into the Run's directory, not the Working copy", async () => {
    replaying('success');

    await drain(runner().start(input('Add a health check')));

    const prompt = readFileSync(join(runDir, 'codex', 'prompt.md'), 'utf8');
    expect(prompt.startsWith(AGENT_DEFINITION.text.trimEnd())).toBe(true);
    expect(prompt).toContain('You cannot commit');
    expect(prompt).toContain("# The operator's Task\n\nAdd a health check");
    expect(readFileSync(join(runDir, 'codex', 'result.schema.json'), 'utf8')).toBe(
      CODEX_RESULT_JSON_SCHEMA,
    );
    expect(existsSync(join(runDir, 'tmp'))).toBe(true);
    expect(existsSync(join(runDir, 'repo', 'prompt.md'))).toBe(false);
  });

  it('resumes the stored session with the same options and the answer file as standard input', async () => {
    replaying('resume');

    const { result } = await drain(
      runner().resume({ ...input('Add a store'), answer: 'PostgreSQL', sessionRef: THREAD }),
    );

    const [, args, options] = spawn.mock.calls[0]!;
    expect(args).toEqual([
      'exec',
      '--json',
      '--cd',
      join(runDir, 'repo'),
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      'resume',
      THREAD,
      '-',
    ]);
    expect(options.stdio[0]).toEqual(expect.any(Number));
    expect(readFileSync(join(runDir, 'codex', 'answer.md'), 'utf8')).toBe(
      "The operator's answer:\n\nPostgreSQL\n",
    );
    expect(result).toEqual({
      outcome: 'done',
      summary: 'Added the store on PostgreSQL.',
      sessionRef: THREAD,
    });
  });

  it("never takes an earlier step's result file for this step's", async () => {
    mkdirSync(join(runDir, 'codex'));
    writeFileSync(join(runDir, 'codex', 'result.json'), lastMessage('success')!);
    spawn.mockImplementation(() => fakeChild(recording('success')));

    await expect(drain(runner().start(input('x')))).rejects.toThrow(
      'Codex ended without a valid structured result.',
    );
  });

  it('ends a usage limit with UsageLimitError and the session', async () => {
    replaying('usage-limit', 1);

    const step = drain(runner().start(input('x')));

    await expect(step).rejects.toBeInstanceOf(UsageLimitError);
    await expect(step).rejects.toMatchObject({ sessionRef: THREAD });
  });

  it("puts the CLI's reason into the failure detail and the log", async () => {
    spawn.mockImplementation(() => {
      const child = fakeChild('', 2);
      child.stderr.write('Error: unexpected argument found\n');
      return child;
    });
    const events: RunnerEvent[] = [];

    await expect(
      drainRunStep(runner().start(input('x')), (event) => events.push(event)),
    ).rejects.toThrow(
      'Codex exited with code 2 without completing its turn. Its error output: Error: unexpected argument found',
    );
    expect(events.at(-1)).toEqual({
      type: 'notice',
      text: "Codex's error output: Error: unexpected argument found",
    });
  });

  it("logs the CLI's expected untrusted-project warning as a notice, never as the failure reason (smoke of #133)", async () => {
    const WARNING = 'warning: Untrusted project-local configuration is disabled for this project.';
    spawn.mockImplementation((_binary: string, args: string[]) => {
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, lastMessage('success')!);
      const child = fakeChild(recording('success'));
      child.stderr.write(`${WARNING}\n`);
      return child;
    });
    const events: RunnerEvent[] = [];

    const result = await drainRunStep(runner().start(input('x')), (event) => events.push(event));

    expect(result.outcome).toBe('done');
    expect(events).toContainEqual({
      type: 'notice',
      text: 'Codex: warning: Untrusted project-local configuration is disabled for this project.',
    });

    spawn.mockImplementation(() => {
      const child = fakeChild('', 1);
      child.stderr.write('Error: invalid_json_schema\n');
      child.stderr.write(`${WARNING}\n`);
      return child;
    });
    await expect(drain(runner().start(input('x')))).rejects.toThrow(
      'Its error output: Error: invalid_json_schema',
    );
  });

  it('refuses a step while user-level instructions or skills are present, starting nothing (review C2 of #133)', async () => {
    mkdirSync(join(home, '.codex', 'skills', '.system'), { recursive: true });
    replaying('success');
    // The CLI's own bundled skills are allowed.
    await drain(runner().start(input('x')));
    spawn.mockReset();

    writeFileSync(join(home, '.codex', 'AGENTS.md'), 'test-only-instructions');
    mkdirSync(join(home, '.codex', 'skills', 'evil'));
    mkdirSync(join(home, '.agents', 'skills', 'other'), { recursive: true });

    const step = drain(runner().start(input('x')));
    await expect(step).rejects.toThrow(
      'Codex user-level instruction or skill files present: ~/.codex/AGENTS.md, ' +
        '~/.codex/skills/evil, ~/.agents/skills/other; the operator must review them.',
    );
    await expect(step).rejects.not.toThrow(/test-only-instructions/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a step without the agent user home, starting nothing', async () => {
    const env: Record<string, string | undefined> = { ...workerEnv(), HOME: undefined };

    await expect(drain(runner(undefined, env).start(input('x')))).rejects.toBeInstanceOf(
      AgentFailedError,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts nothing and writes nothing when Codex is switched off', async () => {
    const off = runner(new ProviderGate({ claude_code: true, codex: false }));

    await expect(off.start(input('x')).next()).rejects.toBeInstanceOf(ProviderDisabledError);
    await expect(
      off.resume({ ...input('x'), answer: 'a', sessionRef: THREAD }).next(),
    ).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(home, '.codex'))).toBe(false);
    expect(existsSync(join(runDir, 'codex'))).toBe(false);
  });

  it('starts nothing when the start checks found Codex unavailable', async () => {
    const unavailable = runner(
      new ProviderGate(
        { claude_code: false, codex: true },
        { codex: 'Codex 0.180.0 is not a supported version.' },
      ),
    );

    await expect(unavailable.start(input('x')).next()).rejects.toThrow(
      'Codex is unavailable on the agent worker: Codex 0.180.0 is not a supported version.',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
