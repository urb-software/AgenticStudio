/** What follows a Phase's result: the next Phase's position, or the end of the Workflow. */
export type NextPhase = { kind: 'phase'; position: number } | { kind: 'end' };
