import type { FollowUpComments, FollowUpSource } from './follow-up.js';
import type { RunDeliveryState } from './run-delivery.js';
import type { RunFailureCode } from './run-failure.js';
import { RunResume } from './run-resume.js';
import type { FinalRunState } from './run-state.js';

/**
 * The agent's question to the operator (Issue #103), from a `needs_input` step result: its
 * text, the options it offers and the one it recommends. The agent's text: never markup.
 */
export interface RunQuestion {
  text: string;
  options?: string[];
  recommendation?: string;
}

/**
 * What a bring-up-to-date Follow-up (`source: 'bring_up_to_date'`, Issue #147) records besides its
 * text, which is then the operator's optional note (empty when there is none). `mergedCommit` is
 * the integration branch commit the Run branch has merged, set once the part succeeded.
 */
export interface BringUpDetails {
  mergedCommit?: string;
  /** The Run branch's commit just before the merge started (reported when it started). */
  updateBase?: string;
  /** The integration branch commit being merged (reported when the merge started). */
  updateTip?: string;
}

/**
 * How a part of the Run (its first part, or a Follow-up) ended (review S1 of #150): recorded
 * when a Follow-up reopens the Run, before its result is cleared, so the earlier result stays
 * in the conversation. `detail` is the failure detail (redacted when it was reported) or the
 * cancellation reason; empty otherwise.
 */
export interface RunPartEnd {
  state: FinalRunState;
  failureCode: RunFailureCode | null;
  delivery: RunDeliveryState | null;
  detail: string;
}

export type RunFollowUpMessage = {
  kind: 'follow_up';
  text: string;
  at: Date;
  source?: FollowUpSource;
  /** With source review_comments (Issue #146): how many comments, and whose. */
  sourceComments?: FollowUpComments;
} & BringUpDetails;

export type RunPartEndMessage = { kind: 'part_end'; at: Date } & RunPartEnd;

/**
 * One turn of the Run's conversation after its Task (Issue #103), in order: the agent's
 * question, the operator's answer to it, or the operator's Follow-up to the finished Run
 * (Issue #141).
 */
export type RunMessage =
  | { kind: 'question'; question: RunQuestion; at: Date }
  | { kind: 'answer'; text: string; at: Date }
  | RunFollowUpMessage
  | RunPartEndMessage;

/** What a Run's conversation stores of it. */
export interface RunConversationStored {
  /** The agent's questions, the operator's answers and Follow-ups, in order (Issue #103). */
  messages: RunMessage[];
}

/**
 * The conversation of a Run (Issue #103): the ordered Questions, Answers and Follow-ups from the
 * Task to its latest result. A change returns a new conversation. It answers what the Run needs
 * to know of it: whether a Question awaits an Answer, which message resumes the agent session,
 * and what a bring-up-to-date request (Issue #147) recorded.
 */
export class RunConversation {
  /** Longest operator answer to an agent's question, in characters (Issue #103). */
  static readonly ANSWER_MAX_LENGTH = 10_000;

  /**
   * The message that resumes a Run stopped at the subscription's usage limit (Issue #105): sent
   * to the agent as the next message of its session, stored as the operator's answer.
   */
  static readonly USAGE_LIMIT_RESUME_TEXT = 'Continue where you stopped.';

  /**
   * What the claim hands the worker as the text of a bring-up-to-date request that has no note
   * (Issue #147): the worker words the instruction to the agent itself, with the merge's outcome.
   * The same text as the worker protocol's (the domain does not import the contracts package).
   */
  static readonly BRING_UP_TO_DATE_DEFAULT_TEXT = 'Bring the Run branch up to date.';

  readonly messages: readonly RunMessage[];

  private constructor(messages: readonly RunMessage[]) {
    this.messages = messages;
  }

  static of(messages: readonly RunMessage[]): RunConversation {
    return new RunConversation([...messages]);
  }

  static restore(stored: RunConversationStored): RunConversation {
    return RunConversation.of(stored.messages);
  }

  toStored(): RunConversationStored {
    return { messages: [...this.messages] };
  }

  /** What the conversation says when a bring-up-to-date request found nothing to merge (Issue #147). */
  static alreadyUpToDateDetail(integrationBranch: string): string {
    return (
      `The Run branch already has everything ${integrationBranch} has, so nothing was changed: ` +
      'no agent was started and nothing was pushed.'
    );
  }

  /** The conversation with `message` added at the end. */
  append(message: RunMessage): RunConversation {
    return new RunConversation([...this.messages, message]);
  }

  /** Whether its last message is the agent's question: an Answer is due. */
  get awaitsAnswer(): boolean {
    return this.messages.at(-1)?.kind === 'question';
  }

  private get latestFollowUp(): RunFollowUpMessage | undefined {
    const last = this.messages.findLast((message) => message.kind === 'follow_up');
    return last?.kind === 'follow_up' ? last : undefined;
  }

  /**
   * Whether the Run's current part is a request to bring the Run branch up to date (Issue #147):
   * its latest Follow-up has that source. The part goes on through questions and the usage limit.
   */
  get inBringUpToDate(): boolean {
    return this.latestFollowUp?.source === 'bring_up_to_date';
  }

  /** The integration branch commit the Run branch last merged (Issue #147), if it ever did. */
  latestMergedCommit(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index]!;
      if (message.kind === 'follow_up' && message.mergedCommit !== undefined) {
        return message.mergedCommit;
      }
    }
    return undefined;
  }

  /**
   * A bring-up-to-date merge the part before the current one began and that never succeeded
   * (review R2-1 of #154): the Follow-up right before the current part, a bring-up request with
   * the commit before its merge and no merged commit. Its merge commit may still be in the
   * Working copy (cancelled while waiting, a lost worker); the next part resets the Run branch to
   * `baseCommit` first, unless something past it was pushed (`pushedCommit`, the Run's).
   * `undefined` when there is none.
   */
  pendingUpdate(
    pushedCommit: string | null,
  ): { baseCommit: string; pushedCommit?: string } | undefined {
    // Only the part right before the current one: once that part reset the branch (or any later
    // part built on it), the base is not offered again, so nothing a later part did is undone.
    const followUps = this.messages.flatMap((message, index) =>
      message.kind === 'follow_up' ? [index] : [],
    );
    const lastIndex = followUps.at(-2) ?? -1;
    if (lastIndex === -1) return undefined;
    const entry = this.messages[lastIndex];
    if (entry?.kind !== 'follow_up' || entry.source !== 'bring_up_to_date') return undefined;
    if (entry.updateBase === undefined || entry.mergedCommit !== undefined) return undefined;
    return {
      baseCommit: entry.updateBase,
      ...(pushedCommit === null ? {} : { pushedCommit }),
    };
  }

  /** The latest Follow-up's merge start when the current part is a bring-up request (Issue #147). */
  currentUpdateStart(): { updateBase?: string; updateTip?: string } | undefined {
    const last = this.latestFollowUp;
    if (last?.source !== 'bring_up_to_date') return undefined;
    return {
      ...(last.updateBase === undefined ? {} : { updateBase: last.updateBase }),
      ...(last.updateTip === undefined ? {} : { updateTip: last.updateTip }),
    };
  }

  /** Whether the merge's start can be recorded: the latest Follow-up is a bring-up with none yet. */
  get canRecordUpdateStart(): boolean {
    const entry = this.latestFollowUp;
    return entry?.source === 'bring_up_to_date' && entry.updateTip === undefined;
  }

  /**
   * The commit the latest bring-up-to-date Follow-up merged, once there is one to record: its
   * `updateTip`, while no `mergedCommit` is recorded yet (Issue #147).
   */
  get mergeToRecord(): string | undefined {
    const entry = this.latestFollowUp;
    if (
      entry?.source !== 'bring_up_to_date' ||
      entry.updateTip === undefined ||
      entry.mergedCommit !== undefined
    ) {
      return undefined;
    }
    return entry.updateTip;
  }

  /**
   * The end of the part before a bring-up-to-date request that is the current part (the
   * `part_end` right before its Follow-up, Issue #147); `undefined` when the current part is
   * not such a request.
   */
  get partEndBeforeBringUp(): RunPartEndMessage | undefined {
    const index = this.messages.findLastIndex((message) => message.kind === 'follow_up');
    const entry = this.messages[index];
    const before = this.messages[index - 1];
    if (entry?.kind !== 'follow_up' || entry.source !== 'bring_up_to_date') return undefined;
    return before?.kind === 'part_end' ? before : undefined;
  }

  /** The conversation with `details` recorded on its latest Follow-up (Issue #147). */
  withFollowUpDetails(details: BringUpDetails): RunConversation {
    const index = this.messages.findLastIndex((message) => message.kind === 'follow_up');
    const entry = this.messages[index];
    if (entry?.kind !== 'follow_up') return this;
    const messages = [...this.messages];
    messages[index] = { ...entry, ...details };
    return new RunConversation(messages);
  }

  /**
   * The message that resumes the Run's agent session, and why (Issue #103, #105, #141): the
   * operator's latest message while it is the last one and the Run has an agent session
   * (`hasSession`); otherwise `null`. A Follow-up resumes as `follow_up`; an answer right after
   * the agent's question as `answer`; any other answer is the usage-limit resume's "Continue
   * where you stopped." (`usage_limit`). A resumed step that asks again adds a question after
   * it, so it is never handed out twice.
   */
  resumeMessage(hasSession: boolean): RunResume | null {
    const last = this.messages.at(-1);
    if (!hasSession || last === undefined) return null;
    if (last.kind === 'question' || last.kind === 'part_end') return null;
    if (last.kind === 'follow_up') {
      return last.source === 'bring_up_to_date'
        ? RunResume.of(
            last.text === '' ? RunConversation.BRING_UP_TO_DATE_DEFAULT_TEXT : last.text,
            'bring_up_to_date',
          )
        : RunResume.of(last.text, 'follow_up');
    }
    const before = this.messages.at(-2);
    return RunResume.of(last.text, before?.kind === 'question' ? 'answer' : 'usage_limit');
  }
}
