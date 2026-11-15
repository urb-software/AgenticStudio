import { describe, expect, it } from 'vitest';
import { LogStreamSlots } from '../log-stream-slots.js';

const slots = (perSession: number, total: number) =>
  new LogStreamSlots({
    maxBytes: 1,
    keepAliveMs: 1,
    streamsPerSession: perSession,
    streamsTotal: total,
  });

describe('LogStreamSlots (Issue #99 review)', () => {
  it('allows a set number of streams per session', () => {
    const limit = slots(2, 10);
    const first = limit.acquire('a');
    expect(first).not.toBeNull();
    expect(limit.acquire('a')).not.toBeNull();
    expect(limit.acquire('a')).toBeNull();
    expect(limit.acquire('b')).not.toBeNull();

    first!();
    expect(limit.acquire('a')).not.toBeNull();
  });

  it('allows a set number of streams in total, across sessions', () => {
    const limit = slots(5, 2);
    const release = limit.acquire('a')!;
    limit.acquire('b');
    expect(limit.acquire('c')).toBeNull();

    release();
    release(); // A second release changes nothing.
    expect(limit.acquire('c')).not.toBeNull();
    expect(limit.acquire('d')).toBeNull();
  });
});
