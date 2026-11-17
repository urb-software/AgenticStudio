import {
  ENVIRONMENT_FILE_MAX_BYTES,
  ENVIRONMENT_FILE_PATH_MAX_LENGTH,
} from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `PUT /api/projects/:id/environment-file` body (Issue #104). Only the lengths are checked
 * here; the handler explains a refused path or content (422 with a field error).
 */
export const setEnvironmentFileRequestSchema = z
  .strictObject({
    path: z
      .string()
      .max(ENVIRONMENT_FILE_PATH_MAX_LENGTH)
      .describe(
        'Relative POSIX path in the repository (e.g. `.env`): no leading `/`, no `..`, `.` or ' +
          'empty segments, not inside `.git`, and not tracked in the repository.',
      ),
    content: z
      .string()
      .max(ENVIRONMENT_FILE_MAX_BYTES)
      .describe(
        `The file's content, UTF-8, at most ${ENVIRONMENT_FILE_MAX_BYTES} bytes. Test values ` +
          'only: the agent can read this file. Never returned by any endpoint.',
      ),
  })
  .meta({ id: 'SetEnvironmentFileRequest' });

export type SetEnvironmentFileRequest = z.infer<typeof setEnvironmentFileRequestSchema>;

export class SetEnvironmentFileRequestDto extends createZodDto(setEnvironmentFileRequestSchema) {}
