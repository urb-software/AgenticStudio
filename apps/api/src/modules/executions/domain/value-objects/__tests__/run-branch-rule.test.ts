import { describe, expect, it } from 'vitest';
import { RunBranchRule } from '../run-branch-rule.js';

const RUN_ID = '1A2B3C4D-0000-4000-8000-000000000000';

describe('RunBranchRule', () => {
  const rule = RunBranchRule.of(RUN_ID, 'dev');

  it('accepts the Run branch of this Run, ignoring the case of the id', () => {
    expect(rule.accepts('agent/add-login-r1a2b3c4d')).toBe(true);
  });

  it.each([
    'agent/add-login-r99999999',
    'agent/add-login-r1a2b3c4d0',
    'feature/add-login-r1a2b3c4d',
    'agent/UPPER-r1a2b3c4d',
    'agent/../x-r1a2b3c4d',
    'dev',
  ])('refuses %s', (branch) => {
    expect(rule.accepts(branch)).toBe(false);
  });

  it('refuses the integration branch even when it has the shape', () => {
    expect(
      RunBranchRule.of(RUN_ID, 'agent/add-login-r1a2b3c4d').accepts('agent/add-login-r1a2b3c4d'),
    ).toBe(false);
  });

  it('refuses everything for an id that is not hex', () => {
    expect(RunBranchRule.of('not-a-run-id', 'dev').accepts('agent/x-rnot-a-ru')).toBe(false);
  });
});
