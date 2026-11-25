import { vi } from 'vitest';
import { GitUnsupportedPlatformError, type RepositoryGit } from '../repository-git.js';

const OPERATIONS = [
  'removeClone',
  'inspectRemote',
  'clone',
  'fetch',
  'readBranchCommit',
  'scanHostKey',
  'isPathTracked',
  'fetchForReview',
  'mergeDiff',
  'readFileAtCommit',
  'listTreeAtCommit',
  'readFilesAtCommit',
  'readBlobsAtCommit',
  'blobIdsAtCommit',
  'archiveCommit',
] as const;

/**
 * A scripted {@link RepositoryGit} for handler tests: the branch exists and the clone
 * succeeds unless a test overrides a method (`git.clone.mockRejectedValueOnce(...)`).
 */
export class FakeRepositoryGit implements RepositoryGit {
  supported = true;

  assertSupported(): void {
    if (!this.supported) throw new GitUnsupportedPlatformError('win32');
  }

  inspectRemote = vi.fn<RepositoryGit['inspectRemote']>(() =>
    Promise.resolve({ defaultBranch: 'main', branchExists: true }),
  );

  clone = vi.fn<RepositoryGit['clone']>(() => Promise.resolve({ commit: 'a'.repeat(40) }));

  fetch = vi.fn<RepositoryGit['fetch']>(() => Promise.reject(new Error('not used')));

  readBranchCommit = vi.fn<RepositoryGit['readBranchCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  isPathTracked = vi.fn<RepositoryGit['isPathTracked']>(() => Promise.resolve(false));

  fetchForReview = vi.fn<RepositoryGit['fetchForReview']>(() =>
    Promise.reject(new Error('not used')),
  );

  mergeDiff = vi.fn<RepositoryGit['mergeDiff']>(() => Promise.reject(new Error('not used')));

  readFileAtCommit = vi.fn<RepositoryGit['readFileAtCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  listTreeAtCommit = vi.fn<RepositoryGit['listTreeAtCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  readFilesAtCommit = vi.fn<RepositoryGit['readFilesAtCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  readBlobsAtCommit = vi.fn<RepositoryGit['readBlobsAtCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  blobIdsAtCommit = vi.fn<RepositoryGit['blobIdsAtCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  archiveCommit = vi.fn<RepositoryGit['archiveCommit']>(() =>
    Promise.reject(new Error('not used')),
  );

  removeClone = vi.fn<RepositoryGit['removeClone']>(() => Promise.resolve());

  scanHostKey = vi.fn<RepositoryGit['scanHostKey']>(() => Promise.reject(new Error('not used')));

  get calls(): string[] {
    return OPERATIONS.flatMap((name) =>
      this[name].mock.invocationCallOrder.map((order) => ({ name, order })),
    )
      .sort((a, b) => a.order - b.order)
      .map(({ name }) => name);
  }
}
