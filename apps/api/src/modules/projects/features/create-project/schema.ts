import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  normalizeProjectName,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
} from '../../domain/value-objects/project-name.js';

/**
 * `POST /api/projects` body. The name is normalized (NFC, trim, whitespace collapse) before
 * the length checks, so the 400 field errors follow the domain rule (`ProjectName`). Zod
 * counts string lengths in code points, like `ProjectName` and PostgreSQL `char_length`
 * (Issue #30 decision 2); JSON Schema `minLength`/`maxLength` use the same unit.
 */
export const createProjectRequestSchema = z
  .object({
    name: z
      .string()
      .overwrite(normalizeProjectName)
      .min(PROJECT_NAME_MIN_LENGTH, { error: 'Enter a project name.' })
      .max(PROJECT_NAME_MAX_LENGTH, {
        error: `Use at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
      }),
  })
  .meta({ id: 'CreateProjectRequest' });

export class CreateProjectRequestDto extends createZodDto(createProjectRequestSchema) {}
