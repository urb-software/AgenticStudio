import { EnvironmentFile } from '../../entities/environment-file.js';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import type { EnvironmentFileRepository } from '../environment-file-repository.js';

export class InMemoryEnvironmentFileRepository implements EnvironmentFileRepository {
  readonly files = new Map<string, RestoreData<typeof EnvironmentFile>>();
  now = new Date('2026-11-15T10:00:00.000Z');

  find(projectId: string): Promise<EnvironmentFile | null> {
    const file = this.files.get(projectId);
    return Promise.resolve(file ? EnvironmentFile.restore({ ...file }) : null);
  }

  save(projectId: string, record: { path: string; sizeBytes: number; secretRef: string }) {
    const replacedSecretRef = this.files.get(projectId)?.secretRef ?? null;
    const stored = { ...record, projectId, updatedAt: this.now };
    this.files.set(projectId, stored);
    return Promise.resolve({ saved: EnvironmentFile.restore(stored), replacedSecretRef });
  }

  delete(projectId: string): Promise<string | null> {
    const secretRef = this.files.get(projectId)?.secretRef ?? null;
    this.files.delete(projectId);
    return Promise.resolve(secretRef);
  }

  listSecretRefs(): Promise<string[]> {
    return Promise.resolve([...this.files.values()].map((file) => file.secretRef));
  }
}
