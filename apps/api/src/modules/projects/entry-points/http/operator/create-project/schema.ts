import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  ProjectName,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
} from '../../../../domain/value-objects/project-name.js';

/**
 * `POST /api/projects` body; an unknown field is a 400. The name is normalized before the length
 * checks, counted in code points like `ProjectName` and PostgreSQL `char_length`.
 */
export const createProjectRequestSchema = z
  .strictObject({
    name: z
      .string()
      .overwrite(ProjectName.normalize)
      .min(PROJECT_NAME_MIN_LENGTH, { error: 'Enter a project name.' })
      .max(PROJECT_NAME_MAX_LENGTH, {
        error: `Use at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
      }),
  })
  .meta({ id: 'CreateProjectRequest' });

export class CreateProjectRequestDto extends createZodDto(createProjectRequestSchema) {}
