import { describe, expect, it } from 'vitest';
import { LogRedaction, REDACTED } from '../log-redaction.js';
import { RunEvent } from '../run-event.js';

const reported = (text: string, truncated?: boolean) => ({
  seq: 1,
  at: new Date('2026-11-18T10:00:00.000Z'),
  stepIndex: 1,
  kind: 'output' as const,
  text,
  ...(truncated === undefined ? {} : { truncated }),
});

describe('RunEvent', () => {
  it('redacts the text before it cuts it, and marks the cut', () => {
    const event = RunEvent.load(reported('abcd '.repeat(5000)), LogRedaction.of(['abcd']));

    expect(Buffer.byteLength(event.text, 'utf8')).toBeLessThanOrEqual(RunEvent.TEXT_MAX_BYTES);
    expect(event.text.startsWith(REDACTED)).toBe(true);
    expect(event.truncated).toBe(true);
  });

  it('keeps a short text and the flag the worker sent', () => {
    expect(RunEvent.load(reported('short'), LogRedaction.NONE).truncated).toBe(false);
    expect(RunEvent.load(reported('short', true), LogRedaction.NONE).truncated).toBe(true);
  });

  it('restores a stored event without cutting or redacting it', () => {
    const long = 'z'.repeat(RunEvent.TEXT_MAX_BYTES + 10);
    const stored = RunEvent.restore({ ...reported(long), truncated: false });

    expect(stored.text).toBe(long);
    expect(stored.truncated).toBe(false);
  });
});
