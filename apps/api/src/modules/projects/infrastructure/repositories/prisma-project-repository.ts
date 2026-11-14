import { isUniqueConstraintViolation } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { Project } from '../../domain/entities/project.js';
import {
  REPOSITORY_FAILURE_CODES,
  REPOSITORY_STATES,
  type RepositoryConnection,
  type RepositoryFailure,
  type RepositoryFailureCode,
  type RepositoryState,
} from '../../domain/entities/repository.js';
import {
  type ConnectRepositoryRecord,
  NoRepositoryError,
  NoUsableCloneError,
  ProjectNameTakenError,
  ProjectNotFoundError,
  type ProjectRepository,
  RemoteAlreadyConnectedError,
  RepositoryAlreadyConnectedError,
  RepositoryBusyError,
} from '../../domain/repositories/project-repository.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';
import { hostKeyFingerprint } from '../../domain/value-objects/ssh-key.js';

const PROJECT_FIELDS = { id: true, name: true, createdAt: true } as const;

const REPOSITORY_FIELDS = {
  projectId: true,
  url: true,
  integrationBranch: true,
  state: true,
  headSha: true,
  lastFetchedAt: true,
  failureCode: true,
  failureDetail: true,
  failureRemoteDefaultBranch: true,
  publicKey: true,
  deployKeySecretId: true,
  pinnedHostKey: true,
  pendingHostKey: true,
} as const;

interface RepositoryRow {
  projectId: string;
  url: string;
  integrationBranch: string;
  state: string;
  headSha: string | null;
  lastFetchedAt: Date | null;
  failureCode: string | null;
  failureDetail: string | null;
  failureRemoteDefaultBranch: string | null;
  publicKey: string | null;
  deployKeySecretId: string | null;
  pinnedHostKey: string | null;
  pendingHostKey: string | null;
}

function isState(value: string): value is RepositoryState {
  return (REPOSITORY_STATES as readonly string[]).includes(value);
}

function isFailureCode(value: string): value is RepositoryFailureCode {
  return (REPOSITORY_FAILURE_CODES as readonly string[]).includes(value);
}

/** Maps a row; the CHECK constraints guarantee the state and the failure fields agree. */
function toRepository(row: RepositoryRow): RepositoryConnection {
  if (!isState(row.state)) {
    throw new Error(`Unexpected repository state in the database: ${row.state}`);
  }
  const code = row.failureCode;
  const shownHostKey = row.pendingHostKey ?? row.pinnedHostKey;
  return {
    projectId: row.projectId,
    url: row.url,
    integrationBranch: row.integrationBranch,
    state: row.state,
    // The Clone's commit is kept exactly while a usable Clone exists.
    hasClone: row.headSha !== null,
    headSha: row.headSha,
    lastFetchedAt: row.lastFetchedAt,
    failure:
      row.state === 'failed' && code !== null && isFailureCode(code)
        ? {
            code,
            detail: row.failureDetail ?? '',
            remoteDefaultBranch: row.failureRemoteDefaultBranch,
          }
        : null,
    publicKey: row.publicKey,
    deployKeySecret: row.deployKeySecretId,
    pinnedHostKey: row.pinnedHostKey,
    pendingHostKey: row.pendingHostKey,
    hostKeyFingerprint: shownHostKey === null ? null : hostKeyFingerprint(shownHostKey),
  };
}

const NO_FAILURE = {
  failureCode: null,
  failureDetail: null,
  failureRemoteDefaultBranch: null,
} as const;

/**
 * Where a verification transition applies (`isVerifiable`): an SSH Repository (it has a
 * Deploy key) without a Clone, waiting for its key or host key, or failed (Retry).
 */
const VERIFIABLE = {
  state: { in: ['awaiting_key', 'awaiting_host_key', 'failed'] as string[] },
  deployKeySecretId: { not: null },
  headSha: null,
};

function failureColumns(failure: RepositoryFailure) {
  return {
    state: 'failed',
    failureCode: failure.code,
    failureDetail: failure.detail,
    failureRemoteDefaultBranch: failure.remoteDefaultBranch,
    updatedAt: new Date(),
  };
}

/**
 * PostgreSQL adapter of {@link ProjectRepository}. Unique indexes, not prior reads, decide
 * duplicates: `projects.name_normalized` for names, the `repositories` primary key (one per
 * project) and `repositories.url_normalized` (one project per remote) for Connect. Every
 * Repository transition is a conditional update on the current state, and a usable Clone is
 * recorded by its commit: `head_sha` is set exactly while one exists. Only a `disconnecting`
 * Repository is ever deleted (the last step of a Disconnect).
 */
@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async add(name: ProjectName): Promise<Project> {
    try {
      return await this.db.project.create({
        data: { name: name.value, nameNormalized: name.uniquenessKey },
        select: PROJECT_FIELDS,
      });
    } catch (error) {
      // The only unique constraint of `projects` besides the primary key is on name_normalized.
      if (isUniqueConstraintViolation(error)) {
        throw new ProjectNameTakenError();
      }
      throw error;
    }
  }

  listNewestFirst(): Promise<Project[]> {
    return this.db.project.findMany({
      select: PROJECT_FIELDS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  findById(id: string): Promise<Project | null> {
    return this.db.project.findUnique({ where: { id }, select: PROJECT_FIELDS });
  }

  async findRepository(projectId: string): Promise<RepositoryConnection | null> {
    const row = await this.db.repository.findUnique({
      where: { projectId },
      select: REPOSITORY_FIELDS,
    });
    return row ? toRepository(row) : null;
  }

  async beginConnect(record: ConnectRepositoryRecord): Promise<RepositoryConnection> {
    const project = await this.db.project.findUnique({
      where: { id: record.projectId },
      select: { id: true },
    });
    if (!project) throw new ProjectNotFoundError();

    const attempt = {
      url: record.url,
      urlNormalized: record.identity,
      integrationBranch: record.integrationBranch,
      state: record.deployKey ? 'awaiting_key' : 'connecting',
      publicKey: record.deployKey?.publicKey ?? null,
      deployKeySecretId: record.deployKey?.secretRef ?? null,
      pinnedHostKey: record.deployKey ? (record.pinnedHostKey ?? null) : null,
      pendingHostKey: null,
      headSha: null,
      lastFetchedAt: null,
      failureCode: null,
      failureDetail: null,
      failureRemoteDefaultBranch: null,
      updatedAt: new Date(),
    };
    try {
      // Retry: only a failed Repository is replaced, in one conditional statement.
      const replaced = await this.db.repository.updateMany({
        where: { projectId: record.projectId, state: 'failed' },
        data: attempt,
      });
      if (replaced.count === 0) {
        await this.db.repository.create({ data: { projectId: record.projectId, ...attempt } });
      }
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw await this.conflictFor(record);
      }
      throw error;
    }
    const stored = await this.findRepository(record.projectId);
    if (!stored) throw new Error('The repository vanished right after it was stored.');
    return stored;
  }

  async awaitHostKey(projectId: string, hostKey: string): Promise<RepositoryConnection | null> {
    const { count } = await this.db.repository.updateMany({
      where: { projectId, ...VERIFIABLE },
      data: {
        state: 'awaiting_host_key',
        pendingHostKey: hostKey,
        ...NO_FAILURE,
        updatedAt: new Date(),
      },
    });
    return count === 1 ? this.findRepository(projectId) : null;
  }

  async beginVerifiedClone(
    projectId: string,
    confirmed: { pendingHostKey: string } | null,
  ): Promise<RepositoryConnection | null> {
    const { count } = await this.db.repository.updateMany({
      where: confirmed
        ? {
            projectId,
            ...VERIFIABLE,
            state: 'awaiting_host_key',
            pendingHostKey: confirmed.pendingHostKey,
          }
        : { projectId, ...VERIFIABLE },
      data: {
        state: 'connecting',
        pendingHostKey: null,
        ...(confirmed ? { pinnedHostKey: confirmed.pendingHostKey } : {}),
        ...NO_FAILURE,
        updatedAt: new Date(),
      },
    });
    return count === 1 ? this.findRepository(projectId) : null;
  }

  async failVerification(projectId: string, failure: RepositoryFailure): Promise<boolean> {
    const { count } = await this.db.repository.updateMany({
      where: { projectId, ...VERIFIABLE },
      data: { ...failureColumns(failure), pendingHostKey: null },
    });
    return count === 1;
  }

  async forgetDeployKey(projectId: string): Promise<boolean> {
    const { count } = await this.db.repository.updateMany({
      where: { projectId, state: 'disconnecting' },
      data: {
        publicKey: null,
        deployKeySecretId: null,
        pinnedHostKey: null,
        pendingHostKey: null,
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  markReady(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean> {
    return this.transition(projectId, {
      state: 'ready',
      headSha: clone.headSha,
      lastFetchedAt: clone.fetchedAt,
      failureCode: null,
      failureDetail: null,
      failureRemoteDefaultBranch: null,
      updatedAt: new Date(),
    });
  }

  markFailed(projectId: string, failure: RepositoryFailure): Promise<boolean> {
    return this.transition(projectId, failureColumns(failure));
  }

  async failAllConnecting(failure: RepositoryFailure): Promise<number> {
    const { count } = await this.db.repository.updateMany({
      where: { state: 'connecting' },
      data: failureColumns(failure),
    });
    return count;
  }

  async beginFetch(projectId: string): Promise<RepositoryConnection> {
    // One conditional statement: only a Repository with a usable Clone that is not busy.
    const { count } = await this.db.repository.updateMany({
      where: { projectId, state: { in: ['ready', 'failed'] }, headSha: { not: null } },
      data: { state: 'fetching', ...NO_FAILURE, updatedAt: new Date() },
    });
    const stored = await this.findRepository(projectId);
    if (count === 1 && stored) return stored;
    throw await this.fetchRefusal(projectId, stored);
  }

  markFetched(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean> {
    return this.transition(
      projectId,
      {
        state: 'ready',
        headSha: clone.headSha,
        lastFetchedAt: clone.fetchedAt,
        ...NO_FAILURE,
        updatedAt: new Date(),
      },
      'fetching',
    );
  }

  markFetchFailed(
    projectId: string,
    failure: RepositoryFailure,
    { cloneKept }: { cloneKept: boolean },
  ): Promise<boolean> {
    return this.transition(
      projectId,
      {
        ...failureColumns(failure),
        // The Clone was removed: no usable Clone, so neither its commit nor its fetch time.
        ...(cloneKept ? {} : { headSha: null, lastFetchedAt: null }),
      },
      'fetching',
    );
  }

  async failAllFetching(failure: RepositoryFailure): Promise<number> {
    const { count } = await this.db.repository.updateMany({
      where: { state: 'fetching' },
      data: failureColumns(failure),
    });
    return count;
  }

  async beginDisconnect(projectId: string): Promise<RepositoryConnection> {
    // Any state, one statement: the failure and the Clone's commit go (the Clone is removed).
    const { count } = await this.db.repository.updateMany({
      where: { projectId },
      data: {
        state: 'disconnecting',
        headSha: null,
        lastFetchedAt: null,
        pendingHostKey: null,
        ...NO_FAILURE,
        updatedAt: new Date(),
      },
    });
    const stored = count === 1 ? await this.findRepository(projectId) : null;
    if (stored) return stored;
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    throw project ? new NoRepositoryError() : new ProjectNotFoundError();
  }

  async deleteDisconnecting(projectId: string): Promise<boolean> {
    const { count } = await this.db.repository.deleteMany({
      where: { projectId, state: 'disconnecting' },
    });
    return count === 1;
  }

  async listDisconnecting(): Promise<string[]> {
    const rows = await this.db.repository.findMany({
      where: { state: 'disconnecting' },
      select: { projectId: true },
      orderBy: { updatedAt: 'asc' },
    });
    return rows.map((row) => row.projectId);
  }

  private async transition(
    projectId: string,
    data: Parameters<DatabaseClient['repository']['updateMany']>[0]['data'],
    from: 'connecting' | 'fetching' = 'connecting',
  ): Promise<boolean> {
    const { count } = await this.db.repository.updateMany({
      where: { projectId, state: from },
      data,
    });
    return count === 1;
  }

  /** Why a fetch could not start, read after the conditional update changed nothing. */
  private async fetchRefusal(
    projectId: string,
    repository: RepositoryConnection | null,
  ): Promise<Error> {
    if (!repository) {
      const project = await this.db.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      return project ? new NoRepositoryError() : new ProjectNotFoundError();
    }
    if (repository.state === 'failed' && !repository.hasClone) return new NoUsableCloneError();
    return new RepositoryBusyError();
  }

  /**
   * Which unique constraint a Connect hit: the project already has a Repository (the primary
   * key, also when a concurrent connect won), or another project holds the remote.
   */
  private async conflictFor(record: ConnectRepositoryRecord): Promise<Error> {
    const owner = await this.db.repository.findUnique({
      where: { urlNormalized: record.identity },
      select: { projectId: true, project: { select: { name: true } } },
    });
    if (owner && owner.projectId !== record.projectId) {
      return new RemoteAlreadyConnectedError(owner.project.name);
    }
    return new RepositoryAlreadyConnectedError();
  }
}
