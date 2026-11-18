import { WORKER_RUNNER_MODES as PROTOCOL_MODES } from '@agentic-studio/contracts';
import { expect, it } from 'vitest';
import { WORKER_RUNNER_MODES } from '../worker-runner-mode.js';

it('lists the runner modes of the worker protocol', () => {
  expect([...WORKER_RUNNER_MODES]).toEqual([...PROTOCOL_MODES]);
});
