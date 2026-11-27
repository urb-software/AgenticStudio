/**
 * What follows a Phase's result or a Checkpoint: the next Phase's position among the Phases, the
 * place among the items of the Checkpoint the Run waits at, or the end of the Workflow.
 */
export type NextStep =
  { kind: 'phase'; position: number } | { kind: 'checkpoint'; item: number } | { kind: 'end' };
