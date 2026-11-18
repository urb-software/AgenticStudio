import type { ExecutionLogEvent } from '../../../entry-points/http/shared/execution-log-event.js';

export type StreamExecutionLogInput = string;
export type StreamExecutionLogResult = ExecutionLogEvent;

export class StreamExecutionLogHandler {
  execute(line: StreamExecutionLogInput): StreamExecutionLogResult {
    return { line, at: new Date(0).toISOString() };
  }
}
