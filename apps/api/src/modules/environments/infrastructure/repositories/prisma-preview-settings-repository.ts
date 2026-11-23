import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { PreviewSettings } from '../../domain/entities/preview-settings.js';
import type { PreviewSettingsRepository } from '../../domain/repositories/preview-settings-repository.js';

/** PostgreSQL adapter of {@link PreviewSettingsRepository}: the `preview_settings` table. */
@Injectable()
export class PrismaPreviewSettingsRepository implements PreviewSettingsRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async find(projectId: string): Promise<PreviewSettings | null> {
    const row = await this.db.previewSettings.findUnique({ where: { projectId } });
    return row
      ? PreviewSettings.restore({
          projectId: row.projectId,
          composeFile: row.composeFile,
          service: row.service,
          port: row.port,
          updatedAt: row.updatedAt,
        })
      : null;
  }

  async save(settings: PreviewSettings): Promise<PreviewSettings> {
    const [row] = await this.db.$queryRaw<
      { compose_file: string; service: string; port: number; updated_at: Date }[]
    >`
      INSERT INTO preview_settings (project_id, compose_file, service, port, updated_at)
      VALUES (${settings.projectId}::uuid, ${settings.composeFile}, ${settings.service},
              ${settings.port}, now())
      ON CONFLICT (project_id) DO UPDATE SET
        compose_file = EXCLUDED.compose_file,
        service = EXCLUDED.service,
        port = EXCLUDED.port,
        updated_at = EXCLUDED.updated_at
      RETURNING compose_file, service, port, updated_at`;
    return PreviewSettings.restore({
      projectId: settings.projectId,
      composeFile: row!.compose_file,
      service: row!.service,
      port: row!.port,
      updatedAt: row!.updated_at,
    });
  }

  async delete(projectId: string): Promise<void> {
    await this.db.previewSettings.deleteMany({ where: { projectId } });
  }
}
