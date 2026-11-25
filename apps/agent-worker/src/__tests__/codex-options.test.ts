import { describe, expect, it } from 'vitest';
import { BASE_RULES } from '@agentic-studio/contracts';
import { ModelNotAllowedError } from '../model-option.js';
import {
  checkCodexVersion,
  codexEnvironment,
  codexPrompt,
  codexResumeArguments,
  codexStartArguments,
  codexStepFiles,
  sandboxNotice,
} from '../codex/cli-options.js';

// How the worker starts the Codex CLI: the approved command, a minimal environment, the versions.

const files = codexStepFiles('/data/runs/r1');

describe('the Codex command (compliance record, "CLI version and command")', () => {
  it('starts a first step with exactly the record options, the prompt on standard input', () => {
    expect(
      codexStartArguments({ workingCopy: '/data/runs/r1/repo', sandbox: 'workspace-write', files }),
    ).toEqual([
      'exec',
      '--json',
      '--cd',
      '/data/runs/r1/repo',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '--output-schema',
      '/data/runs/r1/codex/result.schema.json',
      '--output-last-message',
      '/data/runs/r1/codex/result.json',
      '-',
    ]);
  });

  it('resumes the stored session with the same options and no schema option', () => {
    expect(
      codexResumeArguments({
        workingCopy: '/data/runs/r1/repo',
        sandbox: 'workspace-write',
        files,
        sessionRef: '0199a8f2-6c1e-7d43-9b2a-5e8f1c3d7a90',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--cd',
      '/data/runs/r1/repo',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      'resume',
      '0199a8f2-6c1e-7d43-9b2a-5e8f1c3d7a90',
      '-',
    ]);
  });

  it('adds only --model <name> after the approval policy on a first step', () => {
    const args = codexStartArguments({
      workingCopy: '/w',
      sandbox: 'workspace-write',
      files,
      model: 'gpt-6.2-sol',
    });

    expect(args).toEqual([
      ...codexStartArguments({ workingCopy: '/w', sandbox: 'workspace-write', files }).slice(0, 8),
      '--model',
      'gpt-6.2-sol',
      '--output-schema',
      '/data/runs/r1/codex/result.schema.json',
      '--output-last-message',
      '/data/runs/r1/codex/result.json',
      '-',
    ]);
  });

  it('puts --model <name> before resume on a resumed step, as the record shows', () => {
    expect(
      codexResumeArguments({
        workingCopy: '/w',
        sandbox: 'workspace-write',
        files,
        sessionRef: 's-1',
        model: 'gpt-6-luna',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--cd',
      '/w',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '--model',
      'gpt-6-luna',
      'resume',
      's-1',
      '-',
    ]);
  });

  it('adds no option for the default model: the command equals the one without a model', () => {
    const input = { workingCopy: '/w', sandbox: 'workspace-write', files } as const;

    expect(codexStartArguments({ ...input, model: 'default' })).toEqual(codexStartArguments(input));
    expect(codexResumeArguments({ ...input, sessionRef: 's', model: 'default' })).toEqual(
      codexResumeArguments({ ...input, sessionRef: 's' }),
    );
    expect(codexStartArguments(input)).not.toContain('--model');
  });

  it('refuses a model outside the Provider list in both commands', () => {
    const input = { workingCopy: '/w', sandbox: 'workspace-write', files } as const;
    for (const model of ['opus', 'gpt-5', '-c', 'gpt-6-luna --sandbox danger-full-access']) {
      expect(() => codexStartArguments({ ...input, model })).toThrow(ModelNotAllowedError);
      expect(() => codexResumeArguments({ ...input, sessionRef: 's', model })).toThrow(
        ModelNotAllowedError,
      );
    }
  });

  it('never uses ephemeral mode, the repository check bypass or a dangerous option', () => {
    const all = [
      ...codexStartArguments({ workingCopy: '/w', sandbox: 'workspace-write', files }),
      ...codexResumeArguments({
        workingCopy: '/w',
        sandbox: 'workspace-write',
        files,
        sessionRef: 's',
      }),
    ];
    for (const option of all) {
      expect(option).not.toMatch(
        /^--(ephemeral|skip-git-repo-check|dangerously|approve-for-me|ignore-)/,
      );
    }
  });

  it("keeps the step's files in the Run's directory, outside the Working copy", () => {
    expect(files).toEqual({
      dir: '/data/runs/r1/codex',
      schemaFile: '/data/runs/r1/codex/result.schema.json',
      resultFile: '/data/runs/r1/codex/result.json',
      promptFile: '/data/runs/r1/codex/prompt.md',
      answerFile: '/data/runs/r1/codex/answer.md',
      tmpDir: '/data/runs/r1/tmp',
    });
  });
});

describe('the Codex prompt', () => {
  it('passes the agent definition, the note that Studio commits and delivers, then the Task', () => {
    const prompt = codexPrompt(BASE_RULES.text, 'Add a health check');

    expect(prompt.startsWith(BASE_RULES.text.trimEnd())).toBe(true);
    expect(prompt).toContain('You cannot commit');
    expect(prompt).toContain('AI Agent Studio\ncommits them on the Run branch');
    expect(prompt.trimEnd().endsWith("# The operator's Task\n\nAdd a health check")).toBe(true);
  });

  it('states the sandbox mode in force', () => {
    expect(sandboxNotice('workspace-write')).toBe(
      "Codex sandbox: workspace-write, network on (set by the agent worker's configuration).",
    );
  });
});

describe('the Codex environment', () => {
  it('passes only the allowlist: no API key, no Codex override, no worker secret', () => {
    const env = codexEnvironment({
      base: {
        PATH: '/usr/bin',
        HOME: '/home/agent',
        DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
        OPENAI_API_KEY: 'test-only-openai-key',
        CODEX_API_KEY: 'test-only-codex-key',
        OPENAI_BASE_URL: 'https://proxy.example.test',
        CODEX_HOME: '/tmp/elsewhere',
        CODEX_CLI_ENABLED: 'true',
        STUDIO_WORKER_TOKEN: 'test-only-worker-token',
        STUDIO_AGENT_GITHUB_TOKEN: 'test-only-agent-token',
      },
      tmpDir: '/data/runs/r1/tmp',
      composeProjectName: 'studio-run-0b8e5c2d1f3a',
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
      TERM: 'dumb',
      TMPDIR: '/data/runs/r1/tmp',
      COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a',
    });
  });

  it('never hands the system Docker socket to the agent', () => {
    expect(
      codexEnvironment({ base: { DOCKER_HOST: 'unix:///var/run/docker.sock/' } }),
    ).not.toHaveProperty('DOCKER_HOST');
  });
});

describe('the Codex version check', () => {
  it.each([
    ['codex-cli 0.169.0\n', '0.169.0'],
    ['codex-cli 0.179.12', '0.179.12'],
    ['0.170.1', '0.170.1'],
  ])('accepts %j', (output, version) => {
    expect(checkCodexVersion(output)).toEqual({ ok: true, version });
  });

  it.each(['codex-cli 0.168.9', 'codex-cli 0.180.0', 'codex-cli 1.0.0'])(
    'refuses %j with the supported range',
    (output) => {
      const check = checkCodexVersion(output);
      expect(check.ok).toBe(false);
      expect(!check.ok && check.reason).toContain('supported: >=0.169.0 <0.180.0');
    },
  );

  it('refuses output without a version', () => {
    expect(checkCodexVersion('').ok).toBe(false);
    expect(checkCodexVersion('error: unknown flag').ok).toBe(false);
    // A pre-release is not a tested version.
    expect(checkCodexVersion('codex-cli 0.169.0-alpha.1').ok).toBe(false);
  });
});
