import { describe, expect, it } from 'vitest';
import { classifyGitFailure, MAX_DETAIL_LENGTH, redactGitOutput } from '../git-output.js';

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
