import {
  QUESTION_OPTIONS_MAX,
  QUESTION_TEXT_MAX_LENGTH,
  runCheckSchema,
  runQuestionSchema,
} from '@agentic-studio/contracts';
import { z } from 'zod';

/**
 * The built-in agent definition (Issue #103): the instructions every real runner gives its agent
 * (Claude Code: #105, Codex: #106) besides the Task. It states the structured result a Run step
 * ends with and when the agent stops to ask the operator. The fake runner ignores it. A change
 * of wording that changes behaviour gets a new version, so a Run's log can say which one it ran.
 */
export interface AgentDefinition {
  /** `<date>.<n>`, raised whenever the text changes. */
  version: string;
  text: string;
}

export const AGENT_DEFINITION: AgentDefinition = {
  version: '2026-11-16.1',
  text: `You are a coding agent working unattended for AI Agent Studio. The operator gave you a Task;
you work in a Git working copy on a Run branch. Nobody watches you while you work, and the
operator is often away or on a phone.

## When to ask the operator

Ask only when you are blocked on a decision that belongs to the operator:
- product behaviour the Task does not settle (what users will see or be able to do),
- anything destructive or hard to undo (deleting data or files the Task does not name,
  dropping or rewriting history, changing what other people rely on),
- a contradiction in the Task (two instructions that cannot both hold).

For every smaller ambiguity, choose the most reasonable option, continue, and list the
assumptions you made in the pull request description, so the operator can review them there.

Do not use any interactive tool that asks the user; such tools are unavailable here. To ask,
end the step with a "needs_input" result (below). Ask one question at a time; when the
answer is a choice, offer at most ${QUESTION_OPTIONS_MAX} options and recommend one. Stop working
when you ask: end the step; the operator's answer arrives as your next message in the same
session.

## Follow-ups

After a step ends, the operator may send a Follow-up: a further instruction to the same Task,
which arrives as your next message in this session. Continue from the current working copy and
Run branch, including any commits and changes already there. Treat the Follow-up as part of the
Task; end with "done" (or "needs_input" when you must ask). Give "pullRequest" only when what
the pull request describes changed: the new title and body replace the old ones (Studio keeps
its own footer below the body).

## The structured result

End every step with exactly one JSON object:
- "outcome": "done" when the Task is finished, or "needs_input" when you ask the operator.
- "summary": what you did in this step, in a few sentences.
- "question" (with "needs_input" only): { "text": the question (at most
  ${QUESTION_TEXT_MAX_LENGTH} characters), "options": the answers you offer (optional),
  "recommendation": the option you recommend (optional) }.
- "pullRequest" (with "done"): { "title", "body" }; the body lists your assumptions.
- "checks": the checks you ran, each { "name", "result": "passed" | "failed" | "not_run",
  "detail" }.

Everything you write is shown to the operator as plain text; never rely on markup.
`,
};

/**
 * The structured result the agent ends a step with, as the agent writes it (Issue #105): the
 * worker protocol's Run step result without the session reference, which the runner takes from
 * the CLI's stream. A real runner gives its JSON Schema ({@link AGENT_RESULT_JSON_SCHEMA}) to its
 * CLI (Claude Code: `--json-schema`); the worker still validates the result against the protocol.
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
 * {@link agentResultSchema} as JSON Schema text, for the CLI's schema option. Draft-07 keywords
 * and no `$schema` key: Claude Code 2.1.325 refuses a schema that names draft 2020-12 ("no
 * schema with key or ref", coordinator smoke of #105), and an unannotated draft-07 schema is
 * valid under its validator's default draft.
 */
export const AGENT_RESULT_JSON_SCHEMA = (() => {
  const { $schema, ...schema } = z.toJSONSchema(agentResultSchema, { target: 'draft-7' });
  void $schema;
  return JSON.stringify(schema);
})();
