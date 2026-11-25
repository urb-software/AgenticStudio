import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PROJECT_KINDS } from '../../../../domain/value-objects/project-kind.js';
import { NormalizedName } from '../../../../domain/value-objects/normalized-name.js';
import {
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
      .overwrite((raw) => NormalizedName.of(raw).value)
      .min(PROJECT_NAME_MIN_LENGTH, { error: 'Enter a project name.' })
      .max(PROJECT_NAME_MAX_LENGTH, {
        error: `Use at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
      }),
    kind: z
      .enum(PROJECT_KINDS)
      .optional()
      .describe(
        '`code` (the default) is an ordinary Project. `definitions` is the one Repository that ' +
          'holds agent definitions; it accepts no Run, no Preview and no Environment file.',
      ),
  })
  .meta({ id: 'CreateProjectRequest' });

export class CreateProjectRequestDto extends createZodDto(createProjectRequestSchema) {}
