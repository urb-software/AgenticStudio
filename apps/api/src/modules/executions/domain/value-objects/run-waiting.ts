/** Why a Run waits for the operator: an agent's Question, or a Checkpoint of its Workflow. */
export type RunWaiting =
  { reason: 'question' } | { reason: 'checkpoint'; checkpoint: { id: string; text: string } };
