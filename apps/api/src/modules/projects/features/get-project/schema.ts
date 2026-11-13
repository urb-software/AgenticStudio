import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { projectResponseSchema } from '../../contracts/http/project-response.js';
import { repositorySummarySchema } from '../../contracts/http/repository-response.js';

/** `GET /api/projects/:id` response: the project and a summary of its Repository, if any. */
export const projectDetailResponseSchema = z
  .object({
    ...projectResponseSchema.shape,
    repository: repositorySummarySchema.nullable(),
  })
  .meta({ id: 'ProjectDetail' });

export class ProjectDetailResponseDto extends createZodDto(projectDetailResponseSchema) {}
