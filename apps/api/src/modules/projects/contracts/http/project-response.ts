import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A project in API responses: the create response and each list item. Shared by several
 * features of this module, so it lives in contracts/http/ (backend.md §2), not in one
 * feature's schema.ts. Within this module only: other modules must not import it, and it is
 * not re-exported from a contracts/index.ts. Self-contained: it takes a plain shape.
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
