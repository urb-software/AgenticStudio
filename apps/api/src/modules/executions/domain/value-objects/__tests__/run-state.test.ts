import { describe, expect, it } from 'vitest';
import { isRunId } from '../run-id.js';
import {
  CLAIMED_RUN_STATES,
  FINAL_RUN_STATES,
  isClaimedRunState,
  isFinalRunState,
  isRunState,
  RUN_STATES,
  UNDER_WAY_RUN_STATES,
} from '../run-state.js';

describe('Run states', () => {
  it('knows its states, and only them', () => {
    for (const state of RUN_STATES) expect(isRunState(state)).toBe(true);
    expect(isRunState('paused')).toBe(false);
    expect(isRunState('')).toBe(false);
  });

  it('groups them: under way, held by a worker, final', () => {
    expect([...UNDER_WAY_RUN_STATES]).toEqual(['queued', 'preparing', 'running']);
    expect([...CLAIMED_RUN_STATES]).toEqual(['preparing', 'running']);
    expect([...FINAL_RUN_STATES]).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
    expect(RUN_STATES.filter(isClaimedRunState)).toEqual(['preparing', 'running']);
    expect(RUN_STATES.filter(isFinalRunState)).toEqual([...FINAL_RUN_STATES]);
  });
});

describe('Run id', () => {
  it('is a UUID; anything else names no Run', () => {
    expect(isRunId('0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b')).toBe(true);
    expect(isRunId('0B8E5C2D-1F3A-4D6E-9A7B-2C4D6E8F0A1B')).toBe(true);
    expect(isRunId('not-a-run')).toBe(false);
    expect(isRunId('')).toBe(false);
    expect(isRunId('0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b-extra')).toBe(false);
  });
});
