import {
  OPERATOR_SESSIONS,
  type OperatorSessions,
} from '../../../../application/ports/operator-sessions.js';
import {
  RUN_LOG_SETTINGS,
  type RunLogSettings,
} from '../../../../application/ports/run-log-settings.js';

export class StreamRunEventsEndpoint {
  constructor(
    private readonly sessions: OperatorSessions,
    private readonly settings: RunLogSettings,
  ) {}

  tokens(): symbol[] {
    return [OPERATOR_SESSIONS, RUN_LOG_SETTINGS];
  }

  stream(token: string): Promise<boolean> {
    return this.settings.maxStreams > 0 ? this.sessions.isValid(token) : Promise.resolve(false);
  }
}
