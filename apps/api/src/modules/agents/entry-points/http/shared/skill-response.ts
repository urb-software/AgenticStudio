import { SKILL_PROBLEM_CODES } from '@agentic-studio/agent-definitions';
import { z } from 'zod';
import type {
  ReadSkillsResult,
  SkillView,
} from '../../../application/features/read-skills/handler.js';
import { agentsCommitSchema, agentsRepositorySchema } from './agent-response.js';

const skillProblemSchema = z
  .object({
    code: z.enum(SKILL_PROBLEM_CODES),
    path: z
      .string()
      .describe('The file or folder the problem is about, relative to the skill folder.'),
    key: z.string().nullable().describe('The front matter key, when the problem is about one.'),
    message: z.string().describe('Fixed wording per code; never a value or file content.'),
  })
  .meta({ id: 'SkillProblem' });

/** What the list shows of one skill, and the first part of the detail. */
export const skillSummaryFields = {
  name: z.string().describe('The name of the skill folder, as found; it may not be a valid name.'),
  description: z.string().nullable().describe('Null for a skill that is not valid.'),
  valid: z.boolean().describe('False while the skill has problems.'),
  problems: z.array(skillProblemSchema),
};

export const skillsCommitSchema = agentsCommitSchema;
export const skillsRepositorySchema = agentsRepositorySchema;

export function toSkillSummary(skill: SkillView) {
  return {
    name: skill.name,
    description: skill.description,
    valid: skill.valid,
    problems: skill.problems.map((problem) => ({
      code: problem.code,
      path: problem.path,
      key: problem.key ?? null,
      message: problem.message,
    })),
  };
}

export function toSkillsRepository(repository: ReadSkillsResult['repository']) {
  return repository ? { state: repository.state, note: repository.note } : null;
}
