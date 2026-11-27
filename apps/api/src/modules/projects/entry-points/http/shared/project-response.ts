import { mergeMethodSchema, type MergeMethod } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  PROJECT_KIND_VALUES,
  type ProjectKind,
} from '../../../domain/value-objects/project-kind.js';

/**
 * A project in API responses (create and list items). Within this module only: other modules
 * must not import it.
 */
export const projectResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    mergeMethod: mergeMethodSchema.describe(
      "How the project's Runs are merged: `squash` (the default) or `merge_commit`.",
    ),
    kind: z
      .enum(PROJECT_KIND_VALUES)
      .describe(
        '`code` for an ordinary Project; `definitions` for the Repository that holds agent definitions.',
      ),
    defaultAgent: z
      .string()
      .nullable()
      .describe(
        'The agent a Run offers first, by name; null when none is named. Whether it is usable ' +
          'is judged where agents are read.',
      ),
    defaultWorkflow: z
      .string()
      .nullable()
      .describe(
        'The Workflow a Run offers first, by name; null when none is named. At most one of the ' +
          'default agent and the default Workflow is set.',
      ),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Project' });

export class ProjectResponseDto extends createZodDto(projectResponseSchema) {}

export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export function toProjectResponse(project: {
  id: string;
  name: string;
  mergeMethod: MergeMethod;
  kind: ProjectKind;
  defaultAgent: string | null;
  defaultWorkflow: string | null;
  createdAt: Date;
}): ProjectResponse {
  return {
    id: project.id,
    name: project.name,
    mergeMethod: project.mergeMethod,
    kind: project.kind,
    defaultAgent: project.defaultAgent,
    defaultWorkflow: project.defaultWorkflow,
    createdAt: project.createdAt.toISOString(),
  };
}
