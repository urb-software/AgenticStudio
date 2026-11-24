import { describe, expect, it } from 'vitest';
import {
  IllegalPreviewOperationTransitionError,
  PreviewOperationNotHeldError,
} from '../../errors/preview-operation-errors.js';
import { PreviewCommit } from '../../value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../value-objects/preview-limits.js';
import { PreviewOperationFailure } from '../../value-objects/preview-operation-failure.js';
import { PreviewOperationResult } from '../../value-objects/preview-operation-result.js';
import { PreviewPort } from '../../value-objects/preview-port.js';
import { PreviewService } from '../../value-objects/preview-service.js';
import { PreviewOperation } from '../preview-operation.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OTHER = '11111111-2222-4333-8444-555555555555';
const T0 = new Date('2026-11-24T10:00:00.000Z');
const T1 = new Date('2026-11-24T10:00:15.000Z');
const T2 = new Date('2026-11-24T10:01:00.000Z');

const LIMITS = PreviewLimits.of({
  memoryMiB: 1024,
  cpuPercent: 100,
  tasksMax: 512,
  buildMinutes: 20,
});

function build(): PreviewOperation {
  return PreviewOperation.requestBuild({
    id: ID,
    projectId: PROJECT,
    commit: PreviewCommit.of('a'.repeat(40)),
    composeFile: PreviewComposeFile.of('compose.yaml'),
    service: PreviewService.of('web'),
    port: PreviewPort.of(3000),
    limits: LIMITS,
    now: T0,
  });
}

describe('PreviewOperation', () => {
  it('starts a build as requested, with what it was asked to build and nothing claimed', () => {
    const operation = build();

    expect(operation).toMatchObject({
      id: ID,
      projectId: PROJECT,
      kind: 'build',
      status: 'requested',
      claimedBy: null,
      heartbeatAt: null,
      finishedAt: null,
      failure: null,
      result: null,
      environmentFile: null,
    });
    expect(operation.build).toEqual({
      commit: 'a'.repeat(40),
      composeFile: 'compose.yaml',
      service: 'web',
      port: 3000,
      limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
    });
  });

  it.each(['stop', 'remove_data', 'state'] as const)('starts %s with no build data', (kind) => {
    const operation = PreviewOperation.requestOther({ id: ID, projectId: PROJECT, kind, now: T0 });

    expect(operation).toMatchObject({ kind, status: 'requested', build: null });
  });

  it('is claimed by one controller, which holds it from then on', () => {
    const operation = build();
    operation.claim(CONTROLLER, T1);

    expect(operation).toMatchObject({
      status: 'claimed',
      claimedBy: CONTROLLER,
      claimedAt: T1,
      heartbeatAt: T1,
    });
    expect(() => operation.assertHeldBy(CONTROLLER)).not.toThrow();
    expect(() => operation.assertHeldBy(OTHER)).toThrow(PreviewOperationNotHeldError);
  });

  it('is claimed only while requested', () => {
    const operation = build();
    operation.claim(CONTROLLER, T1);

    expect(() => operation.claim(OTHER, T2)).toThrow(IllegalPreviewOperationTransitionError);
  });

  it('is held by nobody before the claim', () => {
    expect(() => build().assertHeldBy(CONTROLLER)).toThrow(PreviewOperationNotHeldError);
  });

  it('renews the lease on progress, for its holder only', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);

    operation.reportProgress(CONTROLLER, T1);
    expect(operation.heartbeatAt).toEqual(T1);
    expect(() => operation.reportProgress(OTHER, T2)).toThrow(PreviewOperationNotHeldError);
    expect(operation.heartbeatAt).toEqual(T1);
  });

  it('records and drops the Environment file snapshot of a held build', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);

    operation.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId: OTHER });
    expect(operation.environmentFile).toEqual({ path: '.env', secretId: OTHER });
    operation.succeed(CONTROLLER, null, T1);
    expect(operation.environmentFile).toBeNull();
  });

  it('holds an Environment file only for a build', () => {
    const operation = PreviewOperation.requestOther({
      id: ID,
      projectId: PROJECT,
      kind: 'state',
      now: T0,
    });
    operation.claim(CONTROLLER, T0);

    expect(() =>
      operation.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId: OTHER }),
    ).toThrow(IllegalPreviewOperationTransitionError);
  });

  it('succeeds with what is running, ends the lease and keeps who held it', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);

    operation.succeed(
      CONTROLLER,
      PreviewOperationResult.of([{ name: 'web', state: 'running' }]),
      T1,
    );

    expect(operation).toMatchObject({
      status: 'succeeded',
      claimedBy: CONTROLLER,
      heartbeatAt: null,
      finishedAt: T1,
    });
    expect(operation.result?.services).toEqual([{ name: 'web', state: 'running' }]);
  });

  it('fails with the reported failure, for its holder only', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);
    const failure = PreviewOperationFailure.of('build_failed', 'exit 1');

    expect(() => operation.fail(OTHER, failure, T1)).toThrow(PreviewOperationNotHeldError);
    operation.fail(CONTROLLER, failure, T1);

    expect(operation).toMatchObject({ status: 'failed', finishedAt: T1, heartbeatAt: null });
    expect(operation.failure?.toData()).toEqual({
      code: 'build_failed',
      detail: 'exit 1',
      refusals: [],
    });
  });

  it('marks a failed build that removed the Preview', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);
    operation.fail(CONTROLLER, PreviewOperationFailure.of('start_failed', 'x'), T1, true);

    expect(operation.previewRemoved).toBe(true);
  });

  it('records previewRemoved false unless a failed build says so', () => {
    const plain = build();
    plain.claim(CONTROLLER, T0);
    plain.fail(CONTROLLER, PreviewOperationFailure.of('build_failed', 'x'), T1);
    expect(plain.previewRemoved).toBe(false);

    const stop = PreviewOperation.requestOther({
      id: ID,
      projectId: PROJECT,
      kind: 'stop',
      now: T0,
    });
    stop.claim(CONTROLLER, T0);
    stop.fail(CONTROLLER, PreviewOperationFailure.of('controller_error', 'x'), T1, true);
    expect(stop.previewRemoved).toBe(false);

    const succeeded = build();
    expect(succeeded.previewRemoved).toBe(false);
  });

  it('fails an overdue claimed build and an unclaimed requested one, each only in its status', () => {
    const overdue = build();
    expect(() =>
      overdue.failOverdue(PreviewOperationFailure.of('report_overdue', 'x'), T2),
    ).toThrow(IllegalPreviewOperationTransitionError);
    overdue.claim(CONTROLLER, T0);
    overdue.failOverdue(PreviewOperationFailure.of('report_overdue', 'x'), T2);
    expect(overdue).toMatchObject({ status: 'failed', finishedAt: T2 });

    const unclaimed = build();
    unclaimed.failUnclaimed(PreviewOperationFailure.of('not_claimed', 'x'), T2);
    expect(unclaimed).toMatchObject({ status: 'failed', claimedBy: null, finishedAt: T2 });
    expect(() => overdue.failUnclaimed(PreviewOperationFailure.of('not_claimed', 'x'), T2)).toThrow(
      IllegalPreviewOperationTransitionError,
    );
  });

  it('refuses every change once final', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);
    operation.succeed(CONTROLLER, null, T1);

    expect(() => operation.reportProgress(CONTROLLER, T2)).toThrow(PreviewOperationNotHeldError);
    expect(() => operation.succeed(CONTROLLER, null, T2)).toThrow(PreviewOperationNotHeldError);
    expect(() =>
      operation.fail(CONTROLLER, PreviewOperationFailure.of('build_failed', 'x'), T2),
    ).toThrow(PreviewOperationNotHeldError);
  });

  it('is lost with controller_lost when the lease runs out, only while claimed', () => {
    const operation = build();
    expect(() =>
      operation.loseController(PreviewOperationFailure.of('controller_lost', 'x'), T2),
    ).toThrow(IllegalPreviewOperationTransitionError);

    operation.claim(CONTROLLER, T0);
    operation.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId: OTHER });
    operation.loseController(PreviewOperationFailure.of('controller_lost', 'x'), T2);

    expect(operation).toMatchObject({ status: 'failed', finishedAt: T2, environmentFile: null });
    expect(operation.failure?.code).toBe('controller_lost');
    expect(() => operation.assertHeldBy(CONTROLLER)).toThrow(PreviewOperationNotHeldError);
  });

  it('is restored from what it holds', () => {
    const operation = build();
    operation.claim(CONTROLLER, T0);

    const restored = PreviewOperation.restore(operation.toData());

    expect(restored.toData()).toEqual(operation.toData());
    expect(() => restored.assertHeldBy(CONTROLLER)).not.toThrow();
  });
});
