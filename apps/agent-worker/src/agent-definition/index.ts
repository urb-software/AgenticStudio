import {
  PHASE_FINDINGS_MAX,
  PHASE_VERDICTS,
  phaseFindingSchema,
  runCheckSchema,
  runQuestionSchema,
} from '@agentic-studio/contracts';
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

/**
 * What a review Phase's agent ends with: the result above and its Verdict. The Verdict is optional
 * here and checked by {@link reviewResultSchema}: the CLI's schema language cannot say "required
 * when done", and `approved` may come with findings, `changes_requested` needs at least one.
 */
const reviewResultShape = {
  ...agentResultSchema.shape,
  verdict: z.enum(PHASE_VERDICTS).optional(),
  findings: z.array(phaseFindingSchema).max(PHASE_FINDINGS_MAX).optional(),
};

/** The shape the CLI is given for a review Phase. */
export const reviewResultObject = z.strictObject(reviewResultShape);

export const reviewResultSchema = reviewResultObject
  .refine((result) => result.outcome !== 'done' || result.verdict !== undefined, {
    path: ['verdict'],
    message: 'A review ends with a Verdict.',
  })
  .refine((result) => result.verdict === undefined || result.outcome === 'done', {
    path: ['verdict'],
    message: 'Only a finished review has a Verdict.',
  })
  .refine(
    (result) =>
      result.verdict !== 'changes_requested' ||
      (result.findings !== undefined && result.findings.length > 0),
    { path: ['findings'], message: 'Changes requested come with at least one finding.' },
  );

/** {@link reviewResultObject} as JSON Schema text for the CLI, like {@link AGENT_RESULT_JSON_SCHEMA}. */
export const REVIEW_RESULT_JSON_SCHEMA = (() => {
  const { $schema, ...schema } = z.toJSONSchema(reviewResultObject, { target: 'draft-7' });
  void $schema;
  return JSON.stringify(schema);
})();

/** Which result schema and which CLI schema a Phase's step uses. */
export function resultSchemaFor(phase: { kind?: 'work' | 'review' } | undefined) {
  return phase?.kind === 'review' ? reviewResultSchema : agentResultSchema;
}
