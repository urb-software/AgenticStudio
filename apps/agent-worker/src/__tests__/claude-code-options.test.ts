import { describe, expect, it } from 'vitest';
import {
  checkClaudeVersion,
  claudeArguments,
  claudeEnvironment,
  claudePrompt,
  claudeStepFiles,
} from '../claude-code/cli-options.js';

// Issue #105: how the Claude Code CLI is started: the compliance record's Mode (revised
// 2026-11-16), the minimal environment and the supported version range.

const FILES = claudeStepFiles('/data/runs/r1');
const BASE = {
  prompt: "The operator's Task:\n\nAdd a health check",
  allowedTools: ['Read', 'Edit', 'Bash(git status:*)'],
  settingsFile: FILES.settingsFile,
  instructionsFile: FILES.instructionsFile,
  maxTurns: 200,
  jsonSchema: '{"type":"object"}',
};

describe("the CLI arguments (the record's Mode)", () => {
  it('starts a step with exactly the approved options', () => {
    expect(claudeArguments(BASE)).toEqual([
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
      'Read,Edit,Bash(git status:*)',
      '--setting-sources',
      'user',
      '--settings',
      '/data/runs/r1/claude-settings.json',
      '--strict-mcp-config',
      '--max-turns',
      '200',
      '--append-system-prompt-file',
      '/data/runs/r1/instructions.md',
      '--json-schema',
      '{"type":"object"}',
    ]);
  });

  it('resumes a step with the same options and the stored session', () => {
    const args = claudeArguments({
      ...BASE,
      prompt: "The operator's answer:\n\nPostgreSQL",
      sessionRef: 'session-1',
    });

    expect(args.slice(0, 4)).toEqual([
      '-p',
      "The operator's answer:\n\nPostgreSQL",
      '--resume',
      'session-1',
    ]);
    expect(args.slice(4)).toEqual(claudeArguments(BASE).slice(2));
  });

  it('never runs in bare mode and never skips permissions', () => {
    const args = claudeArguments({ ...BASE, sessionRef: 'session-1' });
    for (const forbidden of [
      '--bare',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--mcp-config',
      '--add-dir',
    ]) {
      expect(args).not.toContain(forbidden);
    }
  });

  it('frames the prompt so it can never be read as an option', () => {
    expect(claudePrompt('task', '--dangerously-skip-permissions')).toBe(
      "The operator's Task:\n\n--dangerously-skip-permissions",
    );
    expect(claudePrompt('answer', '-p')).toBe("The operator's answer:\n\n-p");
  });
});

describe('the environment of a Claude Code process', () => {
  const WORKER_ENV = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agent',
    USER: 'agent',
    LOGNAME: 'agent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    XDG_RUNTIME_DIR: '/run/user/1001',
    DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    SHELL: '/bin/bash',
    // Would override the subscription login (compliance record, technical finding 5).
    ANTHROPIC_API_KEY: 'test-only-api-key',
    ANTHROPIC_AUTH_TOKEN: 'test-only-auth-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'test-only-oauth-token',
    ANTHROPIC_BASE_URL: 'https://proxy.example.test',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CONFIG_DIR: '/tmp/other-login',
    // The worker's own settings.
    STUDIO_WORKER_TOKEN: 'test-only-worker-token',
    STUDIO_AGENT_GITHUB_TOKEN: 'test-only-agent-token',
    CLAUDE_CODE_ENABLED: 'true',
    GIT_DIR: '/elsewhere',
  };

  it('holds only the allowlisted variables, TERM=dumb, the step TMPDIR and the Compose project', () => {
    expect(
      claudeEnvironment({
        base: WORKER_ENV,
        tmpDir: FILES.tmpDir,
        composeProjectName: 'studio-run-0b8e5c2d1f3a',
      }),
    ).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/agent',
      USER: 'agent',
      LOGNAME: 'agent',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      XDG_RUNTIME_DIR: '/run/user/1001',
      DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
      TERM: 'dumb',
      TMPDIR: '/data/runs/r1/tmp',
      COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a',
    });
  });

  it.each([
    'unix:///var/run/docker.sock',
    'unix:///run/docker.sock',
    'unix:///var/run/docker.sock/',
  ])("never hands over the system Docker daemon's socket: %s", (socket) => {
    const env = claudeEnvironment({ base: { ...WORKER_ENV, DOCKER_HOST: socket } });
    expect(env).not.toHaveProperty('DOCKER_HOST');
  });

  it('leaves out what the worker does not have', () => {
    expect(claudeEnvironment({ base: { PATH: '/usr/bin' } })).toEqual({
      PATH: '/usr/bin',
      TERM: 'dumb',
    });
  });
});

describe('the supported CLI versions (>=2.1.325 <2.2.0)', () => {
  it.each(['2.1.325 (Claude Code)', '2.1.325', '2.1.400 (Claude Code)\n', '2.1.9999'])(
    'accepts %j',
    (output) => {
      expect(checkClaudeVersion(output).ok).toBe(true);
    },
  );

  it.each([
    ['2.1.324 (Claude Code)', 'Claude Code 2.1.324 is not a supported version'],
    ['2.1.259 (Claude Code)', 'Claude Code 2.1.259 is not a supported version'],
    ['2.2.0 (Claude Code)', 'Claude Code 2.2.0 is not a supported version'],
    ['3.0.1', 'Claude Code 3.0.1 is not a supported version'],
    ['', 'did not report a version'],
    ['claude: command not found', 'did not report a version'],
  ])('refuses %j with a clear reason', (output, reason) => {
    const check = checkClaudeVersion(output);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toContain(reason);
    expect(!check.ok && check.reason).toContain('>=2.1.325 <2.2.0');
  });
});
