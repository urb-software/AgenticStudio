import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { projectResponseSchema } from '../../shared/project-response.js';
import { repositorySummarySchema } from '../../shared/repository-response.js';

export const projectDetailResponseSchema = z
  .object({
    ...projectResponseSchema.shape,
    repository: repositorySummarySchema.nullable(),
  })
  .meta({ id: 'ProjectDetail' });

export class ProjectDetailResponseDto extends createZodDto(projectDetailResponseSchema) {}
