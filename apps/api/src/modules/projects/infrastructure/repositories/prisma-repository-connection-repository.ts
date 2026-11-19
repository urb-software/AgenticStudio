import { isUniqueConstraintViolation, type Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import {
  type ConnectAttempt,
  type RepositoryChanges,
} from '../../domain/entities/repository-connection-facts.js';
import {
  REPOSITORY_STATES,
  type RepositoryState,
} from '../../domain/value-objects/repository-state.js';
import {
  RepositoryAlreadyConnectedError,
  RemoteHeldByOtherProjectError,
} from '../../domain/errors/repository-connection-errors.js';
import { RepositoryConnection } from '../../domain/entities/repository-connection.js';
import { type RepositoryConnectionRepository } from '../../domain/repositories/repository-connection-repository.js';
import {
  REPOSITORY_FAILURE_CODES,
  RepositoryFailure,
  type RepositoryFailureCode,
} from '../../domain/value-objects/repository-failure.js';

/** A change waits for the row lock under pool pressure as a single UPDATE did (as the Run store). */
const LOCKED_TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;

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

function createColumns(repository: RepositoryConnection, identity: string) {
  return {
    projectId: repository.projectId,
    url: repository.url,
    urlNormalized: identity,
    integrationBranch: repository.integrationBranch,
    state: repository.state,
    headSha: repository.headSha,
    lastFetchedAt: repository.lastFetchedAt,
    failureCode: repository.failure?.code ?? null,
    failureDetail: repository.failure?.detail ?? null,
    failureRemoteDefaultBranch: repository.failure?.remoteDefaultBranch ?? null,
    publicKey: repository.publicKey,
    deployKeySecretId: repository.deployKeySecret,
    pinnedHostKey: repository.pinnedHostKey,
    pendingHostKey: repository.pendingHostKey,
    updatedAt: new Date(),
  };
}

/**
 * PostgreSQL adapter of {@link RepositoryConnectionRepository}: unique indexes, not prior reads,
 * decide duplicates; a change locks the row `FOR UPDATE` and saves in the same transaction.
 * Only a `disconnecting` Repository is ever deleted.
 */
@Injectable()
export class PrismaRepositoryConnectionRepository implements RepositoryConnectionRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async find(projectId: string): Promise<RepositoryConnection | null> {
    const row = await this.db.repository.findUnique({
      where: { projectId },
      select: REPOSITORY_FIELDS,
    });
    return row ? toRepository(row) : null;
  }

  async connect(attempt: ConnectAttempt): Promise<RepositoryConnection> {
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
   * key, also when a concurrent connect won), or another project holds the remote (named by
   * its id; the handler looks up its name).
   */
  private async conflictFor(attempt: ConnectAttempt): Promise<Error> {
    const owner = await this.db.repository.findUnique({
      where: { urlNormalized: attempt.identity },
      select: { projectId: true },
    });
    if (owner && owner.projectId !== attempt.projectId) {
      return new RemoteHeldByOtherProjectError(owner.projectId);
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
