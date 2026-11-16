import {
  ANSWER_MAX_LENGTH as WORKER_ANSWER_MAX_LENGTH,
  FOLLOW_UP_MAX_LENGTH as WORKER_FOLLOW_UP_MAX_LENGTH,
  RUN_EVENT_KINDS as WORKER_EVENT_KINDS,
  PROVIDERS as WORKER_PROVIDERS,
  RUN_FAILURE_CODES as WORKER_FAILURE_CODES,
  RUN_STATES as WORKER_RUN_STATES,
  TASK_MAX_LENGTH as WORKER_TASK_MAX_LENGTH,
  WORKER_PROBLEM_TYPES,
  WORKER_REPORTED_STATES,
} from '@agentic-studio/contracts';
import { EXECUTIONS_PROBLEM_TYPES } from '../../../contracts/http/problems.js';
import { describe, expect, it } from 'vitest';
import { runEventKindSchema } from '../../../contracts/http/run-event-response.js';
import {
  followUpRefusalSchema,
  runCancelledBySchema,
  runDeliverySchema,
  runFailureCodeSchema,
  runProviderSchema,
  runStateSchema,
} from '../../../contracts/http/run-response.js';
import {
  ANSWER_MAX_LENGTH,
  FOLLOW_UP_MAX_LENGTH,
  FOLLOW_UP_REFUSALS,
  PROVIDERS,
  RUN_CANCELLED_BY,
  RUN_DELIVERIES,
  RUN_FAILURE_CODES,
  RUN_STATES,
  TASK_MAX_LENGTH,
} from '../../../domain/entities/run.js';
import { RUN_EVENT_KINDS } from '../../../domain/entities/run-event.js';

// contracts/http may not import the domain (backend.md §2), and the shared worker protocol
// cannot import the API, so both carry their own lists; this pins them to the domain's.
describe('Run enums of the HTTP contract and the worker protocol (Issue #96)', () => {
  it('HTTP: lists exactly the domain states, providers and failure codes', () => {
    expect(runStateSchema.options).toEqual([...RUN_STATES]);
    expect(runProviderSchema.options).toEqual([...PROVIDERS]);
    expect(runFailureCodeSchema.options).toEqual([...RUN_FAILURE_CODES]);
    expect(runCancelledBySchema.options).toEqual([...RUN_CANCELLED_BY]);
    // Issue #102.
    expect(runDeliverySchema.options).toEqual([...RUN_DELIVERIES]);
    // Issue #141.
    expect(followUpRefusalSchema.options).toEqual([...FOLLOW_UP_REFUSALS]);
  });

  it('worker protocol: the same states, providers, failure codes and Task limit', () => {
    expect([...WORKER_RUN_STATES]).toEqual([...RUN_STATES]);
    expect([...WORKER_PROVIDERS]).toEqual([...PROVIDERS]);
    expect([...WORKER_FAILURE_CODES]).toEqual([...RUN_FAILURE_CODES]);
    expect(WORKER_TASK_MAX_LENGTH).toBe(TASK_MAX_LENGTH);
    // Issue #141: the Follow-up and the answer travel in the same payload field.
    expect(WORKER_FOLLOW_UP_MAX_LENGTH).toBe(FOLLOW_UP_MAX_LENGTH);
    expect(WORKER_ANSWER_MAX_LENGTH).toBe(ANSWER_MAX_LENGTH);
  });

  it("worker protocol: the problem types the worker acts on are the API's (review of #121)", () => {
    expect(WORKER_PROBLEM_TYPES).toEqual({
      runNotHeld: EXECUTIONS_PROBLEM_TYPES.runNotHeld,
      runNotFound: EXECUTIONS_PROBLEM_TYPES.runNotFound,
      stepLimitReached: EXECUTIONS_PROBLEM_TYPES.stepLimitReached,
    });
  });

  it('worker protocol: a worker reports only domain states', () => {
    expect(WORKER_REPORTED_STATES.every((state) => RUN_STATES.includes(state))).toBe(true);
  });
});

describe('Run event kinds of the HTTP contract and the worker protocol (Issue #99)', () => {
  it('lists exactly the domain kinds on both', () => {
    expect(runEventKindSchema.options).toEqual([...RUN_EVENT_KINDS]);
    expect([...WORKER_EVENT_KINDS]).toEqual([...RUN_EVENT_KINDS]);
  });
});
