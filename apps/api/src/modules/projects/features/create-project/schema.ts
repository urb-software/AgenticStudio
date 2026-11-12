import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { Project } from '../../domain/entities/project.js';
import {
  normalizeProjectName,
  PROJECT_NAME_MAX_LENGTH,
} from '../../domain/value-objects/project-name.js';

/**
 * `POST /api/projects` body. The name is normalized before the length checks, so the
 * 400 field errors follow the domain rule (`ProjectName`); OpenAPI shows the bounds.
 */
export const createProjectRequestSchema = z
  .object({
    name: z
      .string()
      .overwrite(normalizeProjectName)
      .min(1, { error: 'Enter a project name.' })
      .max(PROJECT_NAME_MAX_LENGTH, {
        error: `Use at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
      }),
  })
  .meta({ id: 'CreateProjectRequest' });

export class CreateProjectRequestDto extends createZodDto(createProjectRequestSchema) {}

/** A project in API responses: the create response and each list item. */
export const projectResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Project' });

export class ProjectResponseDto extends createZodDto(projectResponseSchema) {}

export function toProjectResponse(project: Project): z.infer<typeof projectResponseSchema> {
  return { id: project.id, name: project.name, createdAt: project.createdAt.toISOString() };
}
