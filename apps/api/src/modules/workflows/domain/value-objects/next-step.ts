/** How a Phase ended: a work Phase is `done`, a review Phase gives its Verdict. */
export type PhaseOutcome = 'done' | 'approved' | 'changes_requested';

/**
 * What follows a Phase's result or a Checkpoint: the next Phase's position among the Phases, the
 * place among the items of the Checkpoint the Run waits at, or the end of the Workflow.
 */
export type NextStep =
  { kind: 'phase'; position: number } | { kind: 'checkpoint'; item: number } | { kind: 'end' };
