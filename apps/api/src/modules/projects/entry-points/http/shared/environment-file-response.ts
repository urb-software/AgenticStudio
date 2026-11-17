import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A project's Environment file as the operator sees it (Issue #104 contract): whether one is
 * set, its path, size and last change, never its content. Shared by the set and get features
 * of this module. Closed: unknown keys are stripped, so no field can carry the content.
 */
export const environmentFileInfoSchema = z
  .object({
    path: z.string(),
    sizeBytes: z.int().min(0),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'EnvironmentFileInfo' });

export class EnvironmentFileInfoDto extends createZodDto(environmentFileInfoSchema) {}

export type EnvironmentFileInfoResponse = z.infer<typeof environmentFileInfoSchema>;

export function toEnvironmentFileInfoResponse(info: {
  path: string;
  sizeBytes: number;
  updatedAt: Date;
}): EnvironmentFileInfoResponse {
  return { path: info.path, sizeBytes: info.sizeBytes, updatedAt: info.updatedAt.toISOString() };
}
