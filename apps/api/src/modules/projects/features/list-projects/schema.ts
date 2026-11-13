import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { projectResponseSchema } from '../../contracts/http/project-response.js';

/** `GET /api/projects` response, newest first; an empty `items` means no projects yet. */
export const projectListResponseSchema = z
  .object({ items: z.array(projectResponseSchema) })
  .meta({ id: 'ProjectList' });

export class ProjectListResponseDto extends createZodDto(projectListResponseSchema) {}
