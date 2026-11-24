import { PreviewOperation } from '../../entities/preview-operation.js';
import { PreviewOperationHandOutRule } from '../../value-objects/preview-operation-hand-out-rule.js';
import type { LostControllerRule } from '../../value-objects/lost-controller-rule.js';
import type { PreviewOperationRepository } from '../preview-operation-repository.js';

/** The repository in memory: the rules of the domain are the whole behaviour. */
export class InMemoryPreviewOperationRepository implements PreviewOperationRepository {
  readonly operations = new Map<string, PreviewOperation>();
  /** The lease the hand-out rule uses, in seconds. */
  leaseSeconds = 60;

  add(operation: PreviewOperation): Promise<void> {
    this.operations.set(operation.id, PreviewOperation.restore(operation.toData()));
    return Promise.resolve();
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
