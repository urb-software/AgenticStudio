import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A project in API responses (create and list items). Within this module only: other modules
 * must not import it.
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
