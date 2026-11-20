import { describe, expect, it, vi } from 'vitest';
import type { GetRunEnvironmentFileHandler } from '../../../application/features/get-run-environment-file/handler.js';
import type { GetRunStartPointHandler } from '../../../application/features/get-run-start-point/handler.js';
import { ProjectRunEnvironmentFiles } from '../run-environment-files.js';
import { ProjectRunStartPoints } from '../run-start-points.js';

describe('the contracts adapters of projects', () => {
  it('ProjectRunStartPoints maps forProject to the handler and returns its answer', async () => {
    const answer = { status: 'no_repository' } as const;
    const execute = vi.fn().mockResolvedValue(answer);
    const adapter = new ProjectRunStartPoints({ execute } as unknown as GetRunStartPointHandler);

    await expect(adapter.forProject('p-1')).resolves.toBe(answer);
    expect(execute).toHaveBeenCalledWith({ projectId: 'p-1' });
  });

  it('ProjectRunEnvironmentFiles maps forProject to the handler and returns its answer', async () => {
    const execute = vi.fn().mockResolvedValue({ path: '.env', content: 'A=1' });
    const adapter = new ProjectRunEnvironmentFiles({
      execute,
    } as unknown as GetRunEnvironmentFileHandler);

    await expect(adapter.forProject('p-1')).resolves.toEqual({ path: '.env', content: 'A=1' });
    expect(execute).toHaveBeenCalledWith({ projectId: 'p-1' });
  });
});
