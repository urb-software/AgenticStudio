import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const bytes = z.int().min(0);

export const agentWorkerDiskSchema = z
  .object({
    workingCopiesBytes: bytes,
    cachesBytes: bytes,
    keptRuns: z.int().min(0),
    freeBytes: bytes,
    totalBytes: bytes,
    minFreeBytes: bytes,
    low: z.boolean(),
    partial: z.literal(true).optional(),
  })
  .meta({ id: 'AgentWorkerDisk' });

export const agentWorkerResponseSchema = z
  .object({
    connected: z.boolean(),
    disk: agentWorkerDiskSchema.optional(),
  })
  .meta({ id: 'AgentWorker' });

export class AgentWorkerResponseDto extends createZodDto(agentWorkerResponseSchema) {}
