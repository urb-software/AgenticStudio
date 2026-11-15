import {
  RUN_EVENT_KINDS as WORKER_EVENT_KINDS,
  PROVIDERS as WORKER_PROVIDERS,
  RUN_FAILURE_CODES as WORKER_FAILURE_CODES,
  RUN_STATES as WORKER_RUN_STATES,
  TASK_MAX_LENGTH as WORKER_TASK_MAX_LENGTH,
  WORKER_REPORTED_STATES,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { runEventKindSchema } from '../../../contracts/http/run-event-response.js';
import {
  runFailureCodeSchema,
  runProviderSchema,
  runStateSchema,
} from '../../../contracts/http/run-response.js';
import {
  PROVIDERS,
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
  });

  it('worker protocol: the same states, providers, failure codes and Task limit', () => {
    expect([...WORKER_RUN_STATES]).toEqual([...RUN_STATES]);
    expect([...WORKER_PROVIDERS]).toEqual([...PROVIDERS]);
    expect([...WORKER_FAILURE_CODES]).toEqual([...RUN_FAILURE_CODES]);
    expect(WORKER_TASK_MAX_LENGTH).toBe(TASK_MAX_LENGTH);
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
