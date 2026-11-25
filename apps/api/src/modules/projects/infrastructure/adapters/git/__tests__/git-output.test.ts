import { describe, expect, it } from 'vitest';
import {
  classifyGitFailure,
  classifyPushFailure,
  isOutOfMemory,
  MAX_DETAIL_LENGTH,
  redactGitOutput,
} from '../git-output.js';

describe('redactGitOutput', () => {
  it('removes credentials embedded in URLs', () => {
    const output = "fatal: unable to access 'https://user:hunter2@git.example.test/o/r.git/': 403";
    const redacted = redactGitOutput(output);
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('git.example.test/o/r.git');
  });

  it('removes private key material', () => {
    const output = [
      'Load key "/tmp/k": invalid format',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const redacted = redactGitOutput(output);
    expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
    expect(redacted).toContain('<private key>');
  });

  it('removes absolute paths but keeps URL paths', () => {
    const output = [
      "fatal: '/var/lib/studio/clones/3f2b.git' does not appear to be a git repository",
      'Warning: Identity file /tmp/studio-git-AbC123/id not accessible',
      "Cloning into bare repository '/home/op/data/clones/x.git'...",
      "fatal: repository 'https://github.com/owner/missing.git/' not found",
      'ssh://git@git.example.test:2222/srv/git/repo.git',
    ].join('\n');
    const redacted = redactGitOutput(output);
    expect(redacted).not.toMatch(/\/var\/lib|\/tmp\/studio|\/home\/op/);
    expect(redacted).toContain('https://github.com/owner/missing.git/');
    expect(redacted).toContain('git.example.test:2222/srv/git/repo.git');
    expect(redacted.match(/<path>/g)).toHaveLength(3);
  });

  it('removes absolute paths in file URLs', () => {
    const redacted = redactGitOutput(
      'fatal: could not read from file:///tmp/studio-fixtures/app.git',
    );
    expect(redacted).not.toContain('/tmp/studio-fixtures');
    expect(redacted).toContain('file://<path>');
  });

  it('caps the length, keeping the end of the output', () => {
    const redacted = redactGitOutput(`${'x'.repeat(5_000)}\nfatal: the end`);
    expect(redacted.length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH + 1);
    expect(redacted.endsWith('fatal: the end')).toBe(true);
  });
});

describe('classifyGitFailure', () => {
  it.each([
    [
      'Host key verification failed.\r\nfatal: Could not read from remote repository.',
      'host_key_mismatch',
    ],
    [
      'No ED25519 host key is known for [studio-remote]:22 and you have requested strict checking.\nHost key verification failed.',
      'host_key_mismatch',
    ],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host_key_mismatch'],
    ['git@git.example.test: Permission denied (publickey).', 'auth_failed'],
    [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'auth_failed',
    ],
    [
      "fatal: unable to access 'https://x.test/r/': The requested URL returned error: 403",
      'auth_failed',
    ],
    ['ssh: Could not resolve hostname nope.invalid: Name or service not known', 'host_unreachable'],
    ['ssh: connect to host 10.0.0.1 port 22: Connection refused', 'host_unreachable'],
    [
      "fatal: unable to access 'https://nope.invalid/r/': Could not resolve host: nope.invalid",
      'host_unreachable',
    ],
    // http.followRedirects=false: Git's message for a redirect it did not follow.
    [
      "fatal: unable to access 'https://git.example.test/r.git/': The requested URL returned error: 301",
      'redirect_refused',
    ],
    [
      "fatal: unable to access 'https://git.example.test/r.git/': The requested URL returned error: 307",
      'redirect_refused',
    ],
    ["fatal: couldn't find remote ref refs/heads/nope", 'branch_not_found'],
    [
      'ERROR: Repository not found.\nfatal: Could not read from remote repository.',
      'repository_not_found',
    ],
    ["fatal: '/srv/git/nope.git' does not appear to be a git repository", 'repository_not_found'],
    ["fatal: repository 'https://github.com/o/missing/' not found", 'repository_not_found'],
    ['error: something nobody expected', 'unknown'],
    ['', 'unknown'],
  ])('maps %j to %s', (stderr, reason) => {
    expect(classifyGitFailure(stderr)).toBe(reason);
  });
});

describe('isOutOfMemory', () => {
  it.each([
    'fatal: Out of memory, malloc failed (tried to allocate 60000001 bytes)',
    'fatal: mmap failed, check sys.vm.max_map_count and/or RLIMIT_DATA: Cannot allocate memory',
    'fatal: packfile ./objects/pack/pack-1.pack cannot be mapped, check sys.vm.max_map_count: Cannot allocate memory',
    'error: git upload-pack: git-pack-objects died with error.\nfatal: Out of memory, malloc failed (tried to allocate 1 bytes)',
    'fork: Cannot allocate memory',
    'xmalloc: out of memory (allocating 4096 bytes)',
    'fatal: unable to create thread: Resource temporarily unavailable',
    'error: cannot create async thread: Resource temporarily unavailable',
  ])('recognises the out-of-memory output %j', (stderr) => {
    expect(isOutOfMemory(stderr)).toBe(true);
  });

  it.each([
    'fatal: Authentication failed for the remote',
    'remote: fatal: mmap failed, check sys.vm.max_map_count and/or RLIMIT_DATA: Cannot allocate memory',
    'remote: fatal: Out of memory, malloc failed (tried to allocate 1 bytes)',
    'remote: xmalloc: out of memory\nremote: fatal: unable to create thread: Resource temporarily unavailable',
    "fatal: couldn't find remote ref refs/heads/fix/xmalloc",
    "fatal: repository 'https://h/xmalloc.git/' not found",
    "fatal: unable to access 'https://h/mmap failed.git/': Could not resolve host",
    "fatal: unable to access 'https://git.example.test/': Could not resolve host",
    "fatal: couldn't find remote ref refs/heads/main",
    '',
  ])('leaves other failures alone: %j', (stderr) => {
    expect(isOutOfMemory(stderr)).toBe(false);
  });
});

describe('classifyPushFailure', () => {
  const rejected = (reason: string) =>
    `!\trefs/heads/x:refs/heads/dev\t[rejected] (${reason})\nDone\n`;

  it.each(['fetch first', 'non-fast-forward', 'stale info'])(
    'reads a rejected ref (%s) as the remote having moved',
    (reason) => {
      expect(classifyPushFailure(rejected(reason), 'error: failed to push some refs')).toBe(
        'moved',
      );
    },
  );

  it('reads the rejection text of a moved remote when no porcelain line arrived', () => {
    const stderr = [
      ' ! [rejected]        abc -> dev (fetch first)',
      'error: failed to push some refs to ssh://git@host/r.git',
      'hint: Updates were rejected because the remote contains work that you do not have locally.',
    ].join('\n');
    expect(classifyPushFailure('', stderr)).toBe('moved');
  });

  it.each([
    [
      'a read-only key',
      'ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.',
    ],
    [
      'a key without write access',
      'ERROR: Write access to repository not granted.\nfatal: Could not read from remote repository.',
    ],
    [
      'a denied account',
      'remote: Permission to o/r.git denied to deploy-key.\nfatal: unable to access: The requested URL returned error: 403',
    ],
    ['a refused push', 'remote: GitLab: You are not allowed to push code to this project.'],
    [
      'a protected branch',
      'remote: error: GH006: Protected branch update failed for refs/heads/dev.',
    ],
    ['a hidden ref', ' ! [remote rejected] abc -> dev (deny updating a hidden ref)'],
    ['a declined hook', ' ! [remote rejected] abc -> dev (pre-receive hook declined)'],
    [
      'a refused key',
      'git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    ],
  ])('reads %s as a refused write', (_name, stderr) => {
    expect(classifyPushFailure('', stderr)).toBe('write_refused');
  });

  it('reads a remote rejection in the porcelain output as a refused write', () => {
    expect(
      classifyPushFailure('!\tabc:refs/heads/dev\t[remote rejected] (hook declined)\n', ''),
    ).toBe('write_refused');
  });

  it('keeps the other reasons of a failed Git command', () => {
    expect(classifyPushFailure('', 'ssh: Could not resolve hostname git.example.test')).toBe(
      'host_unreachable',
    );
    expect(classifyPushFailure('', 'Host key verification failed.')).toBe('host_key_mismatch');
    expect(classifyPushFailure('', 'something else')).toBe('unknown');
  });

  it('does not take remote text for a rejection Git did not report', () => {
    expect(classifyPushFailure('', 'remote: the moved remote is not rejected by fate')).toBe(
      'unknown',
    );
  });
});
