import { isUniqueConstraintViolation, type Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  type ConnectAttempt,
  REPOSITORY_STATES,
  RepositoryAlreadyConnectedError,
  type RepositoryChanges,
  RepositoryConnection,
  type RepositoryState,
} from '../../domain/entities/repository.js';
import {
  ProjectNameTakenError,
  ProjectNotFoundError,
  type ProjectRepository,
  RemoteAlreadyConnectedError,
} from '../../domain/repositories/project-repository.js';
import type { Project } from '../../domain/value-objects/project.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';
import {
  REPOSITORY_FAILURE_CODES,
  RepositoryFailure,
  type RepositoryFailureCode,
} from '../../domain/value-objects/repository-failure.js';

/** A change waits for the row lock under pool pressure as a single UPDATE did (as the Run store). */
const LOCKED_TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;

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
  return RepositoryConnection.restore({
    projectId: row.projectId,
    url: row.url,
    integrationBranch: row.integrationBranch,
    state: row.state,
    headSha: row.headSha,
    lastFetchedAt: row.lastFetchedAt,
    failure:
      row.state === 'failed' && code !== null && isFailureCode(code)
        ? RepositoryFailure.of(code, row.failureDetail ?? '', row.failureRemoteDefaultBranch)
        : null,
    publicKey: row.publicKey,
    deployKeySecret: row.deployKeySecretId,
    pinnedHostKey: row.pinnedHostKey,
    pendingHostKey: row.pendingHostKey,
  });
}

/** The columns of the fields a change of the Repository sets (and of the identity, when it is replaced). */
function changedColumns(changes: RepositoryChanges) {
  const { failure, deployKeySecret, ...plain } = changes.fields;
  return {
    ...plain,
    ...(changes.identity === undefined ? {} : { urlNormalized: changes.identity }),
    ...(failure === undefined
      ? {}
      : {
          failureCode: failure?.code ?? null,
          failureDetail: failure?.detail ?? null,
          failureRemoteDefaultBranch: failure?.remoteDefaultBranch ?? null,
        }),
    ...(deployKeySecret === undefined ? {} : { deployKeySecretId: deployKeySecret }),
    updatedAt: new Date(),
  };
}

/** The columns of a new Repository: every stored field and the remote's identity. */
function createColumns(repository: RepositoryConnection, identity: string) {
  const stored = repository.snapshot();
  return {
    projectId: stored.projectId,
    url: stored.url,
    urlNormalized: identity,
    integrationBranch: stored.integrationBranch,
    state: stored.state,
    headSha: stored.headSha,
    lastFetchedAt: stored.lastFetchedAt,
    failureCode: stored.failure?.code ?? null,
    failureDetail: stored.failure?.detail ?? null,
    failureRemoteDefaultBranch: stored.failure?.remoteDefaultBranch ?? null,
    publicKey: stored.publicKey,
    deployKeySecretId: stored.deployKeySecret,
    pinnedHostKey: stored.pinnedHostKey,
    pendingHostKey: stored.pendingHostKey,
    updatedAt: new Date(),
  };
}

/**
 * PostgreSQL adapter of {@link ProjectRepository}. Unique indexes, not prior reads, decide
 * duplicates: `projects.name_normalized` for names, the `repositories` primary key (one per
 * project) and `repositories.url_normalized` (one project per remote) for Connect. Every change
 * of an existing Repository locks its row `FOR UPDATE`, lets the {@link RepositoryConnection}
 * class change itself, and saves what it changed in the same transaction; the rules are the
 * class's, none is written in a query. A usable Clone is recorded by its commit: `head_sha` is
 * set exactly while one exists. Only a `disconnecting` Repository is ever deleted (the last
 * step of a Disconnect).
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

  async connect(attempt: ConnectAttempt): Promise<RepositoryConnection> {
    const project = await this.db.project.findUnique({
      where: { id: attempt.projectId },
      select: { id: true },
    });
    if (!project) throw new ProjectNotFoundError();

    try {
      return await this.db.$transaction(async (tx) => {
        const locked = await lockRepository(tx, attempt.projectId);
        if (locked) {
          // Retry: only a failed Repository is replaced, under its lock; a second Retry waits
          // for the first and finds the Repository no longer failed.
          const row = await tx.repository.findUnique({
            where: { projectId: attempt.projectId },
            select: REPOSITORY_FIELDS,
          });
          const existing = toRepository(row!);
          existing.restart(attempt);
          await tx.repository.update({
            where: { projectId: attempt.projectId },
            data: changedColumns(existing.pendingChanges()),
          });
          return existing;
        }
        const created = RepositoryConnection.start(attempt);
        await tx.repository.create({ data: createColumns(created, attempt.identity) });
        return created;
      }, LOCKED_TRANSACTION);
    } catch (error) {
      // A kept key whose Repository is gone or holds another key, a Repository that is not
      // failed, or a unique index of a concurrent connect or of another project's remote.
      if (error instanceof RepositoryAlreadyConnectedError || isUniqueConstraintViolation(error)) {
        throw await this.conflictFor(attempt);
      }
      throw error;
    }
  }

  async change(
    projectId: string,
    mutate: (repository: RepositoryConnection) => void,
  ): Promise<RepositoryConnection | null> {
    return this.db.$transaction(async (tx) => {
      if (!(await lockRepository(tx, projectId))) return null;
      const row = await tx.repository.findUnique({
        where: { projectId },
        select: REPOSITORY_FIELDS,
      });
      const repository = toRepository(row!);
      mutate(repository);
      const changes = repository.pendingChanges();
      if (changes.removed) {
        await tx.repository.delete({ where: { projectId } });
      } else if (Object.keys(changes.fields).length > 0) {
        await tx.repository.update({ where: { projectId }, data: changedColumns(changes) });
      }
      return repository;
    }, LOCKED_TRANSACTION);
  }

  async listIdsInState(state: RepositoryState): Promise<string[]> {
    const rows = await this.db.repository.findMany({
      where: { state },
      select: { projectId: true },
      orderBy: { updatedAt: 'asc' },
    });
    return rows.map((row) => row.projectId);
  }

  async listDeployKeySecretRefs(): Promise<string[]> {
    const rows = await this.db.repository.findMany({
      where: { deployKeySecretId: { not: null } },
      select: { deployKeySecretId: true },
    });
    return rows.flatMap((row) => (row.deployKeySecretId === null ? [] : [row.deployKeySecretId]));
  }

  /**
   * Which unique constraint a Connect hit: the project already has a Repository (the primary
   * key, also when a concurrent connect won), or another project holds the remote.
   */
  private async conflictFor(attempt: ConnectAttempt): Promise<Error> {
    const owner = await this.db.repository.findUnique({
      where: { urlNormalized: attempt.identity },
      select: { projectId: true, project: { select: { name: true } } },
    });
    if (owner && owner.projectId !== attempt.projectId) {
      return new RemoteAlreadyConnectedError(owner.project.name);
    }
    return new RepositoryAlreadyConnectedError();
  }
}

/**
 * Locks the project's Repository row until the transaction ends; false when there is none. A
 * statement after the lock reads the row as the last committed change left it.
 */
async function lockRepository(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ project_id: string }[]>`
    SELECT project_id FROM repositories WHERE project_id = ${projectId}::uuid FOR UPDATE`;
  return rows.length > 0;
}
