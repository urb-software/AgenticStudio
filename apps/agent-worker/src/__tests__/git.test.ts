import { describe, expect, it } from 'vitest';
import {
  builtInMergeDriver,
  GitRunner,
  driverOverrides,
  GIT_HARDENING,
  gitBaseEnvironment,
  maskCredentials,
  SAFE_DIFF_FLAGS,
  WORKING_COPY_HARDENING,
} from '../git.js';

// What the worker's Git commands always carry, and what its log never shows.
describe('maskCredentials', () => {
  it.each([
    ['https://user:secret@host.test/repo.git', 'https://***@host.test/repo.git'],
    ['https://user:p@ss@host.test/repo.git', 'https://***@host.test/repo.git'],
    ['ssh://git@host.test/repo.git', 'ssh://***@host.test/repo.git'],
    [
      "fatal: unable to access 'https://x:y@h.test/r/': 403",
      "fatal: unable to access 'https://***@h.test/r/': 403",
    ],
  ])('masks the whole user information of %s', (text, masked) => {
    expect(maskCredentials(text)).toBe(masked);
  });

  it('leaves text without user information alone', () => {
    expect(maskCredentials('https://host.test/repo.git and agent@example.test')).toBe(
      'https://host.test/repo.git and agent@example.test',
    );
  });
});

describe('GIT_HARDENING', () => {
  it('runs no hooks, follows no redirect and accepts no packfile URIs', () => {
    expect(GIT_HARDENING).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'http.followRedirects=false',
        'fetch.uriProtocols=',
        'submodule.recurse=false',
      ]),
    );
  });
});

describe('gitBaseEnvironment', () => {
  // Fake values, only to see what is passed on.
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    TMPDIR: '/tmp/agent',
    SSH_AUTH_SOCK: '/run/agent.sock',
    HTTPS_PROXY: 'http://proxy.test:3128',
    https_proxy: 'http://proxy.test:3128',
    NO_PROXY: 'localhost',
    STUDIO_WORKER_TOKEN: 'fake-worker-token',
    STUDIO_AGENT_GITHUB_TOKEN: 'fake-github-token',
    ANTHROPIC_API_KEY: 'fake-provider-key',
    GIT_DIR: '/elsewhere',
    LANG: 'en_US.UTF-8',
  };

  it.each(['working-copy', 'cache'] as const)(
    'keeps only PATH, HOME and TMPDIR for a %s command',
    (scope) => {
      expect(gitBaseEnvironment(source, scope)).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/agent',
        TMPDIR: '/tmp/agent',
      });
    },
  );

  it('keeps the SSH agent and the proxy variables for a command that reaches a remote', () => {
    expect(gitBaseEnvironment(source, 'remote')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/agent',
      TMPDIR: '/tmp/agent',
      SSH_AUTH_SOCK: '/run/agent.sock',
      HTTPS_PROXY: 'http://proxy.test:3128',
      https_proxy: 'http://proxy.test:3128',
      NO_PROXY: 'localhost',
    });
  });

  it('leaves out a variable that is not set', () => {
    expect(gitBaseEnvironment({ PATH: '/bin' }, 'remote')).toEqual({ PATH: '/bin' });
  });
});

describe('Working copy hardening', () => {
  it('overrides every program a repository configuration could name', () => {
    expect(Object.fromEntries(WORKING_COPY_HARDENING)).toEqual({
      'diff.external': '',
      'core.pager': 'cat',
      'core.editor': 'true',
      'sequence.editor': 'true',
      'gpg.program': 'false',
      'gpg.openpgp.program': 'false',
      'gpg.x509.program': 'false',
      'gpg.ssh.program': 'false',
      'core.sshCommand': 'false',
      'credential.helper': '',
      'core.askPass': '',
      'core.attributesFile': '/dev/null',
      'uploadpack.packObjectsHook': '',
      'core.alternateRefsCommand': '',
      'diff.ignoreSubmodules': 'all',
      'status.submoduleSummary': 'false',
    });
  });

  it('turns off external diff and textconv for a diff', () => {
    expect(SAFE_DIFF_FLAGS).toEqual(['--no-ext-diff', '--no-textconv']);
  });
});

describe('driverOverrides', () => {
  const merge = 'built-in-merge';

  it('empties the filter commands of every named filter and makes none required', () => {
    expect(
      Object.fromEntries(driverOverrides(['filter.evil.clean', 'filter.x.y.smudge'], merge)),
    ).toEqual({
      'filter.evil.clean': '',
      'filter.evil.smudge': '',
      'filter.evil.process': '',
      'filter.evil.required': 'false',
      'filter.x.y.clean': '',
      'filter.x.y.smudge': '',
      'filter.x.y.process': '',
      'filter.x.y.required': 'false',
    });
  });

  it('empties the external diff and textconv of a named diff driver', () => {
    expect(Object.fromEntries(driverOverrides(['diff.pdf.textconv'], merge))).toEqual({
      'diff.pdf.command': '',
      'diff.pdf.textconv': '',
    });
    expect(Object.fromEntries(driverOverrides(['diff.pdf.command'], merge))).toEqual({
      'diff.pdf.command': '',
      'diff.pdf.textconv': '',
    });
  });

  it('replaces the command of a named merge driver', () => {
    expect(driverOverrides(['merge.evil.driver'], merge)).toEqual([['merge.evil.driver', merge]]);
  });

  it('ignores settings that name no program, and a name that holds an equals sign', () => {
    expect(
      driverOverrides(['diff.pdf.binary', 'merge.evil.name', 'core.editor', 'user'], merge),
    ).toEqual([]);
    expect(driverOverrides(['filter.a=b.clean'], merge)).toContainEqual(['filter.a=b.clean', '']);
  });
});

describe('builtInMergeDriver', () => {
  it('runs Git own text merge through the same binary, quoted', () => {
    expect(builtInMergeDriver('git')).toBe(
      "'git' merge-file --marker-size=%L -L %X -L %S -L %Y %A %O %B",
    );
    expect(builtInMergeDriver("/opt/it's/git")).toContain(
      `'/opt/it'${String.fromCharCode(92)}''s/git'`,
    );
  });
});

describe('GitRunner.run', () => {
  it.each([[['-c', 'core.pager=x', 'add']], [['--no-optional-locks', 'status']], [[]]])(
    'refuses %j: the subcommand must come first',
    async (args) => {
      const failure = await new GitRunner()
        .run(args, { cwd: '.', timeoutMs: 1000 })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TypeError);
    },
  );
});
