import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_FILE_SECRET_OWNER,
  EnvironmentFilePathTrackedError,
  InvalidEnvironmentFileContentError,
  InvalidEnvironmentFilePathError,
} from '../../../domain/entities/environment-file.js';
import { ProjectNotFoundError } from '../../../domain/repositories/project-repository.js';
import { InMemoryEnvironmentFileRepository } from '../../../domain/repositories/__tests__/in-memory-environment-file-repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import {
  GitCloneMissingError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import { GetEnvironmentFileHandler } from '../../get-environment-file/handler.js';
import { GetRunEnvironmentFileHandler } from '../../get-run-environment-file/handler.js';
import { RemoveEnvironmentFileHandler } from '../../remove-environment-file/handler.js';
import { SetEnvironmentFileHandler } from '../handler.js';

// Issue #104: the operator sets, replaces and removes a Project's Environment file; its content
// goes to the secret store and is never returned to the operator. Test values only.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const UNKNOWN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SHA = 'a'.repeat(40);
const CONTENT = 'DB_PASSWORD=test-only-pw-1\nexport API_KEY="test-only-key-2"\n';

describe('Environment file handlers', () => {
  let projects: InMemoryProjectRepository;
  let files: InMemoryEnvironmentFileRepository;
  let secrets: InMemorySecretStore;
  let git: FakeRepositoryGit;
  let set: SetEnvironmentFileHandler;
  let get: GetEnvironmentFileHandler;
  let remove: RemoveEnvironmentFileHandler;
  let snapshot: GetRunEnvironmentFileHandler;

  async function readyRepository() {
    await projects.beginConnect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    await projects.markReady(PROJECT, { headSha: SHA, fetchedAt: new Date() });
  }

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    files = new InMemoryEnvironmentFileRepository();
    secrets = new InMemorySecretStore();
    git = new FakeRepositoryGit();
    set = new SetEnvironmentFileHandler(projects, files, secrets, git);
    get = new GetEnvironmentFileHandler(projects, files);
    remove = new RemoveEnvironmentFileHandler(projects, files, secrets);
    snapshot = new GetRunEnvironmentFileHandler(files, secrets);
  });

  it('stores the content in the secret store and shows only path, size and last change', async () => {
    const info = await set.execute({ projectId: PROJECT, path: '.env', content: CONTENT });

    expect(info).toEqual({ path: '.env', sizeBytes: 60, updatedAt: files.now });
    expect(JSON.stringify(info)).not.toContain('test-only');
    expect([...secrets.values.values()]).toEqual([CONTENT]);
    expect([...secrets.owners.values()]).toEqual([ENVIRONMENT_FILE_SECRET_OWNER]);
    await expect(get.execute(PROJECT)).resolves.toEqual(info);
  });

  it('counts the size in UTF-8 bytes', async () => {
    const info = await set.execute({ projectId: PROJECT, path: '.env', content: 'É=ü\n' });
    expect(info.sizeBytes).toBe(6);
  });

  it('replaces the file and deletes the replaced content from the secret store', async () => {
    await set.execute({ projectId: PROJECT, path: '.env', content: CONTENT });

    const info = await set.execute({
      projectId: PROJECT,
      path: 'config/test.env',
      content: 'X=test-only-3\n',
    });

    expect(info.path).toBe('config/test.env');
    expect([...secrets.values.values()]).toEqual(['X=test-only-3\n']);
    await expect(snapshot.forProject(PROJECT)).resolves.toEqual({
      path: 'config/test.env',
      content: 'X=test-only-3\n',
    });
  });

  it('removes the file and its stored content; removing again changes nothing', async () => {
    await set.execute({ projectId: PROJECT, path: '.env', content: CONTENT });

    await remove.execute(PROJECT);
    await remove.execute(PROJECT);

    expect(secrets.values.size).toBe(0);
    await expect(get.execute(PROJECT)).resolves.toBeNull();
    await expect(snapshot.forProject(PROJECT)).resolves.toBeNull();
  });

  it('answers unknown projects with ProjectNotFoundError, storing nothing', async () => {
    await expect(
      set.execute({ projectId: UNKNOWN, path: '.env', content: CONTENT }),
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(
      set.execute({ projectId: 'not-a-uuid', path: '.env', content: CONTENT }),
    ).rejects.toThrow(ProjectNotFoundError);
    await expect(get.execute(UNKNOWN)).rejects.toThrow(ProjectNotFoundError);
    await expect(remove.execute(UNKNOWN)).rejects.toThrow(ProjectNotFoundError);
    expect(secrets.values.size).toBe(0);
  });

  it.each(['../.env', '/etc/env', '.git/config', 'a//b', 'a\\b', ''])(
    'refuses the path %j, saying why, storing nothing',
    async (path) => {
      await expect(set.execute({ projectId: PROJECT, path, content: CONTENT })).rejects.toThrow(
        InvalidEnvironmentFilePathError,
      );
      expect(secrets.values.size).toBe(0);
    },
  );

  it('refuses content over 64 KiB or that is not valid UTF-8, never quoting it', async () => {
    const big = `K=${'v'.repeat(64 * 1024)}`;
    const error = await set
      .execute({ projectId: PROJECT, path: '.env', content: big })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidEnvironmentFileContentError);
    expect((error as Error).message).not.toContain('vvvv');
    await expect(
      set.execute({ projectId: PROJECT, path: '.env', content: 'K=\uD800' }),
    ).rejects.toThrow(InvalidEnvironmentFileContentError);
    expect(secrets.values.size).toBe(0);
  });

  it("refuses a path tracked at the integration branch's current commit when the Clone is ready", async () => {
    await readyRepository();
    git.isPathTracked.mockResolvedValueOnce(true);

    await expect(
      set.execute({ projectId: PROJECT, path: 'README.md', content: CONTENT }),
    ).rejects.toThrow(EnvironmentFilePathTrackedError);

    expect(git.isPathTracked).toHaveBeenCalledWith(PROJECT, SHA, 'README.md');
    expect(secrets.values.size).toBe(0);
  });

  it('accepts an untracked path when the Clone is ready', async () => {
    await readyRepository();
    await expect(
      set.execute({ projectId: PROJECT, path: '.env', content: CONTENT }),
    ).resolves.toMatchObject({ path: '.env' });
    expect(git.isPathTracked).toHaveBeenCalledWith(PROJECT, SHA, '.env');
  });

  it('skips the tracked check without a ready Clone, off Linux or when the Clone is gone (the worker re-checks)', async () => {
    await set.execute({ projectId: PROJECT, path: '.env', content: CONTENT });
    expect(git.isPathTracked).not.toHaveBeenCalled();

    await readyRepository();
    git.isPathTracked.mockRejectedValueOnce(new GitUnsupportedPlatformError('win32'));
    await set.execute({ projectId: PROJECT, path: '.env', content: CONTENT });
    git.isPathTracked.mockRejectedValueOnce(new GitCloneMissingError());
    await set.execute({ projectId: PROJECT, path: '.env', content: CONTENT });
    expect(secrets.values.size).toBe(1);
  });

  it('deletes the new content again when saving the file fails', async () => {
    files.save = () => Promise.reject(new Error('database down'));

    await expect(
      set.execute({ projectId: PROJECT, path: '.env', content: CONTENT }),
    ).rejects.toThrow('database down');
    expect(secrets.values.size).toBe(0);
  });
});
