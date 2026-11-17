import { Inject, Injectable } from '@nestjs/common';
import {
  ENVIRONMENT_FILE_SNAPSHOTS,
  type EnvironmentFileSnapshots,
} from '../../ports/environment-file-snapshots.js';

export type ReleaseFinalSnapshotsResult = void;

/**
 * Command (Issue #104): releases the Environment file snapshots of Runs that ended any way.
 * Run on the sweep interval; never throws.
 */
@Injectable()
export class ReleaseFinalSnapshotsHandler {
  constructor(
    @Inject(ENVIRONMENT_FILE_SNAPSHOTS) private readonly snapshots: EnvironmentFileSnapshots,
  ) {}

  execute(): Promise<ReleaseFinalSnapshotsResult> {
    return this.snapshots.releaseFinal();
  }
}
