import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { PreviewMergeRebuild } from '../../domain/entities/preview-merge-rebuild.js';
import type { PreviewMergeRebuildRepository } from '../../domain/repositories/preview-merge-rebuild-repository.js';

/** PostgreSQL adapter of {@link PreviewMergeRebuildRepository}: the `preview_merge_rebuilds` table. */
@Injectable()
export class PrismaPreviewMergeRebuildRepository implements PreviewMergeRebuildRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async find(projectId: string): Promise<PreviewMergeRebuild | null> {
    const row = await this.db.previewMergeRebuild.findUnique({ where: { projectId } });
    return row === null ? null : toRebuild(row);
  }

  async list(): Promise<PreviewMergeRebuild[]> {
    const rows = await this.db.previewMergeRebuild.findMany({
      orderBy: [{ recordedAt: 'asc' }, { projectId: 'asc' }],
    });
    return rows.map(toRebuild);
  }

  async save(rebuild: PreviewMergeRebuild): Promise<void> {
    const data = rebuild.toData();
    const fields = {
      runId: data.runId,
      mergedCommit: data.mergedCommit,
      mergedAt: data.mergedAt,
      fetchStartedAt: data.fetchStartedAt,
      recordedAt: data.recordedAt,
      failure: data.failure,
      failedAt: data.failedAt,
    };
    await this.db.previewMergeRebuild.upsert({
      where: { projectId: data.projectId },
      create: { projectId: data.projectId, ...fields },
      update: fields,
    });
  }

  async saveFailure(rebuild: PreviewMergeRebuild): Promise<boolean> {
    const data = rebuild.toData();
    const { count } = await this.db.previewMergeRebuild.updateMany({
      where: {
        projectId: data.projectId,
        runId: data.runId,
        recordedAt: data.recordedAt,
      },
      data: { failure: data.failure, failedAt: data.failedAt },
    });
    return count > 0;
  }

  async delete(rebuild: PreviewMergeRebuild): Promise<void> {
    await this.db.previewMergeRebuild.deleteMany({
      where: {
        projectId: rebuild.projectId,
        runId: rebuild.runId,
        recordedAt: rebuild.recordedAt,
      },
    });
  }

  async deleteForProject(projectId: string): Promise<void> {
    await this.db.previewMergeRebuild.deleteMany({ where: { projectId } });
  }
}

function toRebuild(row: {
  projectId: string;
  runId: string;
  mergedCommit: string;
  mergedAt: Date;
  fetchStartedAt: Date;
  recordedAt: Date;
  failure: string | null;
  failedAt: Date | null;
}): PreviewMergeRebuild {
  return PreviewMergeRebuild.restore({
    projectId: row.projectId,
    runId: row.runId,
    mergedCommit: row.mergedCommit,
    mergedAt: row.mergedAt,
    fetchStartedAt: row.fetchStartedAt,
    recordedAt: row.recordedAt,
    failure: row.failure,
    failedAt: row.failedAt,
  });
}
