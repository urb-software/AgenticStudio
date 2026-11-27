import type { WorkflowPlans } from '../../../contracts/index.js';

/** The sequential decision `workflows` makes for work Phases; it resolves nothing. */
export const SEQUENTIAL_PLANS: WorkflowPlans = {
  resolve: () => Promise.resolve({ status: 'unknown' }),
  next: (plan, position, outcome) =>
    outcome !== 'changes_requested' &&
    position + 1 < plan.items.filter((item) => item.kind !== 'checkpoint').length
      ? { kind: 'phase', position: position + 1 }
      : { kind: 'end' },
};
