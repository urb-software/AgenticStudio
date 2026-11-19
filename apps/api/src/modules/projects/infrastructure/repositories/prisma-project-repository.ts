import { isUniqueConstraintViolation } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { Project } from '../../domain/entities/project.js';
import { type ProjectRepository } from '../../domain/repositories/project-repository.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';
import { ProjectNameTakenError } from '../../domain/errors/project-errors.js';

const PROJECT_FIELDS = { id: true, name: true, createdAt: true } as const;

function toProject(row: { id: string; name: string; createdAt: Date }): Project {
  return Project.restore({ id: row.id, name: row.name, createdAt: row.createdAt });
}

/**
 * PostgreSQL adapter of {@link ProjectRepository}: the `projects` table only. The unique index
 * `projects.name_normalized`, not a prior read, decides duplicate names.
 */
@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async add(name: ProjectName): Promise<Project> {
    try {
      return toProject(
        await this.db.project.create({
          data: { name: name.value, nameNormalized: name.uniquenessKey },
          select: PROJECT_FIELDS,
        }),
      );
    } catch (error) {
      // The only unique constraint of `projects` besides the primary key is on name_normalized.
      if (isUniqueConstraintViolation(error)) {
        throw new ProjectNameTakenError();
      }
      throw error;
    }
  }

  async listNewestFirst(): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      select: PROJECT_FIELDS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toProject);
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.db.project.findUnique({ where: { id }, select: PROJECT_FIELDS });
    return row ? toProject(row) : null;
  }
}
