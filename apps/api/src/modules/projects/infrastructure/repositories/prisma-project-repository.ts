import { isUniqueConstraintViolation } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { Project } from '../../domain/entities/project.js';
import type { Repository } from '../../domain/entities/repository.js';
import {
  ProjectNameTakenError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';

const PROJECT_FIELDS = { id: true, name: true, createdAt: true } as const;

/**
 * PostgreSQL adapter of {@link ProjectRepository}. The unique index on `name_normalized`,
 * not a prior read, decides duplicates, so concurrent creates cannot both succeed.
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

  findById(): Promise<Project | null> {
    return Promise.reject(new Error('not implemented'));
  }

  findRepository(): Promise<Repository | null> {
    return Promise.reject(new Error('not implemented'));
  }

  beginConnect(): Promise<Repository> {
    return Promise.reject(new Error('not implemented'));
  }

  markReady(): Promise<boolean> {
    return Promise.reject(new Error('not implemented'));
  }

  markFailed(): Promise<boolean> {
    return Promise.reject(new Error('not implemented'));
  }

  failAllConnecting(): Promise<number> {
    return Promise.reject(new Error('not implemented'));
  }
}
