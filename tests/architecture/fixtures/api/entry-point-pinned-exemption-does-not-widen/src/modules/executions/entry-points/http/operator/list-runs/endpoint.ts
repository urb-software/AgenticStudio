import {
  OPERATOR_SESSIONS,
  type OperatorSessions,
} from '../../../../application/ports/operator-sessions.js';

export class ListRunsEndpoint {
  constructor(private readonly sessions: OperatorSessions) {}

  token(): symbol {
    return OPERATOR_SESSIONS;
  }

  check(token: string): Promise<boolean> {
    return this.sessions.isValid(token);
  }
}
