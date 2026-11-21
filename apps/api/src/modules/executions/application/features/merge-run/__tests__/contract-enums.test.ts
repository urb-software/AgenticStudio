import {
  CLOSE_PULL_REQUEST_REFUSALS,
  MERGE_APPROVAL_REFUSAL_CODES as CONTRACT_APPROVAL_REFUSAL_CODES,
  MERGE_APPROVAL_RESULTS as CONTRACT_RESULTS,
  MERGE_CHECK_STATES as CONTRACT_CHECK_STATES,
  MERGE_METHODS as CONTRACT_METHODS,
  MERGE_REFUSALS,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { CLOSE_PULL_REQUEST_REFUSAL_CODES } from '../../../../domain/value-objects/close-pull-request-refusal.js';
import { MERGE_APPROVAL_REFUSAL_CODES } from '../../../../domain/value-objects/merge-approval-refusal-code.js';
import { MERGE_APPROVAL_RESULTS } from '../../../../domain/value-objects/merge-approval-result.js';
import { MERGE_CHECK_STATES } from '../../../../domain/value-objects/merge-check-seen.js';
import { MERGE_METHODS } from '../../../../domain/value-objects/merge-method.js';
import { MERGE_REFUSAL_CODES } from '../../../../domain/value-objects/merge-refusal.js';

// The domain may not import the contract package, so each list is pinned to the contract's here.
describe('the domain lists of the merge match the contract', () => {
  it.each([
    ['refusals', MERGE_REFUSAL_CODES, MERGE_REFUSALS],
    ['stored refusal codes', MERGE_APPROVAL_REFUSAL_CODES, CONTRACT_APPROVAL_REFUSAL_CODES],
    ['results', MERGE_APPROVAL_RESULTS, CONTRACT_RESULTS],
    ['methods', MERGE_METHODS, CONTRACT_METHODS],
    ['check states', MERGE_CHECK_STATES, CONTRACT_CHECK_STATES],
    ['close refusals', CLOSE_PULL_REQUEST_REFUSAL_CODES, CLOSE_PULL_REQUEST_REFUSALS],
  ])('%s', (_name, domain, contract) => {
    expect([...domain]).toEqual([...contract]);
  });
});
