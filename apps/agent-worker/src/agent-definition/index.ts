import { runCheckSchema, runQuestionSchema } from '@agentic-studio/contracts';
import { z } from 'zod';

/**
 * The structured result the agent ends a step with: the protocol's Run step result without the
 * session reference (the runner takes it from the stream); the worker still validates it.
 */
export const agentResultSchema = z.strictObject({
  outcome: z.enum(['done', 'needs_input']),
  summary: z.string().max(20_000),
  question: runQuestionSchema.optional(),
  pullRequest: z
    .strictObject({ title: z.string().min(1).max(256), body: z.string().max(65_536) })
    .optional(),
  checks: z.array(runCheckSchema).max(100).optional(),
});

/**
 * {@link agentResultSchema} as JSON Schema text for the CLI. Draft-07 keywords, no `$schema` key:
 * Claude Code 2.1.325 refuses a schema that names draft 2020-12.
 */
export const AGENT_RESULT_JSON_SCHEMA = (() => {
  const { $schema, ...schema } = z.toJSONSchema(agentResultSchema, { target: 'draft-7' });
  void $schema;
  return JSON.stringify(schema);
})();
