import {
  IllegalPreviewOperationTransitionError,
  PreviewOperationNotHeldError,
} from '../errors/preview-operation-errors.js';
import { PreviewOperationFailure } from '../value-objects/preview-operation-failure.js';
import type { PreviewOperationKind } from '../value-objects/preview-operation-kind.js';
import { PreviewOperationResult } from '../value-objects/preview-operation-result.js';
import type { PreviewOperationStatus } from '../value-objects/preview-operation-status.js';
import type { PreviewOperationData } from './preview-operation-data.js';
import type {
  PreviewBuildRequestFacts,
  PreviewOtherRequestFacts,
} from './preview-operation-request-facts.js';

/**
 * One piece of work for the environment controller on a Project's Preview: requested, claimed by
 * one controller process, then succeeded or failed. Only the holder may change a claimed operation.
 */
export class PreviewOperation {
  readonly id: string;
  readonly projectId: string;
  readonly kind: PreviewOperationKind;
  readonly requestedAt: Date;
  private current: PreviewOperationData;

  private constructor(data: PreviewOperationData) {
    this.id = data.id;
    this.projectId = data.projectId;
    this.kind = data.kind;
    this.requestedAt = data.requestedAt;
    this.current = data;
  }

  /** A build of the commit with the settings and limits given; nothing runs until a controller claims it. */
  static requestBuild(facts: PreviewBuildRequestFacts): PreviewOperation {
    return new PreviewOperation({
      id: facts.id,
      projectId: facts.projectId,
      kind: 'build',
      status: 'requested',
      build: {
        commit: facts.commit.value,
        composeFile: facts.composeFile.value,
        service: facts.service.value,
        port: facts.port.value,
        limits: facts.limits.toData(),
      },
      requestedAt: facts.now,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      failure: null,
      previewRemoved: false,
      result: null,
      environmentFile: null,
      log: { bytes: 0, truncated: false },
    });
  }

  static requestOther(facts: PreviewOtherRequestFacts): PreviewOperation {
    return new PreviewOperation({
      id: facts.id,
      projectId: facts.projectId,
      kind: facts.kind,
      status: 'requested',
      build: null,
      requestedAt: facts.now,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      failure: null,
      previewRemoved: false,
      result: null,
      environmentFile: null,
      log: { bytes: 0, truncated: false },
    });
  }

  static restore(data: PreviewOperationData): PreviewOperation {
    return new PreviewOperation(data);
  }

  get status(): PreviewOperationStatus {
    return this.current.status;
  }

  get claimedBy(): string | null {
    return this.current.claimedBy;
  }

  get claimedAt(): Date | null {
    return this.current.claimedAt;
  }

  get heartbeatAt(): Date | null {
    return this.current.heartbeatAt;
  }

  get finishedAt(): Date | null {
    return this.current.finishedAt;
  }

  get build(): PreviewOperationData['build'] {
    return this.current.build;
  }

  get failure(): PreviewOperationFailure | null {
    return this.current.failure === null
      ? null
      : PreviewOperationFailure.restore(this.current.failure);
  }

  get previewRemoved(): boolean {
    return this.current.previewRemoved;
  }

  get log(): PreviewOperationData['log'] {
    return this.current.log;
  }

  get result(): PreviewOperationResult | null {
    return this.current.result === null
      ? null
      : PreviewOperationResult.restore(this.current.result);
  }

  get environmentFile(): PreviewOperationData['environmentFile'] {
    return this.current.environmentFile;
  }

  /** The operation as storage holds it; only the repository's implementation reads it. */
  toData(): PreviewOperationData {
    return this.current;
  }

  /** Hands the operation to the controller; only a requested operation can be claimed. */
  claim(controllerId: string, now: Date): void {
    if (this.current.status !== 'requested') {
      throw new IllegalPreviewOperationTransitionError(
        'Only a requested Preview operation can be claimed.',
      );
    }
    this.current = {
      ...this.current,
      status: 'claimed',
      claimedBy: controllerId,
      claimedAt: now,
      heartbeatAt: now,
    };
  }

  /** Throws {@link PreviewOperationNotHeldError} unless the controller holds the operation now. */
  assertHeldBy(controllerId: string): void {
    if (this.current.status !== 'claimed' || this.current.claimedBy !== controllerId) {
      throw new PreviewOperationNotHeldError();
    }
  }

  /** Records the Environment file snapshot of the claimed build, or none. */
  recordEnvironmentFile(
    controllerId: string,
    file: { path: string; secretId: string } | null,
  ): void {
    this.assertHeldBy(controllerId);
    if (this.current.build === null) {
      throw new IllegalPreviewOperationTransitionError('Only a build holds an Environment file.');
    }
    this.current = { ...this.current, environmentFile: file };
  }

  reportProgress(controllerId: string, now: Date): void {
    this.assertHeldBy(controllerId);
    this.current = { ...this.current, heartbeatAt: now };
  }

  succeed(controllerId: string, result: PreviewOperationResult | null, now: Date): void {
    this.assertHeldBy(controllerId);
    this.current = {
      ...this.current,
      status: 'succeeded',
      heartbeatAt: null,
      finishedAt: now,
      result: result === null ? null : result.toData(),
      environmentFile: null,
    };
  }

  /** `previewRemoved` counts for a build only: no other operation removes a Preview by failing. */
  fail(
    controllerId: string,
    failure: PreviewOperationFailure,
    now: Date,
    previewRemoved = false,
  ): void {
    this.assertHeldBy(controllerId);
    this.finishAsFailed(failure, now, previewRemoved && this.current.kind === 'build');
  }

  /** The lease ran out: the API fails the claimed operation of a controller that stopped reporting. */
  loseController(failure: PreviewOperationFailure, now: Date): void {
    if (this.current.status !== 'claimed') {
      throw new IllegalPreviewOperationTransitionError(
        'Only a claimed Preview operation can be lost.',
      );
    }
    this.finishAsFailed(failure, now);
  }

  /** The build ran past its time limit and margin without an end report. */
  failOverdue(failure: PreviewOperationFailure, now: Date): void {
    if (this.current.status !== 'claimed') {
      throw new IllegalPreviewOperationTransitionError(
        'Only a claimed Preview operation can be overdue.',
      );
    }
    this.finishAsFailed(failure, now);
  }

  /** No controller claimed the operation in time. */
  failUnclaimed(failure: PreviewOperationFailure, now: Date): void {
    if (this.current.status !== 'requested') {
      throw new IllegalPreviewOperationTransitionError(
        'Only a requested Preview operation can be unclaimed.',
      );
    }
    this.finishAsFailed(failure, now);
  }

  private finishAsFailed(
    failure: PreviewOperationFailure,
    now: Date,
    previewRemoved = false,
  ): void {
    this.current = {
      ...this.current,
      previewRemoved,
      status: 'failed',
      heartbeatAt: null,
      finishedAt: now,
      failure: failure.toData(),
      environmentFile: null,
    };
  }
}
