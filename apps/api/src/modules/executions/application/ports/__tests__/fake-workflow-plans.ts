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
  next: (plan, position, outcome, sendBacks = { used: 0 }) => {
    const phases = plan.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.kind !== 'checkpoint');
    if (outcome === 'changes_requested') {
      const limit = Math.min(Math.max(plan.sendBacks ?? 2, 0), 2);
      if (phases[position]?.item.kind !== 'review' || sendBacks.used >= limit) {
        return { kind: 'end' };
      }
      for (let at = position - 1; at >= 0; at -= 1) {
        if (phases[at]!.item.kind === 'work') return { kind: 'send_back', position: at };
      }
      return { kind: 'end' };
    }
    const returnTo = sendBacks.returnTo ?? null;
    if (outcome === 'done' && returnTo !== null && returnTo > position) {
      return { kind: 'phase', position: returnTo };
    }
    const at = phases[position];
    return at === undefined ? { kind: 'end' } : from(plan.items, at.index + 1);
  },
  afterCheckpoint: (plan, item) => from(plan.items, item + 1),
  first: (plan) => from(plan.items, 0),
};
