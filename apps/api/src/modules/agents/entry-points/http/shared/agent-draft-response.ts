import { PROBLEM_CODES } from '@agentic-studio/agent-definitions';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AgentDraftView } from '../../../application/agent-draft-reader.js';
import { AGENT_DRAFT_CHANGES } from '../../../domain/value-objects/agent-draft-file.js';

const draftFileSchema = z
  .object({
    path: z.string().describe('Relative to the Repository root, with `/` separators.'),
    change: z.enum(AGENT_DRAFT_CHANGES),
    size: z.number().int().min(0).describe('Bytes; 0 for a deleted file.'),
    movedFrom: z
      .string()
      .nullable()
      .describe('For display: the path this file was moved from; null for any other file.'),
  })
  .meta({ id: 'AgentDraftFile' });

const draftProblemSchema = z
  .object({
    agent: z.string().describe('The agent folder the problem is in.'),
    code: z.enum(PROBLEM_CODES),
    path: z
      .string()
      .describe('The file or folder the problem is about, relative to the Repository root.'),
    key: z.string().nullable().describe('The front matter key, when the problem is about one.'),
    message: z.string().describe('Fixed wording per code; never a value or file content.'),
  })
  .meta({ id: 'AgentDraftProblem' });

/** The Draft and what it would make of the agents; every write answers it too. */
export const agentDraftResponseSchema = z
  .object({
    baseCommit: z
      .string()
      .nullable()
      .describe('The commit the changes were made against; null while the Draft is empty.'),
    currentCommit: z
      .string()
      .nullable()
      .describe('The commit the Repository holds now; null when none was fetched.'),
    version: z
      .number()
      .int()
      .min(0)
      .describe(
        'Raised on every write: the web compares it to see that the Draft changed elsewhere.',
      ),
    files: z.array(draftFileSchema),
    problems: z
      .array(draftProblemSchema)
      .describe(
        'What the shared validation finds in each agent folder the Draft touches, with the ' +
          'Draft laid over the base tree. Empty when the Clone cannot be read.',
      ),
    movedUpstream: z
      .array(z.string())
      .describe(
        'Paths of the Draft whose blob differs between the base commit and the current commit.',
      ),
  })
  .meta({ id: 'AgentDraft' });

export class AgentDraftResponseDto extends createZodDto(agentDraftResponseSchema) {}

export function toAgentDraftResponse(view: AgentDraftView) {
  return {
    baseCommit: view.baseCommit,
    currentCommit: view.currentCommit,
    version: view.version,
    files: view.files.map(({ path, change, size, movedFrom }) => ({
      path,
      change,
      size,
      movedFrom,
    })),
    problems: view.problems.map(({ agent, code, path, key, message }) => ({
      agent,
      code,
      path,
      key,
      message,
    })),
    movedUpstream: view.movedUpstream,
  };
}
