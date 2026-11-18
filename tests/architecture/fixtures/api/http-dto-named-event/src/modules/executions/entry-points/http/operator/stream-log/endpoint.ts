import type { ExecutionLogEvent } from '../../shared/execution-log-event.js';

export const toEvent = (line: string): ExecutionLogEvent => ({
  line,
  at: new Date(0).toISOString(),
});
