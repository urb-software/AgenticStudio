import {
  type AppendOperationLogResponse,
  appendOperationLogRequestSchema,
  type OperationLogLine,
} from '@agentic-studio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cutUtf8, LogSink } from '../log-sink.js';

const CONTROLLER_ID = '6f0e4c1a-2b1f-4a3e-9c1a-0d2d9a3b7c11';

function makeSink(answer: (lines: OperationLogLine[]) => AppendOperationLogResponse | Error) {
  const batches: OperationLogLine[][] = [];
  const errors: unknown[] = [];
  const sink = new LogSink({
    send: async (lines) => {
      batches.push(lines);
      const result = answer(lines);
      if (result instanceof Error) throw result;
      return result;
    },
    flushMs: 1000,
    onError: (error) => errors.push(error),
  });
  return { sink, batches, errors };
}

const ok = (lines: OperationLogLine[]) => ({ stored: lines.length, truncated: false });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('cutUtf8', () => {
  it('keeps short text and cuts long text on a character boundary', () => {
    expect(cutUtf8('abc', 10)).toEqual({ text: 'abc', cut: false });
    expect(cutUtf8('abcdef', 3)).toEqual({ text: 'abc', cut: true });
    // Each character below is three bytes: a cut at 4 keeps one whole character.
    const cut = cutUtf8('€€€', 4);
    expect(cut).toEqual({ text: '€', cut: true });
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(4);
  });
});

describe('LogSink', () => {
  it('sends after one second, with increasing seq, stream and an ISO time', async () => {
    const { sink, batches } = makeSink(ok);
    sink.write('build', 'step 1');
    sink.write('start', 'step 2');
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((line) => [line.seq, line.stream, line.text])).toEqual([
      [1, 'build', 'step 1'],
      [2, 'start', 'step 2'],
    ]);
    expect(batches[0]![0]!.at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(() =>
      appendOperationLogRequestSchema.parse({ controllerId: CONTROLLER_ID, lines: batches[0] }),
    ).not.toThrow();
  });

  it('sends at 100 lines without waiting', async () => {
    const { sink, batches } = makeSink(ok);
    for (let index = 0; index < 250; index += 1) sink.write('build', `line ${index}`);
    await sink.flush();
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat().map((line) => line.seq)).toEqual(
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
  });

  it('keeps every batch within 64 KiB of text', async () => {
    const { sink, batches } = makeSink(ok);
    for (let index = 0; index < 60; index += 1) sink.write('build', 'x'.repeat(2000));
    await sink.flush();
    for (const batch of batches) {
      const bytes = batch.reduce((sum, line) => sum + Buffer.byteLength(line.text), 0);
      expect(bytes).toBeLessThanOrEqual(64 * 1024);
      expect(() =>
        appendOperationLogRequestSchema.parse({ controllerId: CONTROLLER_ID, lines: batch }),
      ).not.toThrow();
    }
    expect(batches.flat()).toHaveLength(60);
  });

  it('cuts a line at 2048 bytes and marks it', async () => {
    const { sink, batches } = makeSink(ok);
    sink.write('build', 'a'.repeat(5000));
    sink.write('build', 'short');
    await sink.flush();
    const [long, short] = batches[0]!;
    expect(Buffer.byteLength(long!.text)).toBe(2048);
    expect(long!.truncated).toBe(true);
    expect(short).not.toHaveProperty('truncated');
  });

  it('stops sending once the API says it truncated', async () => {
    const { sink, batches } = makeSink(() => ({ stored: 1, truncated: true }));
    sink.write('build', 'one');
    await sink.flush();
    sink.write('build', 'two');
    sink.write('build', 'three');
    await sink.flush();
    expect(batches).toHaveLength(1);
    expect(sink.truncated).toBe(true);
  });

  it('keeps one batch in flight at a time and in order', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let overlap = false;
    const sink = new LogSink({
      send: async (lines) => {
        inFlight += 1;
        overlap ||= inFlight > 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(lines[0]!.seq);
        inFlight -= 1;
        return { stored: lines.length, truncated: false };
      },
    });
    for (let index = 0; index < 205; index += 1) sink.write('build', `l${index}`);
    const done = sink.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(overlap).toBe(false);
    expect(order).toEqual([1, 101, 201]);
  });

  it('reports a failed send to onError and rejects the next flush once', async () => {
    const { sink, errors } = makeSink(() => new Error('down'));
    sink.write('build', 'one');
    await expect(sink.flush()).rejects.toThrow('down');
    expect(errors).toHaveLength(1);
    sink.write('build', 'two');
    await expect(sink.flush()).rejects.toThrow('down');
  });

  it('does nothing for a flush with nothing collected', async () => {
    const { sink, batches } = makeSink(ok);
    await sink.flush();
    expect(batches).toHaveLength(0);
  });
});
