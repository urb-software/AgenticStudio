import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const bytes = z.int().min(0);

/**
 * The disk the agent worker keeps Working copies and caches on (Issue #143), as it last
 * measured it (at most every ten minutes): bytes of data in the Working copies and the
 * per-Project caches, how many Runs it keeps, the free and total space, and the free space
 * below which it prepares no new Run.
 */
export const agentWorkerDiskSchema = z
  .object({
    workingCopiesBytes: bytes,
    cachesBytes: bytes,
    keptRuns: z.int().min(0),
    freeBytes: bytes,
    totalBytes: bytes,
    minFreeBytes: bytes,
    /** Free space is below `minFreeBytes`: no new Run is prepared until space is freed. */
    low: z.boolean(),
    /** Some files could not be read while measuring: the byte figures are lower bounds. */
    partial: z.literal(true).optional(),
  })
  .meta({ id: 'AgentWorkerDisk' });

/**
 * What Studio knows of the agent side (Issue #143), from the worker's latest status report:
 * whether a worker is connected and, when it is and has measured its disk, the disk figures.
 */
export const agentWorkerResponseSchema = z
  .object({
    connected: z.boolean(),
    disk: agentWorkerDiskSchema.optional(),
  })
  .meta({ id: 'AgentWorker' });

export class AgentWorkerResponseDto extends createZodDto(agentWorkerResponseSchema) {}
