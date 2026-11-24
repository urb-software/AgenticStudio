import { isUniqueConstraintViolation } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { Project } from '../../domain/entities/project.js';
import { type ProjectRepository } from '../../domain/repositories/project-repository.js';
import { isProjectId } from '../../domain/value-objects/project-id.js';
import { isMergeMethod } from '../../domain/value-objects/merge-method.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';
import { ProjectNameTakenError } from '../../domain/errors/project-errors.js';

const PROJECT_FIELDS = { id: true, name: true, mergeMethod: true, createdAt: true } as const;

function toProject(row: {
  id: string;
  name: string;
  mergeMethod: string;
  createdAt: Date;
}): Project {
  // The column's CHECK constraint keeps the list; a value outside it is a broken record.
  if (!isMergeMethod(row.mergeMethod)) throw new Error('A project has an unknown merge method.');
  return Project.restore({
    id: row.id,
    name: row.name,
    mergeMethod: row.mergeMethod,
    createdAt: row.createdAt,
  });
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

  async findByIds(ids: readonly string[]): Promise<Project[]> {
    const valid = ids.filter((id) => isProjectId(id));
    if (valid.length === 0) return [];
    const rows = await this.db.project.findMany({
      where: { id: { in: valid } },
      select: PROJECT_FIELDS,
    });
    return rows.map(toProject);
  }

  async saveMergeMethod(project: Project): Promise<boolean> {
    // `updateMany` does not throw for a row that is gone; its count says so.
    const { count } = await this.db.project.updateMany({
      where: { id: project.id },
      data: { mergeMethod: project.mergeMethod },
    });
    return count > 0;
  }
}
