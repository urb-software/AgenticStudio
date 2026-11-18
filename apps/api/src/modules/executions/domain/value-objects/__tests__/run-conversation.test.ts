import { describe, expect, it } from 'vitest';
import { RunConversation } from '../run-conversation.js';
import { type RunMessage } from '../run-message.js';

const at = new Date('2026-11-16T12:00:00.000Z');
const question: RunMessage = { kind: 'question', question: { text: 'Which?' }, at };
const answer: RunMessage = { kind: 'answer', text: 'This one.', at };
const followUp: RunMessage = { kind: 'follow_up', text: 'Also add tests.', at };
const resume: RunMessage = { kind: 'answer', text: RunConversation.USAGE_LIMIT_RESUME_TEXT, at };
const partEnd: RunMessage = {
  kind: 'part_end',
  state: 'failed',
  failureCode: 'agent_failed',
  delivery: null,
  detail: 'It broke.',
  at,
};
const bringUp = (
  details: Partial<Extract<RunMessage, { kind: 'follow_up' }>> = {},
): RunMessage => ({
  kind: 'follow_up',
  text: '',
  at,
  source: 'bring_up_to_date',
  ...details,
});
const of = (...messages: RunMessage[]) => RunConversation.of(messages);

describe('RunConversation', () => {
  it('is immutable: adding a message returns a new conversation', () => {
    const empty = of();
    const asked = empty.append(question);

    expect(asked).not.toBe(empty);
    expect(empty.messages).toEqual([]);
    expect(asked.messages).toEqual([question]);
    expect(asked.toStored()).toEqual({ messages: [question] });
  });

  it('does not change when the list it was built from does', () => {
    const list: RunMessage[] = [question];
    const conversation = RunConversation.of(list);
    list.push(answer);
    expect(conversation.messages).toEqual([question]);
  });

  it('awaits an answer exactly while its last message is the question', () => {
    expect(of().awaitsAnswer).toBe(false);
    expect(of(question).awaitsAnswer).toBe(true);
    expect(of(question, answer).awaitsAnswer).toBe(false);
  });

  it('keeps the limits and texts the operator-facing rules use', () => {
    expect(RunConversation.ANSWER_MAX_LENGTH).toBe(10_000);
    expect(RunConversation.USAGE_LIMIT_RESUME_TEXT).toBe('Continue where you stopped.');
    expect(RunConversation.alreadyUpToDateDetail('dev')).toContain(
      'already has everything dev has',
    );
  });
});

describe('RunConversation.resumeMessage', () => {
  it('resumes the session with the Follow-up, an answer or the usage-limit message, and says which', () => {
    expect(of(followUp).resumeMessage(true)).toEqual({
      text: 'Also add tests.',
      reason: 'follow_up',
    });
    expect(of(question, answer).resumeMessage(true)).toEqual({
      text: 'This one.',
      reason: 'answer',
    });
    expect(of(followUp, question, answer).resumeMessage(true)).toEqual({
      text: 'This one.',
      reason: 'answer',
    });
    expect(of(resume).resumeMessage(true)).toEqual({
      text: RunConversation.USAGE_LIMIT_RESUME_TEXT,
      reason: 'usage_limit',
    });
    expect(of(followUp, resume).resumeMessage(true)).toEqual({
      text: RunConversation.USAGE_LIMIT_RESUME_TEXT,
      reason: 'usage_limit',
    });
  });

  it('resumes nothing while the agent waits for an answer, after a part end, or without a session', () => {
    expect(of(followUp, question).resumeMessage(true)).toBeNull();
    expect(of(partEnd).resumeMessage(true)).toBeNull();
    expect(of().resumeMessage(true)).toBeNull();
    expect(of(followUp).resumeMessage(false)).toBeNull();
    expect(of(partEnd, followUp).resumeMessage(true)).toEqual({
      text: 'Also add tests.',
      reason: 'follow_up',
    });
  });

  it('words a bring-up-to-date request without a note with the default text', () => {
    expect(of(bringUp()).resumeMessage(true)).toEqual({
      text: RunConversation.BRING_UP_TO_DATE_DEFAULT_TEXT,
      reason: 'bring_up_to_date',
    });
    expect(of(bringUp({ text: 'Keep ours.' })).resumeMessage(true)).toEqual({
      text: 'Keep ours.',
      reason: 'bring_up_to_date',
    });
  });
});

describe('RunConversation and a bring-up-to-date request', () => {
  const base = 'a'.repeat(40);
  const tip = 'b'.repeat(40);

  it('is in one while its latest Follow-up is one', () => {
    expect(of(followUp).inBringUpToDate).toBe(false);
    expect(of(bringUp()).inBringUpToDate).toBe(true);
    expect(of(bringUp(), question, answer).inBringUpToDate).toBe(true);
    expect(of(bringUp(), partEnd, followUp).inBringUpToDate).toBe(false);
  });

  it('records where the merge started once, and what it merged', () => {
    const started = of(bringUp()).withFollowUpDetails({ updateBase: base, updateTip: tip });

    expect(of(bringUp()).canRecordUpdateStart).toBe(true);
    expect(started.canRecordUpdateStart).toBe(false);
    expect(of(followUp).canRecordUpdateStart).toBe(false);
    expect(started.currentUpdateStart()).toEqual({ updateBase: base, updateTip: tip });
    expect(started.latestMergedCommit()).toBeUndefined();
    expect(started.mergeToRecord).toBe(tip);

    const merged = started.withFollowUpDetails({ mergedCommit: tip });
    expect(merged.latestMergedCommit()).toBe(tip);
    expect(merged.mergeToRecord).toBeUndefined();
    expect(started.latestMergedCommit()).toBeUndefined();
  });

  it('has no start of a merge for a Follow-up that is not a request, nor a conversation without one', () => {
    expect(of(followUp).currentUpdateStart()).toBeUndefined();
    expect(of().withFollowUpDetails({ updateBase: base }).messages).toEqual([]);
  });

  it('offers the base of a merge the part before the current one left unfinished', () => {
    const failedPart = [
      bringUp({ updateBase: base, updateTip: tip }),
      { ...partEnd, delivery: null } as RunMessage,
    ];
    expect(of(...failedPart).pendingUpdate(null)).toBeUndefined();
    expect(of(...failedPart, followUp).pendingUpdate(null)).toEqual({ baseCommit: base });
    expect(of(...failedPart, followUp).pendingUpdate('c'.repeat(40))).toEqual({
      baseCommit: base,
      pushedCommit: 'c'.repeat(40),
    });
    expect(
      of(...failedPart, followUp, partEnd, { ...followUp, text: 'Third.' }).pendingUpdate(null),
    ).toBeUndefined();
    expect(
      of(
        bringUp({ updateBase: base, updateTip: tip, mergedCommit: tip }),
        partEnd,
        followUp,
      ).pendingUpdate(null),
    ).toBeUndefined();
  });

  it('finds the end of the part before a bring-up request, only while it is the current part', () => {
    expect(of(partEnd, bringUp()).partEndBeforeBringUp).toEqual(partEnd);
    expect(of(bringUp()).partEndBeforeBringUp).toBeUndefined();
    expect(of(partEnd, followUp).partEndBeforeBringUp).toBeUndefined();
    expect(of().partEndBeforeBringUp).toBeUndefined();
  });
});
