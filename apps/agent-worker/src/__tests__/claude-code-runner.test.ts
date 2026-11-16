import { type RunPayload, runnerEventSchema, type RunnerEvent } from '@agentic-studio/contracts';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_DEFINITION, AGENT_RESULT_JSON_SCHEMA } from '../agent-definition/index.js';
import { CLAUDE_CODE_PASSED_VARIABLES } from '../claude-code/cli-options.js';
import { readGuardrailSettings } from '../claude-code/guardrails.js';
import { ClaudeCodeRunner, probeClaudeCode } from '../claude-code/runner.js';
import { DEFAULT_PROVIDER_BINARIES } from '../config.js';
import { GitCommandError } from '../git.js';
import { ProviderDisabledError, ProviderGate } from '../provider-gate.js';
import { drainRunStep, type RunStep, UsageLimitError } from '../runner.js';

// Issue #105: the Claude Code runner at the process-spawn boundary. `node:child_process` is
// mocked: each test asserts what the boundary was asked to start (binary, exact arguments,
// environment, working directory, standard input) and replays a recorded event stream as the
// CLI's output. The real process, the stub executable and a hostile repository are in
// claude-code-runner.linux.test.ts.

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

const SESSION = '8f14e45f-ceea-4c8b-9f2e-1f5a7b3c9d20';
const recording = (name: string) =>
  readFileSync(new URL(`./fixtures/claude-recordings/${name}.ndjson`, import.meta.url), 'utf8');

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

const WORKER_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/agent',
  USER: 'agent',
  LANG: 'C.UTF-8',
  ANTHROPIC_API_KEY: 'test-only-api-key',
  ANTHROPIC_AUTH_TOKEN: 'test-only-auth-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'test-only-oauth-token',
  ANTHROPIC_BASE_URL: 'https://proxy.example.test',
  CLAUDE_CODE_USE_BEDROCK: '1',
  STUDIO_WORKER_TOKEN: 'test-only-worker-token',
  STUDIO_AGENT_GITHUB_TOKEN: 'test-only-agent-token',
  CLAUDE_CODE_ENABLED: 'true',
};
const OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'STUDIO_WORKER_TOKEN',
  'STUDIO_AGENT_GITHUB_TOKEN',
];

const payload = (task: string): RunPayload => ({
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'claude_code',
  task,
  startCommit: 'a'.repeat(40),
  repository: { remoteUrl: 'https://git.example.test/acme/shop.git' },
  limits: { stepMinutes: 60, maxSteps: 10 },
  completedSteps: 0,
  integrationBranch: 'dev',
  kind: 'start',
  studioPaths: [],
});

describe('ClaudeCodeRunner at the spawn boundary', () => {
  let runDir: string;
  let gitCalls: string[][];
  const repoFiles: Record<string, string> = {};

  // Issue #134: the managed guardrails check, as a fake here (the real files are root-owned).
  let managedProblem: string | null;
  const runner = (gate = new ProviderGate({ claude_code: true, codex: false })) =>
    new ClaudeCodeRunner({
      managed: {
        problem: async (provider) => (provider === 'claude_code' ? managedProblem : null),
      },
      cli: { gate, binaries: DEFAULT_PROVIDER_BINARIES },
      git: {
        run: async (args) => {
          gitCalls.push([...args]);
          const path = args[2]!.slice(args[2]!.indexOf(':') + 1);
          if (Object.hasOwn(repoFiles, path)) return repoFiles[path]!;
          throw new GitCommandError('cat-file', 128, '', 'exit');
        },
      },
      env: WORKER_ENV,
      maxTurns: 200,
      marker: () => 'feedc0de',
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
  let groups: number[];

  async function drain(step: RunStep) {
    const events: RunnerEvent[] = [];
    const result = await drainRunStep(step, (event) => events.push(event));
    return { events, result };
  }

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'studio-claude-run-'));
    managedProblem = null;
    gitCalls = [];
    groups = [];
    for (const key of Object.keys(repoFiles)) delete repoFiles[key];
    spawn.mockReset();
  });
  afterEach(() => rmSync(runDir, { recursive: true, force: true }));

  it('starts the CLI with exactly the Mode, a minimal environment and standard input closed', async () => {
    spawn.mockImplementation(() => fakeChild(recording('success')));

    const { result } = await drain(runner().start(input('Add a health check')));

    expect(spawn).toHaveBeenCalledOnce();
    const [binary, args, options] = spawn.mock.calls[0]!;
    const { permissions } = await readGuardrailSettings();
    expect(binary).toBe('claude');
    expect(args).toEqual([
      '-p',
      "The operator's Task:\n\nAdd a health check",
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--allowedTools',
      permissions.allow.join(','),
      '--setting-sources',
      'user',
      '--settings',
      posix.join(runDir, 'claude-settings.json'),
      '--strict-mcp-config',
      '--max-turns',
      '200',
      '--append-system-prompt-file',
      posix.join(runDir, 'instructions.md'),
      '--json-schema',
      AGENT_RESULT_JSON_SCHEMA,
    ]);
    expect(options).toEqual({
      cwd: join(runDir, 'repo'),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/agent',
        USER: 'agent',
        LANG: 'C.UTF-8',
        TERM: 'dumb',
        TMPDIR: posix.join(runDir, 'tmp'),
        COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    for (const name of OVERRIDES) expect(options.env).not.toHaveProperty(name);
    for (const name of Object.keys(options.env)) {
      expect([...CLAUDE_CODE_PASSED_VARIABLES, 'TERM', 'TMPDIR', 'COMPOSE_PROJECT_NAME']).toContain(
        name,
      );
    }
    // Issue #100: the CLI's process group belongs to the Run step.
    expect(groups).toEqual([4242]);
    expect(result).toMatchObject({ outcome: 'done', sessionRef: SESSION });
  });

  it('resumes with the same options, the stored session and the answer as the prompt', async () => {
    spawn.mockImplementation(() => fakeChild(recording('resume')));

    const { result } = await drain(
      runner().resume({ ...input('Add a store'), answer: 'PostgreSQL', sessionRef: SESSION }),
    );

    const args = spawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 4)).toEqual([
      '-p',
      "The operator's answer:\n\nPostgreSQL",
      '--resume',
      SESSION,
    ]);
    expect(args.slice(4, 11)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
    ]);
    expect(result).toEqual({
      outcome: 'done',
      summary: 'Added the store on PostgreSQL.',
      sessionRef: SESSION,
    });
  });

  it("writes the instructions and Studio's guardrails into the Run's directory, not the Working copy", async () => {
    repoFiles['CLAUDE.md'] = 'Use pnpm. @../outside.md';
    spawn.mockImplementation(() => fakeChild(recording('success')));

    const { events } = await drain(runner().start(input('x')));

    const instructions = readFileSync(join(runDir, 'instructions.md'), 'utf8');
    expect(instructions.startsWith(AGENT_DEFINITION.text.trimEnd())).toBe(true);
    expect(instructions).toContain('===== BEGIN feedc0de project conventions: CLAUDE.md');
    expect(instructions).toContain('Use pnpm.');
    expect(events[0]).toEqual({
      type: 'notice',
      text: 'Skipped the import @../outside.md in CLAUDE.md: outside the repository.',
    });
    // Read at the start commit from Git, never from the Working copy's files.
    expect(gitCalls[0]).toEqual(['cat-file', 'blob', `${'a'.repeat(40)}:CLAUDE.md`]);
    // Issue #134: the guardrails are the root-owned managed settings; the per-Run file is empty
    // and no guard script is copied anywhere the agent can write.
    expect(readFileSync(join(runDir, 'claude-settings.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(runDir, 'claude-guard.mjs'))).toBe(false);
    expect(existsSync(join(runDir, 'tmp'))).toBe(true);
    expect(existsSync(join(runDir, 'repo'))).toBe(false);
  });

  it('maps every event to a valid runner event', async () => {
    spawn.mockImplementation(() => fakeChild(recording('permission-denied')));

    const { events } = await drain(runner().start(input('x')));

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(runnerEventSchema.safeParse(event).success).toBe(true);
  });

  it('ends a usage limit with UsageLimitError and the session', async () => {
    spawn.mockImplementation(() => fakeChild(recording('usage-limit'), 1));

    const step = drain(runner().start(input('x')));

    await expect(step).rejects.toBeInstanceOf(UsageLimitError);
    await expect(step).rejects.toMatchObject({ sessionRef: SESSION });
  });

  it("logs the CLI's error output when it fails", async () => {
    spawn.mockImplementation(() => {
      const child = fakeChild('', 2);
      child.stderr.write('Error: invalid settings file\n');
      return child;
    });
    const events: RunnerEvent[] = [];

    await expect(
      drainRunStep(runner().start(input('x')), (event) => events.push(event)),
    ).rejects.toThrow(
      'Claude Code exited with code 2 without a result. Its error output: Error: invalid settings file',
    );
    expect(events.at(-1)).toEqual({
      type: 'notice',
      text: "Claude Code's error output: Error: invalid settings file",
    });
  });

  it("puts the CLI's reason for refusing an option into the failure detail (smoke of #129)", async () => {
    spawn.mockImplementation(() => {
      const child = fakeChild('', 1);
      child.stderr.write('Warning: something harmless\n');
      child.stderr.write(
        'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "x"\n',
      );
      return child;
    });

    await expect(drain(runner().start(input('x')))).rejects.toThrow(
      'Claude Code exited with code 1 without a result. Its error output: Error: --json-schema ' +
        'is not a valid JSON Schema: no schema with key or ref "x"',
    );
  });

  it("refuses a step, starting nothing, while the agent user's settings hold hooks or env (review R4 of #129)", async () => {
    const home = join(runDir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ $schema: 'x', hooks: { secret: 'test-only-value' }, env: { A: '1' } }),
    );
    const withHome = new ClaudeCodeRunner({
      cli: {
        gate: new ProviderGate({ claude_code: true, codex: false }),
        binaries: DEFAULT_PROVIDER_BINARIES,
      },
      git: { run: async () => '' },
      env: { ...WORKER_ENV, HOME: home },
      maxTurns: 200,
    });

    const step = drain(withHome.start(input('x')));

    await expect(step).rejects.toThrow(
      'Claude Code user settings contain hooks, env; the operator must review them.',
    );
    await expect(step).rejects.not.toThrow(/test-only-value/);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(runDir, 'instructions.md'))).toBe(false);
  });

  it('refuses a step, starting and writing nothing, while the managed guardrails are missing or changed (Issue #134)', async () => {
    managedProblem =
      'managed guardrails missing or changed: /etc/claude-code/managed-settings.json';

    const step = drain(runner().start(input('x')));

    await expect(step).rejects.toThrow(
      'Claude Code: managed guardrails missing or changed: /etc/claude-code/managed-settings.json. ' +
        "The operator reinstalls them with the server setup's guardrails step",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(runDir, 'instructions.md'))).toBe(false);
    expect(existsSync(join(runDir, 'claude-settings.json'))).toBe(false);
  });

  it('starts nothing and writes nothing when Claude Code is switched off', async () => {
    const off = runner(new ProviderGate({ claude_code: false, codex: true }));

    await expect(off.start(input('x')).next()).rejects.toBeInstanceOf(ProviderDisabledError);
    await expect(
      off.resume({ ...input('x'), answer: 'a', sessionRef: SESSION }).next(),
    ).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(runDir, 'instructions.md'))).toBe(false);
  });

  it('starts nothing when the version check found Claude Code unavailable', async () => {
    const unavailable = runner(
      new ProviderGate(
        { claude_code: true, codex: false },
        { claude_code: 'Claude Code 2.2.0 is not a supported version.' },
      ),
    );

    await expect(unavailable.start(input('x')).next()).rejects.toThrow(
      'Claude Code is unavailable on the agent worker: Claude Code 2.2.0 is not a supported version.',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('the version check at worker start', () => {
  const cli = (gate = new ProviderGate({ claude_code: true, codex: false })) => ({
    gate,
    binaries: DEFAULT_PROVIDER_BINARIES,
  });

  beforeEach(() => {
    spawn.mockReset();
  });

  it('runs `claude --version` through the boundary with the minimal environment', async () => {
    spawn.mockImplementation(() => fakeChild('2.1.325 (Claude Code)\n'));

    expect(await probeClaudeCode(cli(), WORKER_ENV)).toEqual({ ok: true, version: '2.1.325' });
    expect(spawn).toHaveBeenCalledWith('claude', ['--version'], {
      // A neutral, empty temporary directory (review R3 of #129), removed afterwards.
      cwd: expect.stringContaining('studio-claude-version-'),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/agent',
        USER: 'agent',
        LANG: 'C.UTF-8',
        TERM: 'dumb',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      detached: true,
    });
  });

  it('runs in an empty temporary directory that is removed afterwards', async () => {
    let cwd = '';
    spawn.mockImplementation((_binary: string, _args: string[], options: { cwd: string }) => {
      cwd = options.cwd;
      expect(readdirSync(cwd)).toEqual([]);
      return fakeChild('2.1.325 (Claude Code)\n');
    });

    await probeClaudeCode(cli(), WORKER_ENV);

    expect(cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });

  it('reports an unsupported version with the supported range', async () => {
    spawn.mockImplementation(() => fakeChild('2.2.0 (Claude Code)\n'));

    const check = await probeClaudeCode(cli(), WORKER_ENV);
    expect(check).toEqual({
      ok: false,
      reason:
        'Claude Code 2.2.0 is not a supported version (supported: >=2.1.325 <2.2.0). Install a ' +
        'supported version and restart the worker.',
    });
  });

  it('reports a missing binary', async () => {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      setImmediate(() => {
        child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    });

    expect(await probeClaudeCode(cli(), WORKER_ENV)).toEqual({
      ok: false,
      reason:
        'The Claude Code CLI could not be started (CLAUDE_CODE_BIN). Install it for the agent ' +
        'user and restart the worker.',
    });
  });

  it('gives up on a CLI that does not answer in time', async () => {
    spawn.mockImplementation(() =>
      Object.assign(new EventEmitter(), { stdout: new PassThrough() }),
    );

    const check = await probeClaudeCode(cli(), WORKER_ENV, 20);
    expect(check.ok).toBe(false);
  });

  it('never starts a switched-off CLI', async () => {
    await expect(
      probeClaudeCode(cli(new ProviderGate({ claude_code: false, codex: false })), WORKER_ENV),
    ).rejects.toBeInstanceOf(ProviderDisabledError);
    expect(spawn).not.toHaveBeenCalled();
  });
});
