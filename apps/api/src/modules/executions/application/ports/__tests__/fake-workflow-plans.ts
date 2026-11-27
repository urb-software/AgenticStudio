import type { NextStep, PlannedItem, WorkflowPlans } from '../../../contracts/index.js';

/** The item at `index` as a step, or the end: the sequential decision `workflows` makes. */
function from(items: readonly PlannedItem[], index: number): NextStep {
  const item = items[index];
  if (item === undefined) return { kind: 'end' };
  if (item.kind === 'checkpoint') return { kind: 'checkpoint', item: index };
  return {
    kind: 'phase',
    position: items.slice(0, index).filter((before) => before.kind !== 'checkpoint').length,
  };
}

/** The sequential decision `workflows` makes over a recorded plan; it resolves nothing. */
export const SEQUENTIAL_PLANS: WorkflowPlans = {
  resolve: () => Promise.resolve({ status: 'unknown' }),
  next: (plan, position) => {
    const phases = plan.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.kind !== 'checkpoint');
    const at = phases[position];
    return at === undefined ? { kind: 'end' } : from(plan.items, at.index + 1);
  },
  afterCheckpoint: (plan, item) => from(plan.items, item + 1),
  first: (plan) => from(plan.items, 0),
};
