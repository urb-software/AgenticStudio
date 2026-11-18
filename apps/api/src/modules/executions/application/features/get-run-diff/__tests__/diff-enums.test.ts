import {
  RUN_DIFF_FILE_STATUSES as WORKER_FILE_STATUSES,
  RUN_DIFF_SCOPES as WORKER_SCOPES,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH as WORKER_UNAVAILABLE_MAX_LENGTH,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { RunDiff } from '../../../../domain/entities/run-diff.js';
import { RunEnvironmentFile } from '../../../../domain/value-objects/run-environment-file.js';
import {
  RUN_DIFF_FILE_STATUSES,
  RUN_DIFF_SCOPES,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH,
} from '../../../../domain/value-objects/run-diff.js';
import {
  runDiffFileSummarySchema,
  runDiffScopeSchema,
} from '../../../../entry-points/http/operator/get-run-diff/schema.js';

// The worker protocol and the HTTP schemas carry their own lists, pinned here to the domain's.
describe('Run diff lists of the domain, the worker protocol and the HTTP schemas (Issue #144)', () => {
  it('lists exactly the domain scopes and file statuses everywhere', () => {
    expect([...WORKER_SCOPES]).toEqual([...RUN_DIFF_SCOPES]);
    expect([...WORKER_FILE_STATUSES]).toEqual([...RUN_DIFF_FILE_STATUSES]);
    expect(runDiffScopeSchema.options).toEqual([...RUN_DIFF_SCOPES]);
    expect(runDiffFileSummarySchema.shape.status.options).toEqual([...RUN_DIFF_FILE_STATUSES]);
    expect(WORKER_UNAVAILABLE_MAX_LENGTH).toBe(RUN_DIFF_UNAVAILABLE_MAX_LENGTH);
  });
});

describe('diff state and Environment file path (review S-1, L-3 of #149)', () => {
  const state = {
    resultTree: 'a'.repeat(40),
    resultCommit: 'b'.repeat(64),
    previousTree: 'c'.repeat(40),
    previousCommit: 'd'.repeat(40),
  };

  it('takes full object ids only', () => {
    expect(RunDiff.isState(state)).toBe(true);
    expect(RunDiff.isState({ ...state, pushedCommit: 'e'.repeat(40) })).toBe(true);
    expect(RunDiff.isState({ ...state, resultTree: 'HEAD' })).toBe(false);
    expect(RunDiff.isState({ ...state, pushedCommit: 'E'.repeat(40) })).toBe(false);
  });

  it('matches the Environment file path in any leading spelling', () => {
    expect(RunEnvironmentFile.at('config/.env').covers('config/.env')).toBe(true);
    expect(RunEnvironmentFile.at('config/.env').covers('./config/.env')).toBe(true);
    expect(RunEnvironmentFile.at('/config/.env').covers('config/.env')).toBe(true);
    expect(RunEnvironmentFile.at('config/.env').covers('config/.env.example')).toBe(false);
    expect(RunEnvironmentFile.at(null).covers('config/.env')).toBe(false);
  });
});
