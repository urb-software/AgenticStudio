import type { ExecutionLogEvent } from '../../../entry-points/http/shared/execution-log-event.js';

export class StreamExecutionLogHandler {
  execute(line: string): ExecutionLogEvent {
    return { line, at: new Date(0).toISOString() };
  }
}
