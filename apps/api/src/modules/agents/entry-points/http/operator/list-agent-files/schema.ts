import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { agentsCommitSchema, agentsRepositorySchema } from '../../shared/agent-response.js';

export const agentFileEntrySchema = z
  .object({
    path: z.string().describe('Relative to the Repository root, with `/` separators.'),
    kind: z
      .enum(['file', 'symlink', 'submodule'])
      .describe('A symbolic link and a submodule are listed and never read.'),
    size: z.number().int().min(0).describe('Bytes; 0 for a symbolic link and a submodule.'),
    openable: z
      .boolean()
      .describe(
        'Whether the content route can read this entry: a regular file within the size limit ' +
          'and with a path the route accepts.',
      ),
    agent: z
      .string()
      .nullable()
      .describe('The agent folder the entry is in; null for any other part of the Repository.'),
    skill: z
      .string()
      .nullable()
      .describe('The skill folder the entry is in; null for any other part of the Repository.'),
    workflow: z
      .string()
      .nullable()
      .describe('The workflow folder the entry is in; null for any other part of the Repository.'),
  })
  .meta({ id: 'AgentFileEntry' });

export const agentFilesResponseSchema = z
  .object({
    commit: agentsCommitSchema,
    repository: agentsRepositorySchema
      .nullable()
      .describe('Null when no definitions Repository is connected.'),
    truncated: z.boolean().describe('True when the Repository holds more entries than are listed.'),
    entries: z.array(agentFileEntrySchema),
  })
  .meta({ id: 'AgentFiles' });

export class AgentFilesResponseDto extends createZodDto(agentFilesResponseSchema) {}
