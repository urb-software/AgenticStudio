import type { RunDiff } from '@agentic-studio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../../../domain/value-objects/run-snapshot.js';
import { InMemoryRunDiffRepository } from '../../../../domain/repositories/__tests__/in-memory-run-diff-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotHeldError } from '../../../../domain/repositories/run-repository.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import {
  GetRunDiffFileHandler,
  RunDiffFileNotFoundError,
} from '../../get-run-diff-file/handler.js';
import { GetRunDiffHandler, RunDiffNotFoundError } from '../../get-run-diff/handler.js';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { ReportRunDiffHandler } from '../handler.js';
import { RunNotFoundError } from '../../../../domain/value-objects/run-errors.js';

// Issue #144: the worker's diff report through the handlers, against in-memory stores with the
// database adapter's rules (the HTTP seam with PostgreSQL: run-diff.integration.test.ts).

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-16T12:00:00.000Z');

const STATE = {
  resultTree: 'b'.repeat(40),
  resultCommit: 'c'.repeat(40),
  previousTree: 'd'.repeat(40),
  previousCommit: 'a'.repeat(40),
};

const diffOf = (files: RunDiff['files'], overrides: Partial<RunDiff> = {}): RunDiff => ({
  baseCommit: 'a'.repeat(40),
  includesUnpushed: true,
  truncated: false,
  files,
  ...overrides,
});

describe('ReportRunDiffHandler and GetRunDiffHandler', () => {
  let runs: InMemoryRunRepository;
  let diffs: InMemoryRunDiffRepository;
  let secrets: string[];
  let report: ReportRunDiffHandler;
  let readDiff: GetRunDiffHandler;
  let readFile: GetRunDiffFileHandler;
  let run: RunSnapshot;

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    const executions = inMemoryExecutions(runs);
    diffs = executions.diffs;
    secrets = [];
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a'.repeat(40),
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    run = (await runs.claimNext(WORKER, T0))!;
    report = new ReportRunDiffHandler(
      runs,
      executions.transactions,
      { forRun: (runId) => Promise.resolve(runId === run.id ? secrets : []) },
      { now: () => T0 },
    );
    readDiff = new GetRunDiffHandler(runs, diffs);
    readFile = new GetRunDiffFileHandler(runs, diffs);
  });

  it('stores both diffs; the file list comes without patches, each patch per file', async () => {
    const patch = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: {
        run: diffOf([
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch },
          { path: 'logo.png', status: 'added', additions: 0, deletions: 0, binary: true },
        ]),
        last: diffOf([{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch }]),
        state: STATE,
      },
    });

    const whole = await readDiff.execute({ runId: run.id, scope: 'run' });
    expect(whole).toMatchObject({
      kind: 'computed',
      baseCommit: 'a'.repeat(40),
      includesUnpushed: true,
      truncated: false,
    });
    expect(whole.kind === 'computed' && whole.files.map((file) => file.path)).toEqual([
      'a.ts',
      'logo.png',
    ]);
    expect(JSON.stringify(whole)).not.toContain('@@');
    expect(await readFile.execute({ runId: run.id, scope: 'run', path: 'a.ts' })).toMatchObject({
      path: 'a.ts',
      patch,
    });
    expect(
      await readFile.execute({ runId: run.id, scope: 'run', path: 'logo.png' }),
    ).not.toHaveProperty('patch');
    expect((await readDiff.execute({ runId: run.id, scope: 'last' })).kind).toBe('computed');
  });

  it('redacts known secret values and token-shaped strings in every patch before storing', async () => {
    secrets = ['test-db-password'];
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const patch = `@@ -0,0 +1,2 @@\n+DB=test-db-password\n+TOKEN=${token}\n`;
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: {
        run: diffOf([{ path: 'conf.ts', status: 'added', additions: 2, deletions: 0, patch }]),
        last: diffOf([{ path: 'conf.ts', status: 'added', additions: 2, deletions: 0, patch }]),
        state: STATE,
      },
    });

    for (const scope of ['run', 'last'] as const) {
      const stored = (await readFile.execute({ runId: run.id, scope, path: 'conf.ts' })).patch!;
      expect(stored).toBe(`@@ -0,0 +1,2 @@\n+DB=${REDACTED}\n+TOKEN=${REDACTED}\n`);
    }
  });

  it('never stores a file at the Environment file path', async () => {
    runs.runs.find((candidate) => candidate.id === run.id)!.environmentFilePath = 'config/.env';
    const files: RunDiff['files'] = [
      { path: 'config/.env', status: 'added', additions: 1, deletions: 0, patch: '+A=1\n' },
      // Another spelling of the same path (review L-3 of #149).
      { path: './config/.env', status: 'added', additions: 1, deletions: 0, patch: '+A=1\n' },
      { path: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '+a\n' },
    ];
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: { run: diffOf(files), last: diffOf(files), state: STATE },
    });

    const whole = await readDiff.execute({ runId: run.id, scope: 'run' });
    expect(whole.kind === 'computed' && whole.files.map((file) => file.path)).toEqual(['a.ts']);
    await expect(
      readFile.execute({ runId: run.id, scope: 'run', path: 'config/.env' }),
    ).rejects.toThrow(RunDiffFileNotFoundError);
  });

  it('replaces the stored diffs with each report', async () => {
    const first = diffOf([{ path: 'a.ts', status: 'added', additions: 1, deletions: 0 }]);
    const second = diffOf([{ path: 'b.ts', status: 'added', additions: 1, deletions: 0 }]);
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: { run: first, last: first, state: STATE },
    });
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: { run: second, last: second, state: STATE },
    });

    const whole = await readDiff.execute({ runId: run.id, scope: 'run' });
    expect(whole.kind === 'computed' && whole.files.map((file) => file.path)).toEqual(['b.ts']);
  });

  it('stores why the diffs could not be computed, redacted, for both scopes', async () => {
    secrets = ['test-db-password'];
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: { unavailable: 'git failed near test-db-password' },
    });

    for (const scope of ['run', 'last'] as const) {
      expect(await readDiff.execute({ runId: run.id, scope })).toMatchObject({
        kind: 'unavailable',
        reason: `git failed near ${REDACTED}`,
      });
    }
  });

  it('keeps where the diffs stand for the next claim; an unavailable report keeps it (review S-1 of #149)', async () => {
    const diff = diffOf([]);
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: { run: diff, last: diff, state: STATE },
    });
    expect(await diffs.findState(run.id)).toEqual(STATE);

    await report.execute({ runId: run.id, workerId: WORKER, diffs: { unavailable: 'failed' } });
    expect(await diffs.findState(run.id)).toEqual(STATE);

    await expect(
      report.execute({
        runId: run.id,
        workerId: WORKER,
        diffs: { run: diff, last: diff, state: { ...STATE, resultTree: 'HEAD' } },
      }),
    ).rejects.toThrow();
    expect(await diffs.findState(run.id)).toEqual(STATE);
  });

  it('cuts a reason that redaction lengthened to what is stored (review L-2 of #149)', async () => {
    secrets = ['true'];
    await report.execute({
      runId: run.id,
      workerId: WORKER,
      diffs: { unavailable: 'true '.repeat(100) },
    });

    const stored = await readDiff.execute({ runId: run.id, scope: 'run' });
    expect(stored.kind === 'unavailable' && stored.reason.length).toBe(500);
    expect(stored.kind === 'unavailable' && stored.reason.startsWith(REDACTED)).toBe(true);
  });

  it('refuses a worker that does not hold the Run, and an unknown Run', async () => {
    const diff = diffOf([]);
    await expect(
      report.execute({
        runId: run.id,
        workerId: OTHER_WORKER,
        diffs: { run: diff, last: diff, state: STATE },
      }),
    ).rejects.toThrow(RunNotHeldError);
    await expect(
      report.execute({
        runId: '00000000-0000-4000-8000-000000000000',
        workerId: WORKER,
        diffs: { run: diff, last: diff, state: STATE },
      }),
    ).rejects.toThrow(RunNotFoundError);
    await expect(readDiff.execute({ runId: run.id, scope: 'run' })).rejects.toThrow(
      RunDiffNotFoundError,
    );
  });

  it('reads no diff of an unknown Run', async () => {
    await expect(readDiff.execute({ runId: 'not-a-uuid', scope: 'run' })).rejects.toThrow(
      RunNotFoundError,
    );
    await expect(
      readFile.execute({ runId: 'not-a-uuid', scope: 'run', path: 'a.ts' }),
    ).rejects.toThrow(RunNotFoundError);
  });
});
