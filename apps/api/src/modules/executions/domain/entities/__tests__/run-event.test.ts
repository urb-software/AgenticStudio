import { describe, expect, it } from 'vitest';
import { LOG_TRUNCATED_NOTICE, planLogAppend, type RunEvent } from '../run-event.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const event = (seq: number, text: string): RunEvent => ({
  seq,
  at: AT,
  stepIndex: 1,
  kind: 'output',
  text,
  truncated: false,
});

// Issue #99: a size cap per Run. When it is reached, one "log truncated" notice is stored in
// place of the event that did not fit, later events are dropped, and the Run continues.
describe('the per-Run log cap', () => {
  it('stores events while their text fits, counting UTF-8 bytes', () => {
    const plan = planLogAppend({ bytes: 0, truncated: false }, [event(1, 'abc'), event(2, 'é')], 5);

    expect(plan.store).toEqual([event(1, 'abc'), event(2, 'é')]);
    expect(plan.state).toEqual({ bytes: 5, truncated: false });
  });

  it('replaces the first event that does not fit with one notice and drops the rest', () => {
    const plan = planLogAppend(
      { bytes: 2, truncated: false },
      [event(3, 'ab'), event(4, 'cd'), event(5, 'e')],
      5,
    );

    expect(plan.store).toEqual([
      event(3, 'ab'),
      {
        seq: 4,
        at: AT,
        stepIndex: 1,
        kind: 'notice',
        text: LOG_TRUNCATED_NOTICE,
        truncated: false,
      },
    ]);
    expect(plan.state).toEqual({ bytes: 4, truncated: true });
    expect(LOG_TRUNCATED_NOTICE).toMatch(/^log truncated/);
  });

  it('stores nothing more once the log is truncated', () => {
    const plan = planLogAppend({ bytes: 4, truncated: true }, [event(9, 'x')], 5);

    expect(plan.store).toEqual([]);
    expect(plan.state).toEqual({ bytes: 4, truncated: true });
  });
});
