import {
  PreviewBuildRunningError,
  PreviewBusyError,
} from '../../errors/preview-settings-errors.js';
import { PreviewOperation } from '../../entities/preview-operation.js';
import type { OverdueBuildRule } from '../../value-objects/overdue-build-rule.js';
import { PreviewRunningRule } from '../../value-objects/preview-running-rule.js';
import type { UnclaimedOperationRule } from '../../value-objects/unclaimed-operation-rule.js';
import { PreviewOperationHandOutRule } from '../../value-objects/preview-operation-hand-out-rule.js';
import type { LostControllerRule } from '../../value-objects/lost-controller-rule.js';
import { PreviewRunningLimitRule } from '../../value-objects/preview-running-limit-rule.js';
import { StateCheckRule } from '../../value-objects/state-check-rule.js';
import type {
  PreviewDisconnectReadModel,
  PreviewOccupation,
  PreviewReadModel,
  PreviewOperationRepository,
  PreviewRequestFacts,
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
    if (operation.kind === 'stop' || operation.kind === 'remove_data') {
      for (const other of this.operations.values()) {
        if (
          (other.kind === 'stop' || other.kind === 'remove_data') &&
          other.projectId === operation.projectId &&
          (other.status === 'requested' || other.status === 'claimed')
        ) {
          return Promise.reject(new PreviewBusyError());
        }
      }
    }
    this.operations.set(operation.id, PreviewOperation.restore(operation.toData()));
    return Promise.resolve();
  }

  async request(
    projectId: string,
    decide: (facts: PreviewRequestFacts) => PreviewOperation[],
  ): Promise<PreviewOperation[]> {
    const operations = decide({
      preview: await this.findPreviewFacts(projectId),
      occupying: await this.findOccupyingProjects(),
    });
    const before = new Map(this.operations);
    try {
      for (const operation of operations) await this.add(operation);
    } catch (error) {
      this.operations.clear();
      for (const [id, stored] of before) this.operations.set(id, stored);
      throw error;
    }
    return operations;
  }

  async findOccupyingProjects(): Promise<PreviewOccupation[]> {
    const rule = PreviewRunningLimitRule.create();
    const found: PreviewOccupation[] = [];
    for (const projectId of [...new Set([...this.operations.values()].map((op) => op.projectId))]) {
      const facts = await this.findPreviewFacts(projectId);
      const state = rule.state({
        runningChange: facts.runningChange,
        buildActive:
          facts.latestBuild !== null &&
          (facts.latestBuild.status === 'requested' || facts.latestBuild.status === 'claimed'),
      });
      if (state !== null) found.push({ projectId, state });
    }
    return found.sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
  }

  findStateCheckProjects(): Promise<string[]> {
    const rule = StateCheckRule.create();
    const newest = new Map<string, PreviewOperation>();
    for (const operation of this.operations.values()) {
      const held = newest.get(operation.projectId);
      if (
        !held ||
        operation.requestedAt > held.requestedAt ||
        (operation.requestedAt.getTime() === held.requestedAt.getTime() && operation.id > held.id)
      ) {
        newest.set(operation.projectId, operation);
      }
    }
    return Promise.resolve(
      [...newest.values()]
        .filter((operation) =>
          rule.selects({
            kind: operation.kind,
            status: operation.status,
            claimedAt: operation.claimedAt,
            failureCode: operation.failure?.code ?? null,
          }),
        )
        .map((operation) => operation.projectId)
        .sort(),
    );
  }

  findDisconnectFacts(projectId: string): Promise<PreviewDisconnectReadModel> {
    const own = [...this.operations.values()].filter((op) => op.projectId === projectId);
    const active = own.filter((op) => op.status === 'requested' || op.status === 'claimed');
    const newest = [...own].sort(
      (a, b) =>
        b.requestedAt.getTime() - a.requestedAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )[0];
    return Promise.resolve({
      operations: own.length,
      buildEverClaimed: own.some((op) => op.kind === 'build' && op.claimedAt !== null),
      newest: newest ? { kind: newest.kind, status: newest.status } : null,
      activeOperations: active.length,
      removalActive: active.some((op) => op.kind === 'remove_data'),
    });
  }

  async deleteForDisconnect(
    projectId: string,
    mayDelete: (facts: PreviewDisconnectReadModel) => boolean,
  ): Promise<boolean> {
    if (!mayDelete(await this.findDisconnectFacts(projectId))) return false;
    for (const [id, operation] of this.operations) {
      if (operation.projectId === projectId) this.operations.delete(id);
    }
    return true;
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
    const latestChange =
      own
        .filter((op) => op.kind === 'stop' || op.kind === 'remove_data')
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || byId(b.id, a.id))[0] ??
      null;
    return Promise.resolve({
      latestBuild: latestBuild && PreviewOperation.restore(latestBuild.toData()),
      runningChange: runningChange && PreviewOperation.restore(runningChange.toData()),
      latestChange: latestChange && PreviewOperation.restore(latestChange.toData()),
    });
  }

  findMergeBuild(
    projectId: string,
    runId: string,
    commit: string,
  ): Promise<PreviewOperation | null> {
    const newest = [...this.operations.values()]
      .filter(
        (op) =>
          op.projectId === projectId &&
          op.build !== null &&
          (op.build.startedByRunId === runId || op.build.commit === commit),
      )
      .sort(
        (a, b) =>
          b.requestedAt.getTime() - a.requestedAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )[0];
    return Promise.resolve(newest ? PreviewOperation.restore(newest.toData()) : null);
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
