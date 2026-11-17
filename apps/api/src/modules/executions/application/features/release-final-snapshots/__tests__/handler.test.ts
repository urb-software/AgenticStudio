import { describe, expect, it } from 'vitest';
import type { EnvironmentFileSnapshots } from '../../../ports/environment-file-snapshots.js';
import { ReleaseFinalSnapshotsHandler } from '../handler.js';

describe('ReleaseFinalSnapshotsHandler (Issue #104)', () => {
  it('releases the snapshots of Runs that ended, once per call', async () => {
    let released = 0;
    const snapshots = {
      releaseFor: () => Promise.resolve(),
      releaseFinal: () => {
        released++;
        return Promise.resolve();
      },
    } as EnvironmentFileSnapshots;
    const handler = new ReleaseFinalSnapshotsHandler(snapshots);

    await handler.execute();
    await handler.execute();

    expect(released).toBe(2);
  });
});
