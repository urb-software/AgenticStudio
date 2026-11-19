import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { EnvironmentFile } from '../../domain/entities/environment-file.js';
import type { EnvironmentFileRepository } from '../../domain/repositories/environment-file-repository.js';

/**
 * PostgreSQL adapter of {@link EnvironmentFileRepository}: its own `environment_files` table,
 * so disconnecting the Repository leaves the row in place.
 */
@Injectable()
export class PrismaEnvironmentFileRepository implements EnvironmentFileRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async find(projectId: string): Promise<EnvironmentFile | null> {
    const row = await this.db.environmentFile.findUnique({ where: { projectId } });
    return row
      ? EnvironmentFile.restore({
          projectId: row.projectId,
          path: row.path,
          sizeBytes: row.sizeBytes,
          updatedAt: row.updatedAt,
          secretRef: row.secretId,
        })
      : null;
  }

  async save(
    file: EnvironmentFile,
  ): Promise<{ saved: EnvironmentFile; replacedSecretRef: string | null }> {
    // The old row is locked before it is read and replaced, so two concurrent replacements each
    // return the reference the other one replaced, never the same one twice. (Two concurrent
    // first saves can leave one content unreferenced; the orphan sweep deletes it.)
    return this.db.$transaction(async (tx) => {
      const old = await tx.$queryRaw<{ secret_id: string }[]>`
        SELECT secret_id::text AS secret_id FROM environment_files
        WHERE project_id = ${file.projectId}::uuid FOR UPDATE`;
      const [row] = await tx.$queryRaw<{ path: string; size_bytes: number; updated_at: Date }[]>`
        INSERT INTO environment_files (project_id, path, size_bytes, secret_id, updated_at)
        VALUES (${file.projectId}::uuid, ${file.path}, ${file.sizeBytes},
                ${file.secretRef}::uuid, now())
        ON CONFLICT (project_id) DO UPDATE SET
          path = EXCLUDED.path,
          size_bytes = EXCLUDED.size_bytes,
          secret_id = EXCLUDED.secret_id,
          updated_at = EXCLUDED.updated_at
        RETURNING path, size_bytes, updated_at`;
      return {
        saved: EnvironmentFile.restore({
          projectId: file.projectId,
          path: row!.path,
          sizeBytes: row!.size_bytes,
          updatedAt: row!.updated_at,
          secretRef: file.secretRef,
        }),
        replacedSecretRef: old[0]?.secret_id ?? null,
      };
    });
  }

  async delete(projectId: string): Promise<string | null> {
    const rows = await this.db.$queryRaw<{ secret_id: string }[]>`
      DELETE FROM environment_files WHERE project_id = ${projectId}::uuid
      RETURNING secret_id::text AS secret_id`;
    return rows[0]?.secret_id ?? null;
  }

  async listSecretRefs(): Promise<string[]> {
    const rows = await this.db.environmentFile.findMany({ select: { secretId: true } });
    return rows.map((row) => row.secretId);
  }
}
