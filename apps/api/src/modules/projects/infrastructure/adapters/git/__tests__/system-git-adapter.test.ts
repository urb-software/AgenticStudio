import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../../../../__tests__/test-config.js';
import { createApp } from '../../../../../../app.js';
import {
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../../../ports/repository-git.js';
import {
  PRODUCTION_GIT_LIMITS,
  SystemGitAdapter,
  systemGitSettings,
} from '../system-git-adapter.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/owner/repo.git';

describe('SystemGitAdapter production wiring', () => {
  it('pins the limits: 10 minutes to clone, 2 minutes to fetch, 2 GiB on disk', () => {
    expect(PRODUCTION_GIT_LIMITS).toEqual({
      cloneTimeoutMs: 600_000,
      fetchTimeoutMs: 120_000,
      maxCloneBytes: 2_147_483_648,
    });
    expect(systemGitSettings(testConfig({ dataDir: '/srv/studio' }))).toEqual({
      dataDir: '/srv/studio',
      allowedTransports: ['ssh', 'https'],
      cloneTimeoutMs: 600_000,
      fetchTimeoutMs: 120_000,
      maxCloneBytes: 2_147_483_648,
      allowPrivateRemotes: false,
    });
  });

  it('refuses loopback and private remotes unless STUDIO_GIT_ALLOW_PRIVATE_REMOTES opts in (Issue #69)', () => {
    expect(systemGitSettings(testConfig()).allowPrivateRemotes).toBe(false);
    expect(
      systemGitSettings(testConfig({ gitAllowPrivateRemotes: true })).allowPrivateRemotes,
    ).toBe(true);
  });

  it('allows exactly ssh and https, plus file only under the test-only setting', () => {
    expect(systemGitSettings(testConfig()).allowedTransports).toEqual(['ssh', 'https']);
    expect(systemGitSettings(testConfig({ gitAllowFileRemotes: true })).allowedTransports).toEqual([
      'ssh',
      'https',
      'file',
    ]);
  });
});

describe('SystemGitAdapter in the API', () => {
  it('is the projects Git port; the API starts and refuses file remotes', async () => {
    const app = await createApp(testConfig(), WITHOUT_QUEUE_WORKERS);
    try {
      await app.init();
      const git = app.get<RepositoryGit>(REPOSITORY_GIT, { strict: false });
      expect(git).toBeInstanceOf(SystemGitAdapter);
      await expect(git.inspectRemote('file:///srv/repo.git', 'main')).rejects.toBeInstanceOf(
        process.platform === 'linux' ? GitRequestRejectedError : GitUnsupportedPlatformError,
      );
    } finally {
      await app.close();
    }
  });
});

describe('SystemGitAdapter on a platform other than Linux', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'studio-git-unsupported-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function adapter(platform: NodeJS.Platform) {
    return new SystemGitAdapter({
      ...systemGitSettings(testConfig({ dataDir: tempRoot })),
      platform,
      tempRoot,
      // Would fail if anything tried to run it.
      gitBinary: join(tempRoot, 'no-such-git'),
    });
  }

  it.each(['win32', 'darwin'] as const)(
    'reports an unsupported platform (%s) as a typed error without running anything',
    async (platform) => {
      const git = adapter(platform);
      const operations = [
        git.inspectRemote(URL, 'main'),
        git.clone(PROJECT_ID, URL, 'main'),
        git.fetch(PROJECT_ID, URL, 'main'),
        git.readBranchCommit(PROJECT_ID, 'main'),
        git.removeClone(PROJECT_ID),
        git.scanHostKey('ssh://git@github.com/owner/repo.git'),
      ];
      for (const operation of operations) {
        await expect(operation).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
      }
      expect(await readdir(tempRoot)).toEqual([]);
    },
  );

  it.each(['win32', 'darwin'] as const)(
    'assertSupported throws the typed error on %s',
    (platform) => {
      expect(() => adapter(platform).assertSupported()).toThrow(GitUnsupportedPlatformError);
    },
  );

  it('assertSupported accepts Linux', () => {
    expect(() => adapter('linux').assertSupported()).not.toThrow();
  });

  it('skips the start-up Git check, so the rest of the API starts', async () => {
    await expect(adapter('win32').onModuleInit()).resolves.toBeUndefined();
  });
});

// Guard against a silent skip: in CI the Linux-only adapter suites must run.
describe('Git adapter test platform', () => {
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs on Linux in CI', () => {
    expect(process.platform).toBe('linux');
  });
});
