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
  version: '2026-11-15.1',
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

/** {@link agentResultSchema} as JSON Schema text, for the CLI's schema option. */
export const AGENT_RESULT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(agentResultSchema));
