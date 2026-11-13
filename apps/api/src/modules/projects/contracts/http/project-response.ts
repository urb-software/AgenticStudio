import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A project in API responses: the create response and each list item. Shared by several
 * features of the module, so it lives in the module's public HTTP contract (backend.md §2),
 * not in one feature's schema.ts. Self-contained: it takes a plain shape, not a domain type.
 */
export const projectResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Project' });

export class ProjectResponseDto extends createZodDto(projectResponseSchema) {}

export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export function toProjectResponse(project: {
  id: string;
  name: string;
  createdAt: Date;
}): ProjectResponse {
  return { id: project.id, name: project.name, createdAt: project.createdAt.toISOString() };
}
