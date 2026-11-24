import { PreviewBuildRunningError } from '../../errors/preview-settings-errors.js';
import { PreviewOperation } from '../../entities/preview-operation.js';
import type { OverdueBuildRule } from '../../value-objects/overdue-build-rule.js';
import { PreviewRunningRule } from '../../value-objects/preview-running-rule.js';
import type { UnclaimedOperationRule } from '../../value-objects/unclaimed-operation-rule.js';
import { PreviewOperationHandOutRule } from '../../value-objects/preview-operation-hand-out-rule.js';
import type { LostControllerRule } from '../../value-objects/lost-controller-rule.js';
import type {
  PreviewReadModel,
  PreviewOperationRepository,
} from '../preview-operation-repository.js';

/** The repository in memory: the rules of the domain are the whole behaviour. */
export class InMemoryPreviewOperationRepository implements PreviewOperationRepository {
  readonly operations = new Map<string, PreviewOperation>();
  /** The lease the hand-out rule uses, in seconds. */
  leaseSeconds = 60;

  add(operation: PreviewOperation): Promise<void> {
    if (operation.kind === 'build') {
      for (const other of this.operations.values()) {
        if (
          other.kind === 'build' &&
          other.projectId === operation.projectId &&
          (other.status === 'requested' || other.status === 'claimed')
        ) {
          return Promise.reject(new PreviewBuildRunningError());
        }
      }
    }
    this.operations.set(operation.id, PreviewOperation.restore(operation.toData()));
    return Promise.resolve();
  }

  findPreviewFacts(projectId: string): Promise<PreviewReadModel> {
    const own = [...this.operations.values()].filter((op) => op.projectId === projectId);
    const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const latestBuild =
      own
        .filter((op) => op.kind === 'build')
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || byId(b.id, a.id))[0] ??
      null;
    const runningChange =
      own
        .filter((op) =>
          PreviewRunningRule.create().changesRunning({
            kind: op.kind,
            status: op.status,
            previewRemoved: op.previewRemoved,
          }),
        )
        .sort(
          (a, b) =>
            (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0) || byId(b.id, a.id),
        )[0] ?? null;
    return Promise.resolve({
      latestBuild: latestBuild && PreviewOperation.restore(latestBuild.toData()),
      runningChange: runningChange && PreviewOperation.restore(runningChange.toData()),
    });
  }

  find(id: string): Promise<PreviewOperation | null> {
    const found = this.operations.get(id);
    return Promise.resolve(found ? PreviewOperation.restore(found.toData()) : null);
  }

  async change(
    id: string,
    mutate: (operation: PreviewOperation) => void,
  ): Promise<PreviewOperation | null> {
    const stored = this.operations.get(id);
    if (!stored) return null;
    const working = PreviewOperation.restore(stored.toData());
    mutate(working);
    this.operations.set(id, working);
    return PreviewOperation.restore(working.toData());
  }

  failLost(rule: LostControllerRule, now: Date): Promise<string[]> {
    const released: string[] = [];
    for (const operation of this.operations.values()) {
      if (!rule.selects(operation)) continue;
      const secretId = operation.environmentFile?.secretId;
      operation.loseController(rule.failure, now);
      if (secretId !== undefined) released.push(secretId);
    }
    return Promise.resolve(released);
  }

  failOverdue(rule: OverdueBuildRule, now: Date): Promise<string[]> {
    const released: string[] = [];
    for (const operation of this.operations.values()) {
      if (
        !rule.selects({
          status: operation.status,
          kind: operation.kind,
          claimedAt: operation.claimedAt,
          buildMinutes: operation.build?.limits.buildMinutes ?? null,
        })
      ) {
        continue;
      }
      const secretId = operation.environmentFile?.secretId;
      operation.failOverdue(rule.failure, now);
      if (secretId !== undefined) released.push(secretId);
    }
    return Promise.resolve(released);
  }

  failUnclaimed(rule: UnclaimedOperationRule, now: Date): Promise<number> {
    let failed = 0;
    for (const operation of this.operations.values()) {
      if (!rule.selects(operation)) continue;
      operation.failUnclaimed(rule.failure, now);
      failed += 1;
    }
    return Promise.resolve(failed);
  }

  claimNext(controllerId: string, now: Date): Promise<PreviewOperation | null> {
    const rule = PreviewOperationHandOutRule.at(now, this.leaseSeconds);
    const next = rule.next([...this.operations.values()]);
    if (!next) return Promise.resolve(null);
    next.claim(controllerId, now);
    return Promise.resolve(PreviewOperation.restore(next.toData()));
  }

  findEnvironmentFileSecret(id: string): Promise<string | null> {
    return Promise.resolve(this.operations.get(id)?.environmentFile?.secretId ?? null);
  }

  listEnvironmentFileSecrets(): Promise<string[]> {
    return Promise.resolve(
      [...this.operations.values()].flatMap((operation) =>
        operation.environmentFile ? [operation.environmentFile.secretId] : [],
      ),
    );
  }
}
