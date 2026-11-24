import { describe, expect, it } from 'vitest';
import { InMemoryControllerPresence } from '../in-memory-controller-presence.js';

const STARTED = new Date('2026-11-24T10:00:00.000Z');
const at = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);

describe('InMemoryControllerPresence', () => {
  it('has seen nobody since the start, and knows nothing in the first lease', () => {
    const presence = new InMemoryControllerPresence(STARTED);

    expect(presence.availability(60).connected(at(10))).toBe(false);
    expect(presence.availability(60).knownAbsent(at(59))).toBe(false);
    expect(presence.availability(60).knownAbsent(at(60))).toBe(true);
  });

  it('is connected within a lease of the latest call', () => {
    const presence = new InMemoryControllerPresence(STARTED);

    presence.record(at(100));

    expect(presence.availability(60).connected(at(160))).toBe(true);
    expect(presence.availability(60).connected(at(161))).toBe(false);
  });

  it('keeps the latest call, whatever order the calls are recorded in', () => {
    const presence = new InMemoryControllerPresence(STARTED);

    presence.record(at(300));
    presence.record(at(60));

    expect(presence.availability(60).connected(at(350))).toBe(true);
  });
});
