import { RunResume } from './run-resume.js';
import type { BringUpDetails } from './bring-up-details.js';
import type { RunFollowUpMessage } from './run-follow-up-message.js';
import type { RunPartEndMessage } from './run-part-end-message.js';
import type { RunMessage } from './run-message.js';

export interface RunConversationData {
  messages: readonly RunMessage[];
}

export class RunConversation {
  static readonly ANSWER_MAX_LENGTH = 10_000;

  /** The text of a Follow-up: the same limit as an answer, pinned to the worker protocol by a test. */
  static readonly FOLLOW_UP_MAX_LENGTH = 10_000;

  /** Sent to the agent as the next message of its session, stored as the operator's answer. */
  static readonly USAGE_LIMIT_RESUME_TEXT = 'Continue where you stopped.';

  /** The same text as the worker protocol's (the domain does not import the contracts package). */
  static readonly BRING_UP_TO_DATE_DEFAULT_TEXT = 'Bring the Run branch up to date.';

  readonly messages: readonly RunMessage[];

  private constructor(messages: readonly RunMessage[]) {
    this.messages = messages;
  }

  static of(messages: readonly RunMessage[]): RunConversation {
    return new RunConversation([...messages]);
  }

  static restore(stored: RunConversationData): RunConversation {
    return RunConversation.of(stored.messages);
  }

  toData(): RunConversationData {
    return { messages: [...this.messages] };
  }

  append(message: RunMessage): RunConversation {
    return new RunConversation([...this.messages, message]);
  }

  get awaitsAnswer(): boolean {
    return this.messages.at(-1)?.kind === 'question';
  }

  private get latestFollowUp(): RunFollowUpMessage | undefined {
    const last = this.messages.findLast((message) => message.kind === 'follow_up');
    return last?.kind === 'follow_up' ? last : undefined;
  }

  get inBringUpToDate(): boolean {
    return this.latestFollowUp?.source === 'bring_up_to_date';
  }

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
   * A bring-up merge of the part before the current one that never succeeded: its merge commit may
   * still be in the Working copy, so the next part resets the Run branch to `baseCommit` first,
   * unless something past it was pushed (`pushedCommit`).
   */
  pendingUpdate(
    pushedCommit: string | null,
  ): { baseCommit: string; pushedCommit?: string } | undefined {
    // Only the part right before the current one: once it (or a later part) reset the branch, the
    // base is not offered again, so nothing a later part did is undone.
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

  currentUpdateStart(): { updateBase?: string; updateTip?: string } | undefined {
    const last = this.latestFollowUp;
    if (last?.source !== 'bring_up_to_date') return undefined;
    return {
      ...(last.updateBase === undefined ? {} : { updateBase: last.updateBase }),
      ...(last.updateTip === undefined ? {} : { updateTip: last.updateTip }),
    };
  }

  get canRecordUpdateStart(): boolean {
    const entry = this.latestFollowUp;
    return entry?.source === 'bring_up_to_date' && entry.updateTip === undefined;
  }

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

  get partEndBeforeBringUp(): RunPartEndMessage | undefined {
    const index = this.messages.findLastIndex((message) => message.kind === 'follow_up');
    const entry = this.messages[index];
    const before = this.messages[index - 1];
    if (entry?.kind !== 'follow_up' || entry.source !== 'bring_up_to_date') return undefined;
    return before?.kind === 'part_end' ? before : undefined;
  }

  withFollowUpDetails(details: BringUpDetails): RunConversation {
    const index = this.messages.findLastIndex((message) => message.kind === 'follow_up');
    const entry = this.messages[index];
    if (entry?.kind !== 'follow_up') return this;
    const messages = [...this.messages];
    messages[index] = { ...entry, ...details };
    return new RunConversation(messages);
  }

  /**
   * A resumed step that asks again adds a question after it, so it is never handed out twice. An
   * answer that does not follow a question is the usage-limit resume.
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
