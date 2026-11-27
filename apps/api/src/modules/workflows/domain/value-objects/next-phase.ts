/** How a Phase ended: a work Phase is `done`, a review Phase gives its Verdict. */
export type PhaseOutcome = 'done' | 'approved' | 'changes_requested';

/** What follows a Phase's result: the next Phase's position, or the end of the Workflow. */
export type NextPhase = { kind: 'phase'; position: number } | { kind: 'end' };
