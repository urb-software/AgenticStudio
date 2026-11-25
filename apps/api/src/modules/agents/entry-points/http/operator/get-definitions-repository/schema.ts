import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { REPOSITORY_STATES } from '../../../../../projects/contracts/index.js';

/**
 * `GET /api/agents/definitions-repository` response; `project` is `null` when none is connected.
 */
export const definitionsRepositoryResponseSchema = z
  .object({
    project: z
      .object({
        id: z
          .uuid()
          .describe(
            'The definitions Project; its Repository is connected through the projects routes.',
          ),
        repository: z
          .object({
            state: z.enum(REPOSITORY_STATES),
            integrationBranch: z.string(),
            headSha: z
              .string()
              .nullable()
              .describe(
                'The Integration branch commit the Clone holds; null without a usable Clone.',
              ),
            lastFetchedAt: z.iso.datetime().nullable(),
          })
          .nullable()
          .describe('Null while the Project has no Repository connected yet.'),
      })
      .nullable(),
  })
  .meta({ id: 'DefinitionsRepository' });

export class DefinitionsRepositoryResponseDto extends createZodDto(
  definitionsRepositoryResponseSchema,
) {}
