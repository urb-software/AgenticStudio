import type { RunQuestion } from './run-question.js';
import type { RunFollowUpMessage } from './run-follow-up-message.js';
import type { RunPartEndMessage } from './run-part-end-message.js';

export type RunMessage =
  | { kind: 'question'; question: RunQuestion; at: Date }
  | { kind: 'answer'; text: string; at: Date }
  | RunFollowUpMessage
  | RunPartEndMessage;
