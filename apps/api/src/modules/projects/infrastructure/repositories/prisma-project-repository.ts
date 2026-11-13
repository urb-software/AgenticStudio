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
  type Repository,
  type RepositoryFailure,
  type RepositoryFailureCode,
  type RepositoryState,
} from '../../domain/entities/repository.js';
import {
  type ConnectRepositoryRecord,
  ProjectNameTakenError,
  ProjectNotFoundError,
  type ProjectRepository,
  RemoteAlreadyConnectedError,
  RepositoryAlreadyConnectedError,
} from '../../domain/repositories/project-repository.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';

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
}

function isState(value: string): value is RepositoryState {
  return (REPOSITORY_STATES as readonly string[]).includes(value);
}

function isFailureCode(value: string): value is RepositoryFailureCode {
  return (REPOSITORY_FAILURE_CODES as readonly string[]).includes(value);
}

/** Maps a row; the CHECK constraints guarantee the state and the failure fields agree. */
function toRepository(row: RepositoryRow): Repository {
  if (!isState(row.state)) {
    throw new Error(`Unexpected repository state in the database: ${row.state}`);
  }
  const code = row.failureCode;
  return {
    projectId: row.projectId,
    url: row.url,
    integrationBranch: row.integrationBranch,
    state: row.state,
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
  };
}

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
 * Repository transition is a conditional update on the current state.
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

  async findRepository(projectId: string): Promise<Repository | null> {
    const row = await this.db.repository.findUnique({
      where: { projectId },
      select: REPOSITORY_FIELDS,
    });
    return row ? toRepository(row) : null;
  }

  async beginConnect(record: ConnectRepositoryRecord): Promise<Repository> {
    const project = await this.db.project.findUnique({
      where: { id: record.projectId },
      select: { id: true },
    });
    if (!project) throw new ProjectNotFoundError();

    const attempt = {
      url: record.url,
      urlNormalized: record.identity,
      integrationBranch: record.integrationBranch,
      state: 'connecting',
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

  private async transition(
    projectId: string,
    data: Parameters<DatabaseClient['repository']['updateMany']>[0]['data'],
  ): Promise<boolean> {
    const { count } = await this.db.repository.updateMany({
      where: { projectId, state: 'connecting' },
      data,
    });
    return count === 1;
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
