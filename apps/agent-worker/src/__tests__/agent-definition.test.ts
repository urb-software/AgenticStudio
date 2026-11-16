import { QUESTION_OPTIONS_MAX } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT_DEFINITION } from '../agent-definition/index.js';

// Issue #103: the built-in agent definition every real runner gives its agent. These tests pin
// the rules that decide when the agent stops to ask the operator.
describe('built-in agent definition', () => {
  const text = AGENT_DEFINITION.text;

  it('is versioned', () => {
    expect(AGENT_DEFINITION.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('states the structured result contract: done, or needs_input with a question', () => {
    for (const field of ['"outcome"', '"done"', '"needs_input"', '"summary"', '"question"']) {
      expect(text).toContain(field);
    }
    expect(text).toContain('"options"');
    expect(text).toContain('"recommendation"');
    expect(text).toContain(`at most ${QUESTION_OPTIONS_MAX} options`);
  });

  it('asks only when blocked on a decision that is the operator’s', () => {
    expect(text).toMatch(/only when you are blocked on a decision that belongs to the operator/i);
    expect(text).toMatch(/product behaviour/i);
    expect(text).toMatch(/destructive/i);
    expect(text).toMatch(/contradiction in the task/i);
  });

  it('otherwise chooses, continues and lists its assumptions in the pull request description', () => {
    expect(text).toMatch(/choose the most reasonable option, continue/i);
    expect(text).toMatch(/assumptions.*pull request description/is);
  });

  it('tells the agent how to carry on after Studio merged the integration branch (Issue #147)', () => {
    expect(text).toMatch(/merge the integration branch into the\s+Run branch/i);
    expect(text).toMatch(/remove every conflict marker/i);
    expect(text).toMatch(/Never abort the merge, rebase, reset,\s+rewrite history or push/i);
    expect(text).toMatch(/Studio completes the merge/i);
  });

  it('asks through the result only: no interactive ask tool, and the step ends after asking', () => {
    expect(text).toMatch(/do not use any interactive tool that asks the user/i);
    expect(text).toMatch(/end the step/i);
  });
});
