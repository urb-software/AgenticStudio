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
import { isProjectKind, type ProjectKind } from '../../domain/value-objects/project-kind.js';
import type { ProjectName } from '../../domain/value-objects/project-name.js';
import {
  DefinitionsProjectExistsError,
  ProjectNameTakenError,
} from '../../domain/errors/project-errors.js';

const PROJECT_FIELDS = {
  id: true,
  name: true,
  mergeMethod: true,
  kind: true,
  defaultAgent: true,
  defaultWorkflow: true,
  createdAt: true,
} as const;

function toProject(row: {
  id: string;
  name: string;
  mergeMethod: string;
  kind: string;
  defaultAgent: string | null;
  defaultWorkflow: string | null;
  createdAt: Date;
}): Project {
  // The column's CHECK constraint keeps the list; a value outside it is a broken record.
  if (!isMergeMethod(row.mergeMethod)) throw new Error('A project has an unknown merge method.');
  if (!isProjectKind(row.kind)) throw new Error('A project has an unknown kind.');
  return Project.restore({
    id: row.id,
    name: row.name,
    mergeMethod: row.mergeMethod,
    kind: row.kind,
    defaultAgent: row.defaultAgent,
    defaultWorkflow: row.defaultWorkflow,
    createdAt: row.createdAt,
  });
}

const ONE_DEFINITIONS_INDEX = 'projects_one_definitions_key';

/** Which unique index a violation names, read from the error's metadata; `null` when neither. */
function violatedIndex(error: unknown): 'definitions' | 'name' | null {
  const named = JSON.stringify((error as { meta?: unknown }).meta ?? '');
  if (named.includes(ONE_DEFINITIONS_INDEX)) return 'definitions';
  return named.includes('name_normalized') ? 'name' : null;
}

/**
 * PostgreSQL adapter of {@link ProjectRepository}: the `projects` table only. The unique index
 * `projects.name_normalized`, not a prior read, decides duplicate names.
 */
@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async add(name: ProjectName, kind: ProjectKind): Promise<Project> {
    try {
      return toProject(
        await this.db.project.create({
          data: { name: name.value, nameNormalized: name.uniquenessKey, kind },
          select: PROJECT_FIELDS,
        }),
      );
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const violated = violatedIndex(error);
      if (violated === 'definitions') throw new DefinitionsProjectExistsError();
      if (violated === 'name') throw new ProjectNameTakenError();
      // The error names neither index: the existing definitions Project decides.
      if (kind === 'definitions' && (await this.definitionsExists())) {
        throw new DefinitionsProjectExistsError();
      }
      throw new ProjectNameTakenError();
    }
  }

  private async definitionsExists(): Promise<boolean> {
    const row = await this.db.project.findFirst({
      where: { kind: 'definitions' },
      select: { id: true },
    });
    return row !== null;
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

  async findDefinitions(): Promise<Project | null> {
    const row = await this.db.project.findFirst({
      where: { kind: 'definitions' },
      select: PROJECT_FIELDS,
    });
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

  async saveDefaultAgent(project: Project): Promise<boolean> {
    const { count } = await this.db.project.updateMany({
      where: { id: project.id },
      data: { defaultAgent: project.defaultAgent, defaultWorkflow: project.defaultWorkflow },
    });
    return count > 0;
  }
}
